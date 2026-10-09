import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { NativeHarnessEventSchema, type NativeHarnessEvent,
  type NativeSessionReference, type HarnessExecution } from '@foreman-code/contracts'
import { AgentChatHistoryPageSchema, AgentChatStateSchema, AgentChatTurnPageSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { ReadSelectedRunChatResponseSchema, type SelectedRunChatTarget } from '@foreman-code/contracts/selected-run-chat'
import { makeCurrentWorkflowFixture, RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { RunPlacementReadService } from '../src/modules/placement/readService.js'
import { PostgresScheduleDispatcher } from '../src/modules/schedules/postgresDispatcher.js'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import type { NativeSessionStart, NativeSteerInput } from '../src/modules/harnesses/port.js'
import { AgentChatF5Native, eventually } from './helpers/agentChatF5.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { waitForSuccessfulRunCleanup } from './helpers/runSettlement.testSupport.js'

// Same pending SCH-05 schema setup as its integration tests. Production registration
// is deliberately NOT altered by SCH-06. These are real migrations/SQL, not query mocks.
vi.mock('../src/infrastructure/migrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infrastructure/migrations.js')>()
  const { runSnapshotMigration } = await import('../src/infrastructure/runSnapshotMigration.js')
  return { ...actual, applyApplicationMigrations: async (...args: Parameters<typeof actual.applyApplicationMigrations>) => {
    await actual.applyApplicationMigrations(...args)
    const client = await args[0].connect()
    try {
      await client.query('begin')
      const row = (await client.query<{ relation: string | null }>(
        "select to_regclass(current_schema() || '.run_board_snapshots')::text as relation")).rows[0]!
      if (!row.relation) await client.query(runSnapshotMigration.sql)
      await client.query('commit')
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  } }
})

/** Native-port substitute, not a live harness qualification. It records exact source/child identities. */
class RunChatNative extends AgentChatF5Native {
  override readonly session: NativeSessionReference
  readonly forks: Array<{ source: NativeSessionReference; input: NativeSessionStart }> = []
  readonly attachments: NativeSessionReference[] = []
  readonly steers: NativeSteerInput[] = []
  readonly cancellations: Array<{ session?: string; turn?: string }> = []
  wrongReceipt = false
  returnSource = false
  private reply: NativeHarnessEvent | undefined
  constructor(id: string) { super(); this.session = { harness: 'codex', providerVersion: 'sch06-fixture', nativeSessionId: `child-${id}` } }
  async forkSession(source: NativeSessionReference, input: NativeSessionStart) {
    this.forks.push({ source: structuredClone(source), input: structuredClone(input) })
    return this.returnSource ? source : this.session
  }
  override async attachSession(session: NativeSessionReference) { this.attachments.push(session); return session }
  async steerTurn(session: NativeSessionReference, input: NativeSteerInput) {
    expect(session.nativeSessionId).toBe(this.session.nativeSessionId)
    expect(input.expectedTurnId).toBe(this.nativeTurnId)
    this.steers.push(input); return { nativeTurnId: input.expectedTurnId }
  }
  override async cancel(session?: NativeSessionReference, _signal?: AbortSignal, turn?: string) {
    this.cancellations.push({ ...(session ? { session: session.nativeSessionId } : {}), ...(turn ? { turn } : {}) }); return super.cancel()
  }
  completeReply(text: string) {
    this.reply = NativeHarnessEventSchema.parse({
      sequence: 1, type: 'item.completed', occurredAt: new Date().toISOString(),
      payload: { turnId: this.nativeTurnId,
        item: { id: randomUUID(), type: 'agentMessage', text, phase: 'final_answer' } },
    })
    this.finish({ outcome: 'succeeded', output: { text } })
  }
  override async history() {
    const history = await super.history()
    return this.reply ? { ...history, events: [...history.events, this.reply] } : history
  }
  override async reconcile() {
    const history = await super.reconcile()
    return this.wrongReceipt ? { ...history, nativeTurnId: 'another-runs-turn' } : history
  }
  async dispose() { this.finish({ outcome: 'canceled' }) }
}

async function setup() {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'), approvalNodeIds: [] })
  const repository = new PostgresAgentChatRepository(f.db.pool)
  const native = new Map<string, RunChatNative>()
  const chat = new AgentChatService(f.db.pool, repository, new PostgresOperatorConversationRepository(f.db.pool), f.workflows, f.runs,
    (id) => { const manager = new RunChatNative(id); native.set(id, manager); return manager }, f.db.directory)
  // The shared current-Run fixture already owns its production app. Compose chat on
  // another real authenticated app using the same services/database/native Run reader.
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { ...f.services, agentChat: chat,
      runPlacements: new RunPlacementReadService(f.db.pool, async () => []) } } })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'sch06-integration', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const mcp = await connect(f.writer.token)
    return { f, app, chat, repository, native, connect, mcp,
      async close() {
        await chat.shutdown(); await Promise.allSettled(clients.map((client) => client.close())); await app.close(); await f.close()
      } }
  } catch (error) { await chat.shutdown(); await app.close(); await f.close(); throw error }
}

