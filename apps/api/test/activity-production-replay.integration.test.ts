import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentConfigurationVersionSchema, GetInteractionResponseSchema, OperatorConversationStateSchema } from '@foreman-code/contracts'
import { AgentChatHistoryPageSchema, AgentChatStateSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { ManagementActionSchema, ManagedAgentDefaultsSchema, WorkspaceLocationSetResultSchema } from '@foreman-code/contracts/management'
import { ManualRunStartResultSchema, SavedRunDetailsSchema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture, type CurrentFixtureForm } from '@foreman-code/contracts/wave25'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import * as workflowLifecycle from '../src/modules/runs/workflowLifecycle.js'
import { buildProductionApp } from '../src/production.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { createActivityReplayFileStorage, createActivityReplayWorkspace, startActivityReplayProduction } from './helpers/activityReplayLifecycle.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'

const closes: Array<() => Promise<void>> = []
async function eventStream(url: string, token: string) {
  const controller = new AbortController()
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal })
  if (!response.ok || !response.body) throw new Error('Authorized production SSE did not open.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffered = ''
  const queued: Array<Record<string, unknown>> = []
  const close = async () => { controller.abort(); await reader.cancel().catch(() => {}) }
  closes.push(close)
  const next = async (accept: (event: Record<string, unknown>) => boolean) => {
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      for (;;) {
        while (queued.length) { const event = queued.shift()!; if (accept(event)) return event }
        const part = await reader.read()
        if (part.done) throw new Error('Production SSE ended before the expected committed projection.')
        buffered += decoder.decode(part.value, { stream: true })
        let end: number
        while ((end = buffered.indexOf('\n\n')) >= 0) {
          const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2)
          const data = frame.split('\n').find((line) => line.startsWith('data: '))
          if (data) queued.push(JSON.parse(data.slice(6)) as Record<string, unknown>)
        }
      }
    } finally { clearTimeout(timer) }
  }
  return { next, close }
}
afterEach(async () => { while (closes.length) await closes.pop()!() })
async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() >= deadline) throw new Error('Production persisted readback did not reach the recorded fixture state.')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback replay port.')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}
async function setup(options: { operatorSandbox?: 'read-only' | 'workspace-write'; form?: CurrentFixtureForm; handoffs?: boolean } = {}) {
  const db = await agent3Database(); closes.push(db.close)
  const directory = await privateFixtureDirectory('activity-replay-workspace-')
  closes.push(() => removeFixtureDirectory(directory))
  const workspace = await createActivityReplayWorkspace(directory)
  const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, HARNESS_WORKSPACE_ROOT: workspace.harnessWorkspaceRoot,
    PORT: String(await freePort()), CODEX_BINARY: '/recorded-no-native-codex',  })
  config.workspaceStorageRoot = workspace.workspaceStorageRoot
  config.fileStorageRoot = await createActivityReplayFileStorage()
  closes.push(() => removeFixtureDirectory(config.fileStorageRoot!))
  const cpSchema = `${db.schema}_cp`
  await createFixtureSchema(db.pool, cpSchema)
  const checkpoints = createCheckpointStore(process.env.TEST_DATABASE_URL!, cpSchema, config.database)
  await checkpoints.setup()
  closes.push(async () => { await checkpoints.close(); await dropFixtureSchema(db.pool, cpSchema) })
  const seed = makeCurrentWorkflowFixture(randomUUID(), options.form ?? 'single')
  if (options.handoffs) seed.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...seed.version,
    definition: { ...seed.version.definition, handoffs: { contractVersion: 1 } } }))
  seed.configurations = seed.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({ ...configuration,
    harness: { harness: 'codex', model: 'test-model', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' } }))
  const saved = await seedAgent3(db.pool, workspace.workingDirectory, seed, { run: false })
  const access = new PostgresAccessService(db.pool)
  const writer = await access.issue({ name: 'W05 production fixture writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const denied = await access.issue({ name: 'W05 denied scope', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
    grants: [{ actions: ['agent_chat:read', 'agent_chat:respond', 'runs:read'], scope: { workspaceIds: ['different-workspace'] } }] })
  const replay = new ActivityProductionReplay()
  const database = { pool: db.pool, ping: async () => { await db.pool.query('select 1') },
    migrate: () => applyApplicationMigrations(db.pool), close: async () => {} }
  const infrastructure = replay.infrastructure(workspace.harnessWorkspaceRoot)
  let production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, infrastructure)
  let origin = await startActivityReplayProduction(production, replay, closes, config.port)
  const headers = { authorization: `Bearer ${writer.token}` }
  async function http(method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, token = writer.token) {
    const response = await production.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload } : {}) })
    return response
  }
  async function call(name: string, args: Record<string, unknown>, token = writer.token) {
    const client = new Client({ name: 'W05 actual production replay', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { authProvider: { token: async () => token } }))
      return await client.callTool({ name, arguments: args })
    } finally { await client.close() }
  }
  // Replace the seed's synthetic location with the real producer's canonical identity.
  const located = await http('PUT', `/api/management/workspaces/${saved.scope.workspaceId}/location`, {
    commandId: randomUUID(), expectedLocationRevision: 1, runnerId: LOCAL_RUNNER_ID, rootPath: workspace.workingDirectory,
  })
  expect(located.statusCode, located.body).toBe(200)
  const location = WorkspaceLocationSetResultSchema.parse(located.json()).value
  const defaults = ManagedAgentDefaultsSchema.parse((await http('GET', '/api/management/settings/agents')).json())
  const changed = await http('PUT', '/api/management/settings/agents', { commandId: randomUUID(), expectedRevision: defaults.revision,
    value: { ...defaults.value, operator: { ...defaults.value.operator,
      harness: { harness: 'codex', model: 'test-model', reasoningEffort: 'low', sandbox: options.operatorSandbox ?? 'read-only', serviceTier: 'standard' } } } })
  expect(changed.statusCode, changed.body).toBe(200)
  async function restart() {
    await production.shutdown()
    production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, infrastructure)
    origin = await startActivityReplayProduction(production, replay, closes, config.port)
  }
  return { db, saved, location, access, writer, denied, replay, headers, http, call, restart, reconcile: () => production.reconcile((error) => { throw error }), get origin() { return origin } }
}

