import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import {
  AgentChatExecutionActivityPageSchema, ReadAgentChatResponseSchema, type AgentChatExecutionActivityQuery,
} from '@foreman-code/contracts/agent-chat'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { graphFixture, ownedGraph } from './eng04-graph-composition-fixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const at = '2026-01-01T00:00:00.000Z'
const claudeConfiguration: ClaudeHarnessConfiguration = {
  harness: 'claude', model: 'fixture-model', effort: 'medium', authMode: 'subscription',
  configDirectory: '/fixture/profile', permissionMode: 'default', sandbox: 'danger-full-access',
  tools: [], permissionRules: [], instructions: '', mcpServers: {},
}
type NativeRecord = { type: string; payload: Record<string, unknown> }
type ActivityRequest = Partial<Omit<AgentChatExecutionActivityQuery,
  'workflowId' | 'workflowNodeId' | 'agentId' | 'runId'>>

describe('Persisted execution activity through HTTP and authenticated MCP', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => { database = await currentDatabase() }, 60_000)
  afterAll(async () => { await database?.close() })

  async function setup(harness?: ClaudeHarnessConfiguration) {
    const graph = await graphFixture(database, { form: 'single', ...(harness ? { harness } : {}) })
    const node = agentWorkflowNode(graph.version.definition.nodes[0])
    const workflows = new PostgresWorkflowRepository(database.pool)
    const locations = new WorkspaceLocationService(database.pool, graph.commands)
    const runs = new PostgresRunRepository(database.pool, workflows, locations, {
      runtimeRoot: database.directory,
      ...createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify),
    })
    const candidate = HarnessExecutionSchema.parse({
      id: randomUUID(), runId: graph.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId],
      attempt: 1, state: 'queued', input: {}, createdAt: graph.run.createdAt,
    })
    const admitted = await ownedGraph(database, graph, owner =>
      runs.admitRepeatExecution({ nodeId: node.id, occurrence: null }, () => candidate, owner))
    if (admitted.kind !== 'admitted') throw new Error('Expected the fixture execution to be admitted')
    // Synthetic retained history exercises reads; this fixture does not claim a native launch or result.
    await database.pool.query(`update harness_executions set record=record || $2::jsonb where id=$1`,
      [candidate.id, JSON.stringify({ state: 'running', nativeSessionId: 'thread' })])
    const transfers: unknown[][] = []
    let queryFailure: string | undefined
    const observedPool = new Proxy(database.pool, {
      get(target, property) {
        if (property === 'query') return async (...args: unknown[]) => {
          try {
            const result = await Reflect.apply(target.query, target, args) as pg.QueryResult
            transfers.push(result.rows)
            return result
          } catch (error) {
            queryFailure = error instanceof Error ? error.message : String(error)
            throw error
          }
        }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const managers = vi.fn((): never => { throw new Error('Activity reads must not launch native sessions') })
    const chat = new AgentChatService(observedPool, new PostgresAgentChatRepository(database.pool),
      new PostgresOperatorConversationRepository(database.pool), workflows, runs, managers, database.directory)
    const reader = await graph.credential([{ actions: ['agent_chat:read'], scope: graph.grantScope }])
    const denied = await graph.credential([{ actions: ['agent_chat:read'], scope: { workspaceIds: ['other-workspace'] } }])
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: graph.access, services: { agentChat: chat, commands: graph.commands } as unknown as OperatorServices },
    })
    const clients: Client[] = []
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'execution-activity-reader', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const mcp = await connect(reader.token)
    const deniedMcp = await connect(denied.token)
    const query = { workflowId: graph.scope.workflowId, workflowNodeId: node.id,
      agentId: node.agentId, runId: graph.run.id }
    const url = `/api/workspaces/${graph.scope.workspaceId}/agent-chat/execution-activity`
    const httpResponse = (request: ActivityRequest = {}, token = reader.token) => app.inject({
      method: 'GET', url: `${url}?${new URLSearchParams({ ...query,
        ...Object.fromEntries(Object.entries(request).map(([key, value]) => [key, String(value)])),
      })}`, headers: { authorization: `Bearer ${token}` },
    })
    const http = async (request: ActivityRequest = {}) => {
      const response = await httpResponse(request)
      expect(response.statusCode, queryFailure ?? response.body).toBe(200)
      expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(256 * 1024)
      return AgentChatExecutionActivityPageSchema.parse(response.json())
    }
    const mcpArguments = (request: ActivityRequest = {}) => ({
      workspaceId: graph.scope.workspaceId, query, executionActivity: request,
    })
    const mcpPage = async (request: ActivityRequest = {}) => {
      const result = await mcp.callTool({ name: 'agent_chat_read', arguments: mcpArguments(request) })
      expect(result.isError).not.toBe(true)
      const page = ReadAgentChatResponseSchema.parse(decodeMcpToolResult(result)).executionActivity
      expect(page).toBeDefined()
      return page!
    }
    let sequence = 0
    const append = async (records: NativeRecord[], options: { retainedHistory?: boolean } = {}) => {
      const events = records.map(record => ({ ...record, executionId: candidate.id, sequence: ++sequence,
        occurredAt: at, payload: { threadId: 'thread', turnId: 'turn', ...record.payload } }))
      if (options.retainedHistory) {
        await database.pool.query(`insert into harness_native_events(execution_id,sequence,record)
          select $1,(value->>'sequence')::integer,value from jsonb_array_elements($2::jsonb) value`,
        [candidate.id, JSON.stringify(events)])
        return
      }
      await database.pool.query('select append_harness_native_event(value) from jsonb_array_elements($1::jsonb) value',
        [JSON.stringify(events)])
    }
    const state = async (value: 'failed' | 'canceled') => {
      const stored = (await database.pool.query<{ record: Record<string, unknown> }>(
        'select record from harness_executions where id=$1', [candidate.id])).rows[0]!
      const terminal = HarnessExecutionSchema.parse({ ...stored.record, state: 'completed',
        result: { outcome: value, ...(value === 'failed' ? {
          error: { code: 'COMMAND_FAILED', message: 'The command failed', retryable: false },
        } : {}) }, finishedAt: new Date().toISOString(),
      })
      await database.pool.query('update harness_executions set record=$2::jsonb where id=$1',
        [candidate.id, JSON.stringify(terminal)])
    }
    return { executionId: candidate.id, transfers, managers, append, state, http, mcpPage,
      denied: async () => {
        expect((await httpResponse({}, denied.token)).statusCode).toBe(403)
        await expectMcpAccessDenied(deniedMcp.callTool({ name: 'agent_chat_read', arguments: mcpArguments() }))
      },
      close: async () => {
        await Promise.allSettled(clients.map(client => client.close()))
        await app.close()
        await graph.app.close()
        await chat.shutdown()
      },
    }
  }

  it.each(['failed', 'canceled'] as const)('delivers every unfinished tool after %s without new native events', async state => {
    const fixture = await setup()
    try {
      await fixture.append(Array.from({ length: 5 }, (_, index) => ({ type: 'item.started', payload: {
        item: { id: `command-${index}`, type: 'commandExecution', command: `check ${index}`, status: 'inProgress' },
      } })))
      const first = await fixture.http()
      expect(first.items).toHaveLength(5)
      await fixture.state(state)
      const changed = []
      let cursor = first.cursor!
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const page = await fixture.http({ cursor, limit: 2 })
        expect(await fixture.mcpPage({ cursor, limit: 2 })).toEqual(page)
        changed.push(...page.items)
        cursor = page.cursor!
        if (!page.hasMoreChanges) break
      }
      expect(changed.map(item => item.id)).toEqual(first.items.map(item => item.id))
      for (const item of changed) {
        expect(item.entry).toMatchObject({ kind: 'activity', activity: { status: 'unknown' } })
        expect(BigInt(item.revision)).toBeGreaterThan(BigInt(first.items.find(prior => prior.id === item.id)!.revision))
      }
      expect((await fixture.http({ cursor })).items).toEqual([])
      expect((await fixture.http()).items).toEqual(changed)
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it('keeps Claude commands, streamed arguments, file changes and redacted tool results on persisted readback', async () => {
    const fixture = await setup(claudeConfiguration)
    const secret = `opm_${'a'.repeat(43)}`
    try {
      await fixture.append([
        { type: 'claude.tool', payload: { itemId: 'bash', name: 'Bash', input: { command: 'git status' }, status: 'running' } },
        { type: 'claude.tool', payload: { itemId: 'bash', name: 'Bash', output: 'clean', status: 'completed' } },
        { type: 'claude.tool', payload: { itemId: 'read', name: 'Read', input: { file_path: '/work/report.txt' }, status: 'running' } },
        { type: 'claude.tool', payload: { itemId: 'read', output: [{ type: 'text', text: 'File contents' }], status: 'completed' } },
        { type: 'claude.tool', payload: { itemId: 'edit', name: 'Edit', input: {
          file_path: '/work/report.txt', old_string: 'before', new_string: 'after',
        }, status: 'completed', output: 'Updated' } },
        { type: 'claude.tool', payload: { itemId: 'mcp', name: 'mcp__tools__lookup', inputJsonDelta: '{"query":', status: 'running' } },
        { type: 'claude.tool', payload: { itemId: 'mcp', name: 'mcp__tools__lookup', inputJsonDelta: '"status"}', status: 'running' } },
        { type: 'claude.tool', payload: { itemId: 'mcp', output: `Result ${secret}`, status: 'completed' } },
        { type: 'claude.tool', payload: { itemId: 'boundary', name: 'Bash', input: { command: 'check output' },
          output: `${'x'.repeat(3_990)}${secret} ${'y'.repeat(19_952)}${secret}`, status: 'completed' } },
      ])
      const page = await fixture.http()
      expect(await fixture.mcpPage()).toEqual(page)
      expect(page.items.map(item => item.id)).toEqual(['bash', 'read', 'edit', 'mcp', 'boundary'])
      expect(page.items[0]?.entry).toMatchObject({ activity: { title: 'git status', input: expect.stringContaining('git status'), output: 'clean' } })
      expect(page.items[1]?.entry).toMatchObject({ activity: { title: 'Read /work/report.txt', output: 'File contents' } })
      expect(page.items[2]?.entry).toMatchObject({ activity: { title: 'Edit /work/report.txt', input: expect.stringContaining('after'), output: 'Updated' } })
      expect(page.items[3]?.entry).toMatchObject({ activity: { title: 'mcp__tools__lookup', input: '{"query":"status"}', output: 'Result [REDACTED]' } })
      expect(JSON.stringify(page.items[4])).not.toContain('opm_')
      const request = { executionId: fixture.executionId, itemId: 'edit' }
      expect(await fixture.mcpPage(request)).toEqual(await fixture.http(request))
      const boundary = await fixture.http({ executionId: fixture.executionId, itemId: 'boundary' })
      expect(JSON.stringify(boundary)).not.toContain('opm_')
      expect(JSON.stringify(page)).not.toContain(secret)
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it('continues incremental pages when native appends advance the execution allocator revision', async () => {
    const fixture = await setup()
    try {
      await fixture.append([
        { type: 'item.completed', payload: { item: { id: 'initial', type: 'agentMessage', text: 'Initial note' } } },
        ...Array.from({ length: 5 }, (_, index) => ({ type: 'item.started', payload: {
          item: { id: `command-${index}`, type: 'commandExecution', command: `check ${index}`, status: 'inProgress' },
        } })),
      ])
      const first = await fixture.http()
      await fixture.append(Array.from({ length: 5 }, (_, index) => ({ type: 'item.completed', payload: {
        item: { id: `command-${index}`, type: 'commandExecution', command: `check ${index}`, status: 'completed',
          aggregatedOutput: 'done' },
      } })))
      const initialChanges = await fixture.http({ cursor: first.cursor!, limit: 2 })
      expect(initialChanges.items.map(item => item.id)).toEqual(['command-0', 'command-1'])
      expect(initialChanges.hasMoreChanges).toBe(true)
      await fixture.append([{ type: 'item.completed', payload: {
        item: { id: 'new-note', type: 'agentMessage', text: 'Appended during pagination' },
      } }])
      const changed = [...initialChanges.items]
      let cursor = initialChanges.cursor!
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const request = { cursor, limit: 2 }
        const page = await fixture.http(request)
        expect(await fixture.mcpPage(request)).toEqual(page)
        changed.push(...page.items)
        cursor = page.cursor!
        if (!page.hasMoreChanges) break
      }
      expect(changed.map(item => item.id)).toEqual([
        'command-0', 'command-1', 'command-2', 'command-3', 'command-4', 'new-note',
      ])
      expect((await fixture.http({ cursor })).items).toEqual([])
    } finally { await fixture.close() }
  })

  it('bounds cold database transfer and public pages while retaining targeted details and older updated history', async () => {
    const fixture = await setup()
    const large = '\u0001漢'.repeat(20_000)
    try {
      await fixture.append(Array.from({ length: 320 }, (_, index) => ({ type: 'item.completed', payload: {
        item: { id: `message-${index + 1}`, type: 'agentMessage', text: `${index + 1}: ${large}` },
      } })), { retainedHistory: true })
      fixture.transfers.length = 0
      const newest = await fixture.http({ limit: 1 })
      expect(newest.items.map(item => item.id)).toEqual(['message-320'])
      expect(newest.executions[0]?.hasEarlierItems).toBe(true)
      expect(fixture.transfers.every(rows => rows.length <= 21)).toBe(true)
      const transferredBytes = fixture.transfers.reduce((total, rows) => total + Buffer.byteLength(JSON.stringify(rows)), 0)
      expect(transferredBytes).toBeLessThan(1024 * 1024)
      const expanded = await fixture.http({ executionId: fixture.executionId, itemId: 'message-1' })
      expect(expanded.items).toHaveLength(1)
      expect(expanded.items[0]?.sequence).toBe('1')
      expect(expanded.items[0]?.entry).toMatchObject({ message: { truncation: { truncated: true } } })
      expect(await fixture.mcpPage({ executionId: fixture.executionId, itemId: 'message-1' })).toEqual(expanded)
      await fixture.append([{ type: 'item.completed', payload: {
        item: { id: 'message-1', type: 'agentMessage', text: 'Updated first entry' },
      } }])
      const change = await fixture.http({ cursor: newest.cursor! })
      expect(change.items).toMatchObject([{ id: 'message-1', sequence: '1', entry: { message: { content: 'Updated first entry' } } }])
      const request = { executionId: fixture.executionId, before: '320', limit: 1 }
      const earlier = await fixture.http(request)
      expect(earlier.items.map(item => item.id)).toEqual(['message-319'])
      expect(await fixture.mcpPage(request)).toEqual(earlier)
      await fixture.append([
        { type: 'item.started', payload: { item: { id: 'stream', type: 'agentMessage', text: 'BEGIN ' } } },
        ...Array.from({ length: 4 }, () => ({ type: 'native.notification', payload: {
          itemId: 'stream', nativeMethod: 'item/agentMessage/delta', delta: 'z'.repeat(20_000),
        } })),
      ])
      const streamedRequest = { executionId: fixture.executionId, itemId: 'stream' }
      const streamed = await fixture.http(streamedRequest)
      expect(await fixture.mcpPage(streamedRequest)).toEqual(streamed)
      expect(streamed.items[0]?.entry).toMatchObject({ message: {
        content: expect.stringMatching(/^BEGIN /), nativeMessageComplete: false,
        truncation: { truncated: true, originalBytes: 80_006 },
      } })
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it('preserves public plan bodies and original sequence when an old plan changes outside the newest window', async () => {
    const fixture = await setup()
    try {
      await fixture.append([
        { type: 'native.notification', payload: { nativeMethod: 'turn/plan/updated',
          plan: [{ step: 'First step', status: 'inProgress' }] } },
        { type: 'item.completed', payload: { item: { id: 'answer', type: 'agentMessage', text: 'Working' } } },
      ])
      const first = await fixture.http({ limit: 1 })
      expect(first.items[0]?.id).toBe('answer')
      await fixture.append([{ type: 'native.notification', payload: { nativeMethod: 'turn/plan/updated',
        explanation: 'Progress update', plan: [
          { step: 'First step', status: 'completed' }, { step: 'Second step', status: 'inProgress' },
        ] } }])
      const request = { cursor: first.cursor! }
      const change = await fixture.http(request)
      expect(await fixture.mcpPage(request)).toEqual(change)
      expect(change.items).toMatchObject([{ id: 'plan:turn', sequence: '1', entry: {
        activity: { title: 'Update plan', output: 'Progress update\n[x] First step\n[~] Second step' },
      } }])
      const expanded = { executionId: fixture.executionId, itemId: 'plan:turn' }
      expect((await fixture.http(expanded)).items).toEqual(change.items)
    } finally { await fixture.close() }
  })
})