type Fixture = Awaited<ReturnType<typeof setup>>
function body(result: { isError?: boolean | undefined; structuredContent?: unknown }) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  expect(decodeMcpToolResult(result)).toBeDefined()
  return decodeMcpToolResult(result)
}
function path(target: SelectedRunChatTarget) {
  return `/api/workspaces/${encodeURIComponent(target.workspaceId)}/agent-chat/workflows/${encodeURIComponent(target.workflowId)}`
    + `/runs/${encodeURIComponent(target.runId)}/nodes/${encodeURIComponent(target.workflowNodeId)}`
}
async function terminal(f: Fixture['f'], runId: string) {
  await waitForSuccessfulRunCleanup({ pool: f.db.pool, runId, timeoutMs: 20000,
    readRecord: () => f.services.runs.inspection.record(f.writer.principal, { workspaceId: f.f.scope.workspaceId, runId }) })
}
async function executions(f: Fixture['f'], runId: string): Promise<HarnessExecution[]> {
  const result: HarnessExecution[] = []
  for await (const page of f.runs.executionPages(runId)) result.push(...page)
  return result
}
async function read(f: Fixture, target: SelectedRunChatTarget, executionId?: string, token = f.f.writer.token, mcp = f.mcp) {
  const http = await f.app.inject({ method: 'GET', url: path(target) + (executionId ? `?${new URLSearchParams({ executionId })}` : ''),
    headers: { authorization: `Bearer ${token}` } })
  expect(http.statusCode, http.body).toBe(200)
  expect(http.headers['cache-control']).toBe('private, no-store')
  const { workspaceId, ...selection } = target
  const result = body(await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId,
    selection: { ...selection, ...(executionId ? { executionId } : {}) } } }))
  expect(result).toEqual(http.json())
  return ReadSelectedRunChatResponseSchema.parse(result)
}
async function oldRunRows(f: Fixture['f'], runIds: string[]) {
  return {
    runs: (await f.db.pool.query('select * from runs where id=any($1::text[]) order by id', [runIds])).rows,
    executions: (await f.db.pool.query('select * from harness_executions where run_id=any($1::text[]) order by id', [runIds])).rows,
    sessions: (await f.db.pool.query(`select s.* from execution_native_sessions s join harness_executions e on e.id=s.execution_id
      where e.run_id=any($1::text[]) order by s.execution_id`, [runIds])).rows,
    snapshots: (await f.db.pool.query('select * from run_board_snapshots where run_id=any($1::text[]) order by run_id', [runIds])).rows,
  }
}

async function dispatchScheduledRun(f: Fixture['f']) {
  const { workspaceId, workflowId } = f.f.scope
  await f.locations.set(f.writer.principal, 'http', {
    workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
    runnerId: f.locations.runnerId, rootPath: f.db.directory,
  })
  const due = new Date()
  due.setUTCSeconds(0, 0)
  due.setUTCMinutes(due.getUTCMinutes() + 1)
  const time = { now: new Date(due.getTime() - 1) }
  const clock = () => time.now
  const schedules = new WorkflowScheduleService(f.db.pool, f.commands, clock)
  const saved = await schedules.save(f.writer.principal, 'http', {
    workspaceId, workflowId, commandId: randomUUID(), expectedRevision: 0,
    schedule: { mode: 'once', timezone: 'UTC', localDate: due.toISOString().slice(0, 10),
      time: due.toISOString().slice(11, 16), enabled: true, policy: 'latest_saved' },
  })
  let runId = ''
  const dispatcher = new PostgresScheduleDispatcher(f.db.pool, async (principal, input, schedule) => {
    const accepted = await admitRepeatRun(f.db.pool, f.locations, principal, 'schedule', input,
      repeatStartPublication, { schedule })
    runId = accepted.value.id
  }, clock)
  time.now = new Date(due.getTime() + 1_000)
  await dispatcher.dispatch(saved.value)
  expect(runId).not.toBe('')
  return runId
}