async function admittedRun(f: Awaited<ReturnType<typeof setup>>, mode: 'complete' | 'approval' = 'complete') {
  const row = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.saved.scope.workflowId])).rows[0]!
  f.replay.nextStart = mode
  const response = await f.http('POST', `/api/management/workspaces/${f.saved.scope.workspaceId}/workflows/${f.saved.scope.workflowId}/runs`, {
    workflowVersionId: f.saved.version.id, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedWorkflowRevision: Number(row.revision), expectedAgentConfigurationVersionIds: f.saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: f.location.locationRevision, input: {},
  })
  expect(response.statusCode, response.body).toBe(202)
  return ManualRunStartResultSchema.parse(response.json())
}
async function completedRun(f: Awaited<ReturnType<typeof setup>>) {
  const started = await admittedRun(f)
  return eventually(async () => SavedRunDetailsSchema.parse((await f.http('GET',
    `/api/management/workspaces/${f.saved.scope.workspaceId}/runs/${started.run.id}`)).json()), (detail) => detail.run.outcome === 'succeeded')
}

/** Every scenario traverses actual production factories -> authenticated transport -> real native adapter
 * -> existing PostgreSQL receipts/messages -> authenticated HTTP/MCP readback. No installed-provider claim. */
describe.skipIf(!postgresEnabled)('W05 actual production activity replay', { timeout: 120000 }, () => {
  for (const boundary of ['queued successor', 'native terminal'] as const) {
    it(`restarts the actual engine at a ${boundary} without replaying native work`, async () => {
      const f = await setup({ form: 'sequential', handoffs: true })
      let queued!: () => void
      let release!: () => void
      const successorQueued = new Promise<void>((resolve) => { queued = resolve })
      const pause = new Promise<void>((resolve) => { release = resolve })
      let classified!: () => void
      const restartClassified = new Promise<void>((resolve) => { classified = resolve })
      const preserve = workflowLifecycle.settleWorkForRestart
      const classification = vi.spyOn(workflowLifecycle, 'settleWorkForRestart')
        .mockImplementation(async (...args) => {
          const result = await preserve(...args)
          if (result) classified()
          return result
        })
      const admit = RepeatRunRepository.prototype.admitWorkActivation
      let paused = false
      const admission = vi.spyOn(RepeatRunRepository.prototype, 'admitWorkActivation')
        .mockImplementation(async function (this: RepeatRunRepository, ...args) {
          const result = await admit.apply(this, args)
          if (boundary === 'queued successor' && !paused
            && result.execution.workflowNodeId === f.saved.version.definition.nodes[1]!.id) {
            paused = true
            queued()
            await pause
          }
          return result
        })
      const accept = RepeatRunRepository.prototype.acceptWorkTerminal
      const acceptance = vi.spyOn(RepeatRunRepository.prototype, 'acceptWorkTerminal')
        .mockImplementation(async function (this: RepeatRunRepository, ...args) {
          if (boundary === 'native terminal' && !paused) {
            paused = true
            queued()
            await pause
          }
          return accept.apply(this, args)
        })
      try {
        const workflow = f.saved.scope
        const revision = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1',
          [workflow.workflowId])).rows[0]!
        const response = await f.http('POST', `/api/management/workspaces/${workflow.workspaceId}/workflows/${workflow.workflowId}/runs`, {
          workflowVersionId: f.saved.version.id, commandId: randomUUID(), executionSemanticsVersion: 3,
          expectedWorkflowRevision: Number(revision.revision),
          expectedAgentConfigurationVersionIds: f.saved.version.agentConfigurationVersionIds,
          expectedLocationRevision: f.location.locationRevision, input: {},
        })
        expect(response.statusCode, response.body).toBe(202)
        const started = ManualRunStartResultSchema.parse(response.json())
        // Supply the provider's original accepted handoff result through its native transport.
        const first = await eventually(async () => f.replay.starts[0], (value) => value !== undefined)
        f.replay.complete(first!.sessionId, first!.nativeTurnId, JSON.stringify({ routing: { kind: 'finish' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: [] } }))
        await successorQueued
        const before = (await f.db.pool.query<{ id: string; record: { state: string; input: unknown } }>(
          'select id,record from harness_executions where run_id=$1 and workflow_node_id=$2',
          [started.run.id, f.saved.version.definition.nodes[boundary === 'queued successor' ? 1 : 0]!.id])).rows[0]!
        expect(before.record.state).toBe(boundary === 'queued successor' ? 'queued' : 'completed')
        expect(f.replay.starts).toHaveLength(1)
        const restarting = f.restart()
        await restartClassified
        release()
        await restarting
        admission.mockRestore()
        expect((await f.db.pool.query('select run_id from run_cleanup_intents where run_id=$1 and pending',
          [started.run.id])).rowCount).toBe(0)
        const resumed = f.reconcile()
        const second = await eventually(async () => f.replay.starts[1], (value) => value !== undefined)
        f.replay.complete(second!.sessionId, second!.nativeTurnId, JSON.stringify({ routing: { kind: 'finish' },
          data: { latestDeliverable: { revision: 2 }, remainingFindings: [] } }))
        await resumed
        const detail = await eventually(async () => SavedRunDetailsSchema.parse((await f.http('GET',
          `/api/management/workspaces/${f.saved.scope.workspaceId}/runs/${started.run.id}`)).json()),
        (value) => value.run.executionState === 'completed')
        expect(detail.run.outcome).toBe('succeeded')
        expect(detail.executions.find((execution) => execution.id === before.id)?.input).toEqual(before.record.input)
        expect(f.replay.starts).toHaveLength(2)
        expect((await f.db.pool.query('select id from harness_executions where run_id=$1', [started.run.id])).rowCount).toBe(2)
      } finally { release(); admission.mockRestore(); acceptance.mockRestore(); classification.mockRestore() }
    })
  }

  for (const selected of [false, true]) it(`${selected ? 'selected Run' : 'Agent'}: older active/newer queued, final empty, replay and restart preserve exact source`, async () => {
    const f = await setup(), workspaceId = f.saved.scope.workspaceId, workflowId = f.saved.scope.workflowId
    const node = f.saved.version.definition.nodes[0]!
    const origin = selected ? await completedRun(f) : undefined
    const execution = origin ? origin.executions.find((entry) => entry.workflowNodeId === node.id) : undefined
    if (origin && !execution) throw new Error('Selected Run has no exact recorded node execution.')
    const query = { workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const base = selected ? `/api/workspaces/${workspaceId}/agent-chat/workflows/${workflowId}/runs/${origin!.run.id}/nodes/${node.id}`
      : `/api/workspaces/${workspaceId}/agent-chat`
    const selection = selected ? { workflowId, runId: origin!.run.id, workflowNodeId: node.id, executionId: execution!.id } : undefined
    const read = async () => {
      const response = await f.http('GET', selected ? `${base}?executionId=${execution!.id}`
        : `${base}?workflowId=${workflowId}&workflowNodeId=${node.id}&agentId=${node.agentId}`)
      expect(response.statusCode, response.body).toBe(200)
      const value = selected ? ReadSelectedRunChatResponseSchema.parse(response.json()) : undefined
      if (value && value.kind !== 'selected') throw new Error('Exact recorded source was substituted.')
      return value ? value.state : AgentChatStateSchema.parse(response.json())
    }
    const message = (requestId: string, expectedConversationId: string | null) => ({ requestId, content: 'recorded active message', intent: 'next_turn', expectedConversationId })
    const first = await f.http('POST', `${base}/messages`, selected ? { ...message('active-A', null), executionId: execution!.id }
      : { ...message('active-A', null), context: query })
    expect(first.statusCode, first.body).toBe(202)
    const initial = SendAgentChatMessageResponseSchema.parse(first.json())
    const id = initial.state.conversation!.id
    const active = await eventually(read, (state) => !!state.activeTurn?.nativeTurnId)
    const native = active.activitySnapshot!.active.find((owner) => owner.ref.kind === 'chat_request')!.native!
    const second = await f.http('POST', `${base}/messages`, selected ? { ...message('queued-B', id), executionId: execution!.id }
      : { ...message('queued-B', id), context: query })
    expect(second.statusCode, second.body).toBe(202)
    const queued = await read()
    expect(queued.activitySnapshot!.active[0]!.ref).toMatchObject({ requestId: 'active-A' })
    expect(queued.activitySnapshot!.queued).toContainEqual({ kind: 'chat_request', conversationId: id, requestId: 'queued-B' })
    expect(queued.activitySnapshot!.latest).toMatchObject({ requestId: 'queued-B' })
    const canceled = await f.http('POST', `/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/turns/queued-B/cancel`, { requestId: 'cancel-B-control' })
    expect(canceled.statusCode, canceled.body).toBe(200)
    const calls = f.replay.starts.length
    const retried = await f.call('agent_chat_cancel_queued', { workspaceId, conversationId: id, turnRequestId: 'queued-B', requestId: 'cancel-B-control' })
    expect(retried.isError).not.toBe(true); expect(f.replay.starts.length).toBe(calls)
    expect((await read()).activitySnapshot!.active[0]!.ref).toMatchObject({ requestId: 'active-A' })
    const stream = await eventStream(`${f.origin}/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/events`, f.writer.token)
    const bootstrap = await stream.next((event) => event.type === 'snapshot')
    expect((bootstrap.data as Record<string, unknown>).activitySnapshot).toMatchObject({ scope: active.activitySnapshot!.scope })
    f.replay.commandRunning(native.sessionId, native.turnId!)
    await eventually(read, (state) => state.activitySnapshot!.activities.some((item) => item.kind === 'tool' && item.status === 'running'))
    f.replay.append(native.sessionId, native.turnId!, 'provisional answer longer than final')
    await eventually(read, (state) => state.messages.some((entry) => entry.role === 'assistant' && entry.content.includes('provisional')))
    const emitted = await stream.next((event) => event.type === 'delta' && !!(event.data as Record<string, unknown>)?.activityChange)
    expect(emitted.data).toMatchObject({ activityChange: { schemaVersion: 1, scope: active.activitySnapshot!.scope,
      owner: { kind: 'chat_request', conversationId: id, requestId: 'active-A' },
      native: { sessionId: native.sessionId, turnId: native.turnId }, change: { kind: 'text.append', channel: 'assistant' } } })
    expect(typeof (emitted.data as Record<string, unknown>).scopeRevision).toBe('string')
    await stream.close()
    const oversized = '界'.repeat(150000)
    f.replay.append(native.sessionId, native.turnId!, oversized)
    const historyUrl = `/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/history`
    const largeHistory = await eventually(async () => {
      const response = await f.http('GET', `${historyUrl}?limit=1`)
      expect(response.statusCode, response.body).toBe(200)
      return AgentChatHistoryPageSchema.parse(response.json())
    }, (page) => page.messages.some((entry) => entry.content.endsWith(oversized)))
    expect(largeHistory.messages[0]!.content).toBe(`provisional answer longer than final${oversized}`)
    const bounded = await read()
    expect(JSON.stringify(bounded).length).toBeLessThan(400000)
    const mcpHistory = await f.call('agent_chat_read', { workspaceId, ...(selection ? { selection } : { query }), history: { limit: 1 } })
    expect(mcpHistory.isError).not.toBe(true)
    expect((decodeMcpToolResult(mcpHistory) as { history: unknown }).history).toEqual(largeHistory)
    expect(f.replay.starts.length).toBe(calls)
    f.replay.complete(native.sessionId, native.turnId!, '')
    const finished = await eventually(read, (state) => state.activeTurn === null)
    const finalText = finished.activitySnapshot!.activities.filter((item) => item.kind === 'text' && item.owner.kind === 'chat_request' && item.owner.requestId === 'active-A')
    expect(finalText.filter((item) => item.kind === 'text' && item.text === '').length).toBe(1)
    expect(finished.activitySnapshot!.active.some((item) => item.ref.kind === 'tool')).toBe(true)
    f.replay.commandCompleted(native.sessionId, native.turnId!)
    const childSettled = await eventually(read, (state) => state.activitySnapshot!.activities.some((item) => item.kind === 'tool' && item.status === 'completed'))
    expect(childSettled.activeTurn).toBeNull()
    expect(childSettled.activitySnapshot!.latest).toMatchObject({ requestId: 'queued-B' })
    expect(childSettled.activitySnapshot!.activities.find((item) => item.kind === 'tool')).toMatchObject({ owner: { requestId: 'active-A' }, native: { sessionId: native.sessionId, turnId: native.turnId } })
    const revision = childSettled.revision
    f.replay.complete(native.sessionId, native.turnId!, '')
    expect((await read()).revision).toBe(revision)
    f.replay.append(native.sessionId, native.turnId!, 'late stale delta')
    const cold = await read()
    expect(cold.revision).toBe(revision)
    expect(cold.messages.some((entry) => entry.content.includes('late stale delta'))).toBe(false)
    const mcp = await f.call('agent_chat_read', { workspaceId, ...(selection ? { selection } : { query }) })
    expect(mcp.isError).not.toBe(true)
    const mcpState = selected ? ReadSelectedRunChatResponseSchema.parse(decodeMcpToolResult(mcp)) : AgentChatStateSchema.parse(decodeMcpToolResult(mcp))
    const equivalent = 'kind' in mcpState ? (mcpState.kind === 'selected' ? mcpState.state : undefined) : mcpState
    expect(equivalent?.activitySnapshot).toEqual(cold.activitySnapshot)
    const denied = await f.call('agent_chat_read', { workspaceId, ...(selection ? { selection } : { query }) }, f.denied.token)
    expect(denied.isError).toBe(true)
    await f.restart()
    expect((await read()).activitySnapshot).toEqual(cold.activitySnapshot)
    const counts = await f.db.pool.query('select count(*)::int as count from management_command_receipts where principal_id=$1 and command_id=$2',
      [f.writer.principal.id, 'cancel-B-control'])
    expect(counts.rows[0]!.count).toBe(1)
    const foreignCreated = await f.http('POST', '/api/operator/conversations', { title: 'Foreign cursor source' })
    expect(foreignCreated.statusCode, foreignCreated.body).toBe(201)
    const foreignId = foreignCreated.json().conversation.id
    expect((await f.http('POST', `/api/operator/conversations/${foreignId}/messages`, { requestId: 'foreign-source', content: 'Own separate history' })).statusCode).toBe(202)
    const foreign = (await f.db.pool.query('select turn_sequence::text as cursor from operator_conversation_turns where conversation_id=$1 and request_id=$2', [foreignId, 'foreign-source'])).rows[0]!.cursor
    const receiptUrl = `/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/turns?before=${foreign}&limit=1`
    const foreignHttp = await f.http('GET', receiptUrl)
    expect(foreignHttp.statusCode, foreignHttp.body).toBe(409)
    expect(foreignHttp.json().error.code).toBe('TURN_HISTORY_CURSOR_SCOPE_CONFLICT')
    const foreignMcp = await f.call('agent_chat_read', { workspaceId, ...(selection ? { selection } : { query }), receipts: { before: foreign, limit: 1 } })
    expect(foreignMcp.isError).toBe(true)
  })

  for (const uncertain of [false, true]) it(`Agent response ${uncertain ? 'uncertain' : 'acknowledged'}: exact recorded choice, HTTP/MCP retry and revoked action`, async () => {
    const f = await setup(), workspaceId = f.saved.scope.workspaceId, workflowId = f.saved.scope.workflowId
    const node = f.saved.version.definition.nodes[0]!, query = { workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const base = `/api/workspaces/${workspaceId}/agent-chat`
    const first = await f.http('POST', `${base}/messages`, { requestId: 'approval-owner', content: 'recorded waiting message',
      intent: 'next_turn', expectedConversationId: null, context: query })
    expect(first.statusCode, first.body).toBe(202)
    const id = SendAgentChatMessageResponseSchema.parse(first.json()).state.conversation!.id
    const read = async () => AgentChatStateSchema.parse((await f.http('GET',
      `${base}?workflowId=${workflowId}&workflowNodeId=${node.id}&agentId=${node.agentId}`)).json())
    const active = await eventually(read, (state) => !!state.activeTurn?.nativeTurnId)
    const native = active.activitySnapshot!.active[0]!.native!
    await f.replay.ask(native.sessionId, native.turnId!)
    const waiting = await eventually(read, (state) => !!state.pendingInteraction)
    expect(waiting.responseAvailability?.available).toBe(true)
    const pending = waiting.pendingInteraction!, choice = pending.responseOptions.find((option) => option.semantic === 'approve_once')!
    const request = { requestId: 'answer-control', nativeRequestId: pending.turn.nativeRequestId!, optionId: choice.optionId }
    if (uncertain) f.replay.nextResponse = 'uncertain'
    const answered = await f.http('POST', `${base}/conversations/${id}/responses`, request)
    expect(answered.statusCode, answered.body).toBe(uncertain ? 409 : 200)
    expect(f.replay.responses).toHaveLength(1)
    const result = (await f.db.pool.query(`select result from management_command_receipts
      where principal_id=$1 and operation='agent_chat_control' and command_id=$2`, [f.writer.principal.id, request.requestId])).rows[0]!.result
    expect(result).toMatchObject({ status: uncertain ? 'uncertain' : 'completed', acceptedControl: { modelRequestId: 'approval-owner',
      conversationId: id, scope: waiting.activitySnapshot!.scope, native: { sessionId: native.sessionId, turnId: native.turnId,
        requestId: request.nativeRequestId }, choice: { optionId: choice.optionId, semantic: choice.semantic } } })
    const retried = await f.call('agent_chat_respond', { workspaceId, conversationId: id, ...request })
    expect(retried.isError === true).toBe(uncertain)
    expect(f.replay.responses).toHaveLength(1)
    const settled = await read()
    const recorded = settled.activitySnapshot!.pendingInteractions.find((entry) => entry.native?.requestId === request.nativeRequestId)
      ?? settled.activitySnapshot!.activities.filter((item) => item.kind === 'interaction').map((item) => item.interaction)
        .find((entry) => entry.native?.requestId === request.nativeRequestId)
    expect(recorded).toMatchObject({ answerRecorded: true, providerAcknowledged: !!result.providerAcknowledgment, workerAcknowledged: false,
      delivery: uncertain ? 'uncertain' : result.providerAcknowledgment ? 'delivered' : 'answer_recorded' })
    if (uncertain) expect(settled.responseAvailability?.available).toBe(false)
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id,
      JSON.stringify([{ actions: ['agent_chat:read'], scope: {} }])])
    // A fresh MCP session omits actions removed from the principal's live grants.
    await expectMcpAccessDenied(f.call('agent_chat_respond', { workspaceId, conversationId: id, ...request }))
    const denied = await f.http('POST', `${base}/conversations/${id}/responses`, request)
    expect(denied.statusCode, denied.body).toBe(403)
    expect(f.replay.responses).toHaveLength(1)
  })

  it('Operator: current callback, empty history after restart, consumed answer and owned HTTP/MCP readback', async () => {
    const f = await setup()
    const created = await f.http('POST', '/api/operator/conversations', { title: 'Recorded Operator request' })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().conversation.id
    const sent = await f.http('POST', `/api/operator/conversations/${id}/messages`, { requestId: 'operator-A', content: 'recorded active message' })
    expect(sent.statusCode, sent.body).toBe(202)
    const read = async () => OperatorConversationStateSchema.parse((await f.http('GET', `/api/operator/conversations/${id}`)).json())
    const active = await eventually(read, (state) => !!state.activitySnapshot?.active[0]?.native?.turnId)
    const native = active.activitySnapshot!.active[0]!.native!
    await f.replay.ask(native.sessionId, native.turnId!)
    const waiting = await eventually(read, (state) => state.pendingInteraction !== undefined)
    expect(waiting.responseAvailability?.available).toBe(true)
    expect(waiting.activitySnapshot!.pendingInteractions[0]!.providerAcknowledged).toBe(false)
    const readback = await f.call('operator_chat_get', { conversationId: id })
    expect(readback.isError).not.toBe(true)
    expect(OperatorConversationStateSchema.parse(decodeMcpToolResult(readback)).activitySnapshot).toEqual(waiting.activitySnapshot)
    f.replay.disconnect(native.sessionId)
    const lost = await eventually(read, (state) => state.responseAvailability?.available === false)
    expect(lost.pendingInteraction).toEqual(waiting.pendingInteraction)
    expect(lost.responseAvailability?.message).toMatch(/unavailable|reconcile|cannot inspect/i)
    const effects = f.replay.responses.length
    await f.restart()
    const restarted = await read()
    expect(restarted.pendingInteraction?.turn.nativeRequestId).toBe(waiting.pendingInteraction!.turn.nativeRequestId)
    expect(restarted.responseAvailability?.available).toBe(false)
    expect(f.replay.responses.length).toBe(effects)
  })

  for (const uncertain of [false, true]) it(`Operator control parity: ${uncertain ? 'uncertain' : 'accepted'} response, changed choice, cached grant checks and cancel`, async () => {
    const f = await setup()
    const created = await f.http('POST', '/api/operator/conversations', { title: 'Operator parity controls' })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().conversation.id
    const sent = await f.http('POST', `/api/operator/conversations/${id}/messages`, { requestId: 'operator-parity-turn', content: 'Wait for exact native approval' })
    expect(sent.statusCode, sent.body).toBe(202)
    const read = async () => OperatorConversationStateSchema.parse((await f.http('GET', `/api/operator/conversations/${id}`)).json())
    const active = await eventually(read, (state) => !!state.activitySnapshot?.active[0]?.native?.turnId)
    const native = active.activitySnapshot!.active[0]!.native!
    await f.replay.ask(native.sessionId, native.turnId!)
    const waiting = await eventually(read, (state) => !!state.pendingInteraction && state.responseAvailability?.available === true)
    const pending = waiting.pendingInteraction!, option = pending.responseOptions.find((entry) => entry.semantic === 'approve_once')!
    const alternative = pending.responseOptions.find((entry) => entry.optionId !== option.optionId)!
    const request = { requestId: 'operator-parity-turn', nativeRequestId: pending.turn.nativeRequestId!, optionId: option.optionId, commandId: 'operator-answer-key' }
    const denied = await f.call('operator_chat_respond', { conversationId: id, request }, f.denied.token)
    expect(denied.isError).toBe(true); expect(f.replay.responses).toHaveLength(0)
    if (uncertain) f.replay.nextResponse = 'uncertain'
    const answered = await f.http('POST', `/api/operator/conversations/${id}/responses`, request)
    expect(answered.statusCode, answered.body).toBe(uncertain ? 409 : 200)
    const retried = await f.call('operator_chat_respond', { conversationId: id, request })
    expect(retried.isError === true).toBe(uncertain)
    expect(f.replay.responses).toHaveLength(1)
    const changed = await f.http('POST', `/api/operator/conversations/${id}/responses`, { ...request, optionId: alternative.optionId })
    expect(changed.statusCode, changed.body).toBe(409)
    expect(changed.json().error.code).toBe('OPERATOR_CHAT_REQUEST_CONFLICT')
    const receipt = (await f.db.pool.query(`select result from management_command_receipts where principal_id=$1
      and operation='operator_chat_control' and command_id=$2`, [f.writer.principal.id, request.commandId])).rows[0]!.result
    expect(receipt).toMatchObject({ status: uncertain ? 'uncertain' : 'completed', acceptedControl: { conversationId: id,
      modelRequestId: request.requestId, native: { sessionId: native.sessionId, turnId: native.turnId, requestId: request.nativeRequestId },
      choice: { optionId: option.optionId, semantic: option.semantic } } })
    expect((await f.call('operator_chat_get', { conversationId: id })).isError).not.toBe(true)
    const cancel = { requestId: request.requestId, commandId: 'operator-cancel-key' }
    const canceled = await f.http('POST', `/api/operator/conversations/${id}/cancel`, cancel)
    expect(canceled.statusCode, canceled.body).toBe(200)
    const nativeCancels = f.replay.calls.filter((entry) => entry.method === 'turn/interrupt').length
    const cancelRetry = await f.call('operator_chat_cancel', { conversationId: id, request: cancel })
    expect(cancelRetry.isError).not.toBe(true)
    expect(f.replay.calls.filter((entry) => entry.method === 'turn/interrupt')).toHaveLength(nativeCancels)
    expect((await f.db.pool.query(`select count(*)::int as count from management_command_receipts where principal_id=$1
      and operation='operator_chat_control' and command_id=$2`, [f.writer.principal.id, cancel.commandId])).rows[0]!.count).toBe(1)
    for (const title of ['First implicit control scope', 'Second implicit control scope']) {
      const newConversation = await f.http('POST', '/api/operator/conversations', { title })
      expect(newConversation.statusCode, newConversation.body).toBe(201)
      const otherId = newConversation.json().conversation.id
      expect((await f.http('POST', `/api/operator/conversations/${otherId}/messages`, { requestId: 'same-per-conversation-model-id', content: 'Own independent cancellation' })).statusCode).toBe(202)
      const implicit = await f.http('POST', `/api/operator/conversations/${otherId}/cancel`, { requestId: 'same-per-conversation-model-id' })
      expect(implicit.statusCode, implicit.body).toBe(200)
      const implicitRetry = await f.call('operator_chat_cancel', { conversationId: otherId, request: { requestId: 'same-per-conversation-model-id' } })
      expect(implicitRetry.isError).not.toBe(true)
    }
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id,
      JSON.stringify([{ actions: ['operator_chat:read'], scope: {} }])])
    const noAction = await f.call('operator_chat_respond', { conversationId: id, request })
    expect(noAction.isError).toBe(true)
    expect((await f.http('POST', `/api/operator/conversations/${id}/cancel`, cancel)).statusCode).toBe(403)
    expect(f.replay.responses).toHaveLength(1)
  })

  it('Operator publications: twelve real receipt-backed outputs survive final-text replacement, duplicate finalization and retained authorized download', async () => {
    const f = await setup({ operatorSandbox: 'workspace-write' })
    const created = await f.http('POST', '/api/operator/conversations', { title: 'Explicitly write-enabled file fixture' })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().conversation.id, fileRoot = `/api/operator/conversations/${id}/files`
    const inputBytes = Buffer.from('# retained input\n'), uploadId = randomUUID()
    const allocation = await f.http('POST', `${fileRoot}/uploads`, { requestId: uploadId, filename: 'source.md', mediaType: 'text/markdown',
      byteSize: inputBytes.length, sha256: createHash('sha256').update(inputBytes).digest('hex') })
    expect(allocation.statusCode, allocation.body).toBe(201)
    const uploaded = await fetch(`${f.origin}${fileRoot}/uploads/${uploadId}`, { method: 'PUT', headers: {
      authorization: `Bearer ${f.writer.token}`, 'content-type': 'application/octet-stream', 'content-length': String(inputBytes.length),
    }, body: inputBytes })
    expect(uploaded.ok).toBe(true)
    const finalized = await f.http('POST', `${fileRoot}/uploads/${uploadId}/finalize`, {})
    expect(finalized.statusCode, finalized.body).toBe(200)
    const input = finalized.json().value, pin = { fileId: input.file.fileId, revisionId: input.revision.revisionId }, scope = input.file.scope
    const sent = await f.http('POST', `/api/operator/conversations/${id}/messages`, { requestId: 'file-owner-A', content: 'recorded file input', attachments: [pin] })
    expect(sent.statusCode, sent.body).toBe(202)
    const read = async () => OperatorConversationStateSchema.parse((await f.http('GET', `/api/operator/conversations/${id}`)).json())
    const active = await eventually(read, (state) => !!state.activitySnapshot?.active[0]?.native?.turnId)
    const native = active.activitySnapshot!.active[0]!.native!
    f.replay.finalText(native.sessionId, native.turnId!, 'final text before output publication')
    await eventually(read, (state) => state.messages.some((message) => message.role === 'assistant' && message.content === 'final text before output publication'))
    const decode = (reply: { response: Record<string, unknown> }) => {
      expect(reply.response.success).toBe(true)
      const content = reply.response.contentItems as Array<{ type: string; text: string }>
      return JSON.parse(content[0]!.text)
    }
    const outputs: Array<{ fileId: string; revisionId: string; bytes: Buffer; digest: string }> = []
    for (let index = 0; index < 12; index++) {
      const copy = decode(await f.replay.fileTool(native.sessionId, native.turnId!, 'files_create_working_copy', {
        commandId: randomUUID(), source: pin, destination: scope,
      }))
      const bytes = Buffer.from(`# actual output ${index}\n`)
      decode(await f.replay.fileTool(native.sessionId, native.turnId!, 'files_write_working_copy', {
        artifactId: copy.value.artifactId, contentBase64: bytes.toString('base64'),
      }))
      const request = { commandId: randomUUID(), artifactId: copy.value.artifactId, scope,
        filename: `output-${index}.md`, mediaType: 'text/markdown' }
      const reply = await f.replay.fileTool(native.sessionId, native.turnId!, 'files_publish_result', request)
      const publication = decode(reply)
      expect(publication.value.revision.origin).not.toBe('upload')
      const digest = createHash('sha256').update(bytes).digest('hex')
      expect(publication.value.revision.sha256).toBe(digest)
      outputs.push({ fileId: publication.value.file.fileId, revisionId: publication.value.revision.revisionId, bytes, digest })
      if (index === 0) expect(decode(await f.replay.fileTool(native.sessionId, native.turnId!, 'files_publish_result', request, reply.callId)))
        .toEqual(publication)
    }
    const unavailable = await f.replay.fileTool(native.sessionId, native.turnId!, 'files_publish_result', { commandId: randomUUID(),
      artifactId: 'unowned-artifact', scope, filename: 'unavailable.md', mediaType: 'text/markdown' })
    expect(unavailable.response.success).toBe(false)
    f.replay.complete(native.sessionId, native.turnId!, 'final text before output publication')
    const finished = await eventually(read, (state) => state.activeRequestId === null)
    expect(finished.activitySnapshot!.activities.filter((item) => item.kind === 'file_publication')).toHaveLength(12)
    expect(finished.messages.filter((message) => message.role === 'assistant' && message.content === 'final text before output publication')).toHaveLength(1)
    const message = finished.messages.find((entry) => entry.requestId === 'file-owner-A' && entry.role === 'user')!
    expect(message.attachments).toHaveLength(13)
    expect(new Set(message.attachments!.map((attachment) => attachment.file.fileId)).size).toBe(13)
    const mcp = await f.call('operator_chat_get', { conversationId: id })
    expect(mcp.isError).not.toBe(true)
    expect(OperatorConversationStateSchema.parse(decodeMcpToolResult(mcp)).activitySnapshot).toEqual(finished.activitySnapshot)
    await f.restart()
    const retained = await read()
    expect(retained.messages.find((entry) => entry.id === message.id)?.attachments).toEqual(message.attachments)
    for (const output of outputs) {
      const url = `${fileRoot}/${output.fileId}/revisions/${output.revisionId}/content`
      const downloaded = await fetch(`${f.origin}${url}`, { headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(downloaded.status).toBe(200)
      const bytes = Buffer.from(await downloaded.arrayBuffer())
      expect(bytes).toEqual(output.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(output.digest)
      const denied = await fetch(`${f.origin}${url}`, { headers: { authorization: `Bearer ${f.denied.token}` } })
      expect([403, 404]).toContain(denied.status)
    }
    expect((await f.db.pool.query("select count(*)::int as count from file_tool_publications p join files f on f.file_id=p.file_id where f.conversation_id=$1", [id])).rows[0]!.count).toBe(12)
  })

  it('Workflow approval: live callback is qualified; recorded choice and provider/worker acknowledgment remain distinct', async () => {
    const f = await setup(), started = await admittedRun(f, 'approval'), workspaceId = started.run.workspaceId
    const detail = await eventually(async () => SavedRunDetailsSchema.parse((await f.http('GET',
      `/api/management/workspaces/${workspaceId}/runs/${started.run.id}`)).json()),
    (value) => value.activitySnapshot!.pendingInteractions.length > 0)
    const interaction = detail.activitySnapshot!.pendingInteractions[0]!
    // Request publication precedes the checkpoint binding, which advances its public revision.
    const view = await eventually(async () => {
      const response = await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, '')
      expect(response.statusCode, response.body).toBe(200)
      return GetInteractionResponseSchema.parse(response.json())
    }, (value) => !!value.interaction.graphInterruptId)
    const current = view.interaction
    expect(current.revision).toBeGreaterThan(0)
    expect(view).toMatchObject({ canRespond: true, activity: { phase: 'needs_answer', answerRecorded: false,
      nativeDelivery: 'not_started', workerAcknowledgment: 'unknown', response: { available: true, path: 'live_callback' } } })
    const choice = current.responseOptions.find((option) => option.semantic === 'approve_once')!
    const stale = await f.http('POST', `/api/user/interactions/${interaction.id}/respond`, {
      interactionId: interaction.id, expectedRevision: current.revision - 1, optionId: choice.optionId,
    }, '')
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('REVISION_CONFLICT')
    expect(f.replay.responses).toHaveLength(0)
    const unchanged = GetInteractionResponseSchema.parse((await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, '')).json())
    expect(unchanged.interaction).toMatchObject({ revision: current.revision, status: 'pending',
      graphInterruptId: current.graphInterruptId, nativeSessionId: current.nativeSessionId, nativeRequestId: current.nativeRequestId })
    const authoritative = (await f.db.pool.query<{ revision: string; graph_interrupt_id: string }>(`
      select revision::text,record->>'graphInterruptId' as graph_interrupt_id from durable_interactions where id=$1`, [interaction.id])).rows[0]!
    expect(authoritative).toEqual({ revision: String(current.revision), graph_interrupt_id: current.graphInterruptId })
    const answer = await f.http('POST', `/api/user/interactions/${interaction.id}/respond`, {
      interactionId: interaction.id, expectedRevision: current.revision, optionId: choice.optionId,
    }, '')
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json().interaction.deliveryState).not.toBe('delivered')
    expect(f.replay.responses).toHaveLength(1)
    const recorded = await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, '')
    expect(recorded.json().activity.answerRecorded).toBe(true)
    expect(recorded.json().activity.workerAcknowledgment).toBe('unknown')
    expect(recorded.json().activity.response.available).toBe(false)
    const nativeSessionId = current.nativeSessionId
    const nativeTurnId = f.replay.starts.find((entry) => entry.sessionId === nativeSessionId)!.nativeTurnId
    f.replay.commandCompleted(nativeSessionId, nativeTurnId)
    f.replay.complete(nativeSessionId, nativeTurnId, 'recorded post-approval final')
    await f.reconcile()
    const persisted = (await f.db.pool.query('select record from durable_interactions where id=$1', [interaction.id])).rows[0]!.record
    expect(persisted.id).toBe(current.id)
    expect(persisted.nativeSessionId).toBe(nativeSessionId)
    expect(persisted.nativeRequestId).toBe(current.nativeRequestId)
    expect(f.replay.responses).toHaveLength(1)
  })

  it('Workflow: real Run snapshot/cursor and denied caller preserve original execution and delivery evidence', async () => {
    const f = await setup(), detail = await completedRun(f)
    expect(detail.activitySnapshot!.scope).toEqual({ kind: 'workflow_run', workspaceId: detail.run.workspaceId,
      workflowId: detail.run.workflowId, runId: detail.run.id, workflowVersionId: detail.run.workflowVersionId })
    expect(detail.activitySnapshot!.active).toEqual([])
    const readback = await f.call('run_get', { workspaceId: detail.run.workspaceId, runId: detail.run.id, detail: 'full' })
    expect(readback.isError).not.toBe(true)
    expect(SavedRunDetailsSchema.parse(decodeMcpToolResult(readback)).activitySnapshot).toEqual(detail.activitySnapshot)
    const activity = await f.call('run_activities_get_v1', { workspaceId: detail.run.workspaceId, runId: detail.run.id, limit: 10 })
    expect(activity.isError).not.toBe(true)
    expect(decodeMcpToolResult(activity)).toMatchObject({ scope: { workspaceId: detail.run.workspaceId,
      workflowId: detail.run.workflowId, runId: detail.run.id, workflowVersionId: detail.run.workflowVersionId } })
    expect(decodeMcpToolResult(activity)).not.toHaveProperty('activitySnapshot')
    const denied = await f.call('run_get', { workspaceId: detail.run.workspaceId, runId: detail.run.id }, f.denied.token)
    expect(denied.isError).toBe(true)
    await f.access.revoke(f.writer.principal.id)
    const revoked = await f.http('GET', `/api/management/workspaces/${detail.run.workspaceId}/runs/${detail.run.id}`)
    expect(revoked.statusCode).toBe(401)
    expect(f.replay.responses).toHaveLength(0)
    expect((await f.db.pool.query('select count(*)::int as count from harness_executions where run_id=$1', [detail.run.id])).rows[0]!.count)
      .toBe(detail.executions.length)
  })
})