// Real PostgreSQL, common Run admission, immutable snapshots, current Save, authenticated
// HTTP and Operator MCP, existing chat admission/receipts/queue. Only native providers are fixtures.
describe.skipIf(!postgresEnabled)('SCH-06 selected historical Run chat PostgreSQL / HTTP / MCP', () => {
  it.each(['manual', 'schedule'] as const)('reads %s Run computer evidence and a persisted execution chat through HTTP and MCP', async (trigger) => {
    const test = await setup()
    const f = test.f
    try {
      const { workspaceId, workflowId } = f.f.scope
      const runId = trigger === 'schedule' ? await dispatchScheduledRun(f) : f.f.run.id
      const summaries = await f.services.runs.history.list(f.writer.principal, { workspaceId, workflowId })
      expect(summaries.items.find(item => item.runId === runId)?.trigger).toBe(trigger)
      await f.engine.start(runId)
      await terminal(f, runId)
      const source = (await executions(f, runId))[0]!
      expect(source.nativeSessionId).toBeTruthy()
      const unchanged = await oldRunRows(f, [runId])
      const placementScope = { workspaceId, workflowId, runId, nodeId: source.workflowNodeId }
      const placementPath = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
        + `/runs/${runId}/nodes/${source.workflowNodeId}/placement`
      const headers = { authorization: `Bearer ${f.writer.token}` }
      const placement = await test.app.inject({ method: 'GET', url: placementPath, headers })
      expect(placement.statusCode, placement.body).toBe(200)
      expect(placement.json()).toEqual({ ...placementScope,
        readback: { evidence: 'legacy_missing', originalMainInstallationId: null } })
      expect(body(await test.mcp.callTool({ name: 'run_node_placement_get', arguments: placementScope })))
        .toEqual(placement.json())
      const target = { workspaceId, workflowId, runId, workflowNodeId: source.workflowNodeId }
      const initial = await read(test, target, source.id)
      expect(initial.kind).toBe('selected')
      const sent = SendAgentChatMessageResponseSchema.parse(body(await test.mcp.callTool({
        name: 'agent_chat_send', arguments: { workspaceId,
          selection: { workflowId, runId, workflowNodeId: source.workflowNodeId, executionId: source.id },
          message: { requestId: randomUUID(), expectedConversationId: null, content: 'Run follow-up.' } },
      })))
      const conversationId = sent.state.conversation!.id
      await eventually(() => (test.native.get(conversationId)?.prompts.length ?? 0) > 0)
      const native = test.native.get(conversationId)!
      expect(native.forks[0]?.source.nativeSessionId).toBe(source.nativeSessionId)
      native.completeReply('Run reply.')
      await eventually(async () => (await test.repository.turn(conversationId, sent.turn.requestId))?.delivery === 'completed')
      const persisted = await read(test, target, source.id)
      expect(persisted.kind).toBe('selected')
      if (persisted.kind !== 'selected') throw new Error('Expected selected execution chat.')
      expect(persisted.key?.conversationId).toBe(conversationId)
      expect(persisted.state.messages.some(message => message.content === 'Run follow-up.')).toBe(true)
      expect(persisted.state.messages.some(message => message.content === 'Run reply.')).toBe(true)
      const denied = await f.access.issue({ name: 'Other workspace reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000),
        grants: [{ actions: ['runs:read', 'workspace_locations:read', 'agent_chat:read'],
          scope: { workspaceIds: ['other-workspace'] } }],
      })
      const deniedMcp = await test.connect(denied.token)
      for (const [name, input] of [
        ['run_node_placement_get', placementScope],
        ['agent_chat_read', { workspaceId, selection: { workflowId, runId,
          workflowNodeId: source.workflowNodeId, executionId: source.id } }],
      ] as const) {
        const result = await deniedMcp.callTool({ name, arguments: input })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
      }
      expect(await read(test, target, source.id)).toEqual(persisted)
      expect(body(await test.mcp.callTool({ name: 'run_node_placement_get', arguments: placementScope })))
        .toEqual(placement.json())
      expect(await oldRunRows(f, [runId])).toEqual(unchanged)
    } finally { await test.close() }
  }, 90_000)

  it('removed Agent, two Runs, exact child forks, wrong-target receipts, read-only missing sessions, revoked caller, and immutable Run results', async () => {
    const test = await setup(), f = test.f
    try {
      const { workspaceId, workflowId } = f.f.scope
      const y = f.f.version.definition.nodes[1]!
      await f.engine.start(f.f.run.id); await terminal(f, f.f.run.id)
      const a = (await executions(f, f.f.run.id)).find((entry) => entry.workflowNodeId === y.id)!
      expect(a.nativeSessionId).toBeTruthy()
      const location = await f.locations.set(f.writer.principal, 'http', { workspaceId, commandId: randomUUID(),
        expectedLocationRevision: 1, runnerId: f.locations.runnerId, rootPath: f.db.directory })
      const revision = Number((await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [workflowId])).rows[0]!.revision)
      const started = RunStartV3ResultSchema.parse(body(await f.client.callTool({ name: 'run_start', arguments: {
        workspaceId, workflowId, workflowVersionId: f.f.version.id, executionSemanticsVersion: 3,
        commandId: randomUUID(), expectedWorkflowRevision: revision, expectedLocationRevision: location.value.locationRevision,
        expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds, input: {},
      } })))
      await terminal(f, started.run.id)
      const b = (await executions(f, started.run.id)).find((entry) => entry.workflowNodeId === y.id)!
      const runIds = [a.runId, b.runId]
      const unchanged = await oldRunRows(f, runIds)

      // Remove Y with the same typed current-workflow writer used by the product.
      const graph = structuredClone(f.f.version.definition)
      graph.nodes = graph.nodes.filter((entry) => entry.id !== y.id)
      graph.edges = graph.edges.filter((edge) => edge.source !== y.id && edge.target !== y.id)
      graph.executionPolicy = { maxParallelism: 1, maxNodeExecutions: graph.nodes.length }
      if (graph.requiredAgentCount !== undefined) graph.requiredAgentCount = graph.nodes.length
      const currentRevision = Number((await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [workflowId])).rows[0]!.revision)
      const saved = (await f.services.workflows.current.save(f.writer.principal, 'http', {
        workspaceId, workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: currentRevision, expectedWorkflowVersionId: f.f.version.id, expectedLocationRevision: location.value.locationRevision,
        expectedAgentConfigurationVersionIds: Object.fromEntries(graph.nodes.map((node) => [node.agentId, f.f.version.agentConfigurationVersionIds[node.agentId]!])), graph,
      })).value
      expect(saved.version.definition.nodes.some((entry) => entry.id === y.id)).toBe(false)
      await f.db.pool.query('update agents set archived_at=now() where id=$1', [y.agentId])
      const targets = [a, b].map((execution) => ({ workspaceId, workflowId, runId: execution.runId, workflowNodeId: y.id }))
      const headers = { authorization: `Bearer ${f.writer.token}` }
      for (const target of targets) {
        const placementScope = { workspaceId, workflowId, runId: target.runId, nodeId: y.id }
        const placementPath = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
          + `/runs/${target.runId}/nodes/${y.id}/placement`
        const placement = await test.app.inject({ method: 'GET', url: placementPath, headers })
        expect(placement.statusCode, placement.body).toBe(200)
        expect(placement.json()).toEqual({ ...placementScope,
          readback: { evidence: 'legacy_missing', originalMainInstallationId: null } })
        expect(body(await test.mcp.callTool({ name: 'run_node_placement_get', arguments: placementScope })))
          .toEqual(placement.json())
      }
      const discovery = (await test.mcp.listTools()).tools.find((tool) => tool.name === 'agent_chat_read')!
      expect(discovery.inputSchema.properties?.selection).toBeDefined()
      expect(discovery.inputSchema.properties?.history).toBeDefined()
      expect(discovery.outputSchema?.type).toBe('object')
      expect(discovery.annotations?.readOnlyHint).toBe(true)
      expect((await read(test, targets[0]!)).kind).toBe('selected')
      expect(test.native.size).toBe(0)
      const ids: string[] = []
      for (const [index, execution] of [a, b].entries()) {
        const target = targets[index]!
        const message = { requestId: 'same-request-id', content: 'Continue only this historical chat.', expectedConversationId: null }
        const sent = index === 0
          ? await (async () => {
            const response = await test.app.inject({ method: 'POST', url: `${path(target)}/messages`, headers,
              payload: { executionId: execution.id, ...message } })
            expect(response.statusCode, response.body).toBe(202); return response.json()
          })()
          : body(await test.mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId,
            selection: { workflowId, runId: target.runId, workflowNodeId: y.id, executionId: execution.id }, message } }))
        const id = SendAgentChatMessageResponseSchema.parse(sent).state.conversation!.id; ids.push(id)
        await eventually(() => test.native.get(id)?.prompts.length === 1)
        const native = test.native.get(id)!
        expect(native.forks).toHaveLength(1)
        expect(native.forks[0]!.source.nativeSessionId).toBe(execution.nativeSessionId)
        expect(native.session.nativeSessionId).not.toBe(execution.nativeSessionId)
        const start = native.forks[0]!.input
        expect(start.environment).toBeUndefined()
        expect(start.kind).toBe('agent-chat')
        if (start.kind !== 'agent-chat') throw new Error('Expected the Agent conversation owner')
        expect(start.conversationId).toBe(id)
        expect(start.workflowId).toBe(workflowId)
        expect(start.workflowNodeId).toBe(y.id)
        expect(start.configuration.id).toBe(execution.agentConfigurationVersionId)
        expect('request' in start).toBe(false)
        expect(start.instructionsDelivered).toBe(true)
        // A foreign native receipt must not settle this chat or alter its Run.
        native.wrongReceipt = index === 0
        native.finish({ outcome: 'succeeded', output: { continuedInChat: true } })
        await eventually(async () => (await test.repository.turn(id, message.requestId))?.delivery === (index === 0 ? 'unknown' : 'completed'))
        native.wrongReceipt = false
        if (index === 0) { await test.chat.recover(); await eventually(async () => (await test.repository.turn(id, message.requestId))?.delivery === 'completed') }
        const selected = await read(test, target, execution.id)
        expect(selected).toMatchObject({ kind: 'selected', key: { ...target, agentId: y.agentId, executionId: execution.id, conversationId: id } })
      }
      expect(ids[0]).not.toBe(ids[1])
      const promptCount = [...test.native.values()].reduce((count, native) => count + native.prompts.length, 0)
      // Both conversations have the same requestId/content. This must fail BEFORE replay.
      const wrong = await test.app.inject({ method: 'POST', url: `${path(targets[0]!)}/messages`, headers, payload: {
        executionId: a.id, requestId: 'same-request-id', content: 'Continue only this historical chat.', expectedConversationId: ids[1],
      } })
      expect(wrong.statusCode, wrong.body).toBe(409)
      expect(wrong.json()).toMatchObject({ error: { code: 'AGENT_CHAT_CONTEXT_STALE' } })
      const wrongExecution = await test.app.inject({ method: 'GET', url: `${path(targets[0]!)}?${new URLSearchParams({ executionId: b.id })}`, headers })
      expect(wrongExecution.statusCode).toBe(404)
      const mixedInterrupt = await test.app.inject({ method: 'POST', url: `${path(targets[0]!)}/interrupt`, headers, payload: {
        executionId: a.id, agentId: y.agentId, conversationId: ids[1], requestId: randomUUID(),
      } })
      expect(mixedInterrupt.statusCode).toBe(409)
      expect([...test.native.values()].reduce((count, native) => count + native.prompts.length, 0)).toBe(promptCount)
      expect([...test.native.values()].every((native) => native.cancellations.length === 0)).toBe(true)

      // Same services for steering and interrupt, always against the child, not the Run source.
      await test.chat.sendSelectedRun(f.writer.principal, { selection: { ...targets[0]!, executionId: a.id },
        message: { requestId: 'second-turn', content: 'Second chat-only turn.', expectedConversationId: ids[0] } })
      const nativeA = test.native.get(ids[0]!)!
      await eventually(async () => nativeA.prompts.length === 2
        && (await test.repository.get(ids[0]!))?.active_native_turn_id === nativeA.nativeTurnId)
      await test.chat.sendSelectedRun(f.writer.principal, { selection: { ...targets[0]!, executionId: a.id }, message: {
        requestId: 'steer-child', content: 'Steer only the child.', intent: 'steer', expectedConversationId: ids[0], expectedNativeTurnId: nativeA.nativeTurnId,
      } })
      expect(nativeA.steers).toHaveLength(1)
      const interrupted = body(await test.mcp.callTool({ name: 'agent_chat_interrupt', arguments: { workspaceId,
        conversationId: ids[0], requestId: 'stop-child', expectedNativeTurnId: nativeA.nativeTurnId,
        selection: { workflowId, runId: a.runId, workflowNodeId: y.id, agentId: y.agentId, executionId: a.id },
      } }))
      expect(interrupted).toHaveProperty('state')
      await eventually(async () => (await test.repository.turn(ids[0]!, 'second-turn'))?.delivery === 'canceled')
      expect(nativeA.cancellations[0]?.session).toBe(nativeA.session.nativeSessionId)
      expect(nativeA.cancellations[0]?.session).not.toBe(a.nativeSessionId)

      // Losing a previously bound identity is read-only. Existing transcript/receipt routes stay usable.
      await f.db.pool.query('update operator_conversations set native_session_id=null where id=$1', [ids[0]])
      const missing = await read(test, targets[0]!, a.id)
      expect(missing).toMatchObject({ kind: 'selected', state: { sessionState: 'unavailable',
        availability: { canSend: false, reason: 'native_session_missing' }, capabilities: { resume: false } } })
      const paged = ReadSelectedRunChatResponseSchema.parse(body(await test.mcp.callTool({ name: 'agent_chat_read', arguments: {
        workspaceId, selection: { workflowId, runId: a.runId, workflowNodeId: y.id, executionId: a.id }, history: {}, receipts: {},
      } })))
      if (paged.kind !== 'selected') throw new Error('The retained conversation must stay readable')
      const chatRoot = `/api/workspaces/${workspaceId}/agent-chat/conversations/${ids[0]}`
      const history = await test.app.inject({ method: 'GET', url: `${chatRoot}/history`, headers })
      const receipts = await test.app.inject({ method: 'GET', url: `${chatRoot}/turns`, headers })
      expect(history.statusCode).toBe(200); expect(receipts.statusCode).toBe(200)
      expect(paged.history).toEqual(AgentChatHistoryPageSchema.parse(history.json()))
      expect(paged.receipts).toEqual(AgentChatTurnPageSchema.parse(receipts.json()))
      expect(paged.history!.messages.length).toBeGreaterThan(0)
      expect(paged.receipts!.turns.length).toBeGreaterThan(0)

      const allowed = await f.access.issue({ name: 'SCH-06 read-only', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [workspaceId], workflowIds: [workflowId], runIds: [a.runId] } }] })
      const reader = await test.connect(allowed.token)
      await read(test, targets[0]!, a.id, allowed.token, reader)
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_chat_send')
      const denied = await test.app.inject({ method: 'GET', url: path(targets[1]!), headers: { authorization: `Bearer ${allowed.token}` } })
      expect(denied.statusCode).toBe(403)
      const deniedMcp = await reader.callTool({ name: 'agent_chat_read', arguments: { workspaceId,
        selection: { workflowId, runId: b.runId, workflowNodeId: y.id, executionId: b.id } } })
      expect(deniedMcp.isError).toBe(true); expect(deniedMcp.structuredContent).toBeUndefined()
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [allowed.principal.id])
      await expect(test.chat.readSelectedRun(allowed.principal, { selection: { ...targets[0]!, executionId: a.id } }))
        .rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 403 })
      const revoked = await test.app.inject({ method: 'GET', url: path(targets[0]!), headers: { authorization: `Bearer ${allowed.token}` } })
      expect([401, 403]).toContain(revoked.statusCode)
      expect(await oldRunRows(f, runIds)).toEqual(unchanged)
      expect(f.dispatchErrors).toEqual([])
    } finally { await test.close() }
  }, 120000)

  it('preserves the legacy Operator read shape for callers that still use query', async () => {
    const test = await setup(), f = test.f
    try {
      await f.engine.start(f.f.run.id); await terminal(f, f.f.run.id)
      const node = f.f.version.definition.nodes[0]!
      const query = { workflowId: f.f.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId, runId: f.f.run.id }
      const result = body(await test.mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.f.scope.workspaceId, query } }))
      expect(AgentChatStateSchema.parse(result).context).toEqual({ workspaceId: f.f.scope.workspaceId, ...query })
      expect(result).not.toHaveProperty('kind')
      expect(test.native.size).toBe(0)
    } finally { await test.close() }
  }, 60000)
})
