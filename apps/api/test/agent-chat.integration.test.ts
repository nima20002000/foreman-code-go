import { removeFixtureDirectory } from './helpers/testResources.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentConfigurationVersionSchema, CODEX_APPROVAL_OPTIONS_FIXTURE, NativeHarnessEventSchema,
  type ExecutionResult, type HarnessExecution, type NativeSessionReference,
} from '@foreman-code/contracts'
import { AgentChatHistoryPageSchema, AgentChatStateSchema, type AgentChatState, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { NativeTurnNotActiveError } from '../src/modules/harnesses/errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeSteerInput, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

const connectionString = process.env.TEST_DATABASE_URL!

/** Only provider I/O is fake. Migrations, SQL, receipts, authorization, HTTP and MCP are real. */
class FakeNative implements NativeHarnessSessionManager {
  static all: FakeNative[] = []
  created: NativeSessionStart[] = []; attached: NativeSessionStart[] = []; forked: Array<{ source: string; input: NativeSessionStart }> = []
  prompts: string[] = []; steers: NativeSteerInput[] = []; cancels = 0
  hold = false
  private turn = 0
  private readonly histories = new Map<string, NativeHistory>()
  private active: { id: string; correlation: string; release: () => void } | undefined
  constructor(readonly harness: 'codex' | 'opencode', private readonly steering: boolean) { FakeNative.all.push(this) }
  async capabilities() {
    return { provider: this.harness, providerVersion: 'fixture-1', persistentSessions: true, reconnect: true, sameRequestResponses: true,
      cancellation: true, history: true, configurationInspection: false, mcpDetection: false, supportedInteractionKinds: [] }
  }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('unused') }
  async createSession(input: NativeSessionStart): Promise<NativeSessionReference> {
    this.created.push(input)
    return { harness: this.harness, providerVersion: 'fixture-1', nativeSessionId: `native-${randomUUID()}` }
  }
  async attachSession(session: NativeSessionReference, input: NativeSessionStart) { this.attached.push(input); return session }
  async forkSession(source: NativeSessionReference, input: NativeSessionStart): Promise<NativeSessionReference> {
    this.forked.push({ source: source.nativeSessionId, input })
    return { harness: this.harness, providerVersion: 'fixture-1', nativeSessionId: `fork-${randomUUID()}` }
  }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    this.prompts.push(input.prompt)
    const id = `turn-${++this.turn}`
    this.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId, nativeTurnId: id, events: [], pendingInteractions: [] })
    await input.onSubmitted?.(id)
    yield NativeHarnessEventSchema.parse({ sequence: this.turn * 10, type: 'item.completed', occurredAt: new Date().toISOString(),
      payload: { turnId: id, item: { id: `answer-${randomUUID()}`, type: 'agentMessage', text: `reply to ${input.prompt.slice(-20)}`, phase: 'final_answer' } } })
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.active = { id, correlation: input.clientCorrelationId, release: resolve }
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      // A process shutdown aborts the stream without any native terminal evidence.
      if (signal?.aborted) throw new Error('stream aborted by shutdown')
    }
    this.active = undefined
    const history = this.histories.get(input.clientCorrelationId)!
    history.terminalResult ??= { outcome: 'succeeded', output: { text: 'done' } }
  }
  get activeTurn() { return this.active?.id }
  finish(result: ExecutionResult = { outcome: 'succeeded' }) {
    const active = this.active
    if (!active) throw new Error('no active turn')
    this.histories.get(active.correlation)!.terminalResult = result
    active.release()
  }
  async steerTurn(_session: NativeSessionReference, input: NativeSteerInput) {
    if (!this.steering) throw new Error('unused')
    if (!this.active || this.active.id !== input.expectedTurnId) throw new NativeTurnNotActiveError()
    this.steers.push(input)
    return { nativeTurnId: this.active.id }
  }
  async cancel() {
    this.cancels++
    if (!this.active) return false
    this.finish({ outcome: 'canceled' })
    return true
  }
  async pending() { return undefined }
  async respond() {}
  async history() { return { events: [], pendingInteractions: [] } }
  async reconcile(_session: NativeSessionReference, correlationId: string) {
    return this.histories.get(correlationId) ?? { events: [], pendingInteractions: [] }
  }
  async close() {}
}
// OpenCode has no steerTurn: the optional method is absent, exactly like the production adapter.
class FakeOpenCode extends FakeNative { constructor() { super('opencode', false) } }
Object.defineProperty(FakeOpenCode.prototype, 'steerTurn', { value: undefined })

let pool: pg.Pool
let access: PostgresAccessService
let writer: ManagementPrincipal
let readOnlyToken: string
let writerToken: string
let root: string
let fixture: ReturnType<typeof makeCurrentWorkflowFixture>
let codexNode: { id: string; agentId: string }
let openCodeNode: { id: string; agentId: string }
let runExecutions: HarnessExecution[] = []
let runState = 'completed'
let runSourceFixture: ReturnType<typeof makeCurrentWorkflowFixture>
const runReads: string[] = []

function makeService() {
  const managers = new Map<string, FakeNative>()
  const factory = Object.assign((id: string, configuration: { harness: { harness: 'codex' | 'opencode' } }) => {
    const manager = managers.get(id) ?? (configuration.harness.harness === 'codex' ? new FakeNative('codex', true) : new FakeOpenCode())
    managers.set(id, manager); return manager
  }, { release: (id: string) => { managers.delete(id) } })
  const runs = {
    // Read-only fake Run store for the Run-origin path. The service has no write port to it.
    getForWorkspace: async (_workspaceId: string, runId: string) => {
      runReads.push(runId)
      return { ...runSourceFixture.run, id: runId, executionState: runState, workflowVersionId: runSourceFixture.version.id } as never
    },
    async *executionPages() { yield runExecutions },
  }
  const service = new AgentChatService(pool, new PostgresAgentChatRepository(pool), new PostgresOperatorConversationRepository(pool),
    new PostgresWorkflowRepository(pool), runs, factory as never, root)
  return { service, managers }
}

async function settled(service: AgentChatService, state: () => Promise<AgentChatState>, until: (value: AgentChatState) => boolean = (value) =>
  !value.activeTurn && !value.turns.some((turn) => ['queued', 'submitting'].includes(turn.delivery))) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = await state()
    if (until(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  void service
  throw new Error('chat did not settle')
}

function request(node: { id: string; agentId: string }, content: string, expectedConversationId: string | null,
  extra: Partial<SendAgentChatMessageRequest> = {}): SendAgentChatMessageRequest {
  return { requestId: randomUUID(), content, intent: 'next_turn', expectedConversationId,
    context: { workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }, ...extra }
}
const query = (node: { id: string; agentId: string }, runId?: string) =>
  ({ workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId, ...(runId ? { runId } : {}) })

beforeAll(async () => {
  pool = new pg.Pool({ connectionString, max: 8 })
  await applyApplicationMigrations(pool)
  root = await mkdtemp(join(tmpdir(), 'agent-chat-test-'))
  fixture = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential')
  fixture.configurations = fixture.configurations.map((configuration, index) => AgentConfigurationVersionSchema.parse({ ...configuration,
    ...(index === 1 ? { harness: { harness: 'opencode', model: 'fixture/model', variant: 'low', nativeAgent: 'build', thinking: false, autoApprove: false } } : {}),
    prompt: { system: `SYSTEM-${index}` } }))
  fixture = await seedAgent3(pool, root, fixture, { run: false })
  codexNode = fixture.version.definition.nodes[0]!
  openCodeNode = fixture.version.definition.nodes[1]!
  access = new PostgresAccessService(pool)
  const issued = await access.issue({ name: 'agent chat writer', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
  writer = issued.principal; writerToken = issued.token
  const ro = await access.issue({ name: 'agent chat reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ManagementActionSchema.options.filter((action) => action.endsWith(':read')), scope: {} }] })
  readOnlyToken = ro.token
})
afterAll(async () => {
  await pool?.end()
  if (root) await removeFixtureDirectory(root)
})
beforeEach(async () => {
  await pool.query(`delete from operator_conversations where kind='agent' and workspace_id=$1`, [fixture.scope.workspaceId])
  FakeNative.all = []; runExecutions = []; runState = 'completed'; runSourceFixture = fixture; runReads.length = 0
})

describe('selected-Agent chat service', { timeout: 60_000 }, () => {
  it('keeps later accepted-turn reconciliation idempotent while preserving the initial startup receipt', async () => {
    const { service } = makeService()
    const first = request(codexNode, 'first', null)
    const initial = await service.send(writer, fixture.scope.workspaceId, first)
    const id = initial.state.conversation!.id
    const read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
    await settled(service, read)
    const native = FakeNative.all[0]!
    native.hold = true
    try {
      await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'later', id))
      const active = await settled(service, read, state => Boolean(state.activeTurn?.nativeTurnId && native.activeTurn))
      const repository = new PostgresAgentChatRepository(pool)
      const before = (await repository.get(id))!
      expect(before.record.startupReceipt).toEqual({ requestId: first.requestId, nativeSessionId: before.native_session_id })
      expect(active.activeTurn!.requestId).not.toBe(first.requestId)
      for (let observation = 0; observation < 2; observation++) {
        expect(await repository.accepted(id, active.activeTurn!.requestId, active.activeTurn!.nativeTurnId!)).toBe(false)
      }
      const after = (await repository.get(id))!
      expect(after.revision).toBe(before.revision)
      expect(after.updated_at).toEqual(before.updated_at)
      expect(after.record.startupReceipt).toEqual(before.record.startupReceipt)
      expect((await repository.turn(id, active.activeTurn!.requestId))?.delivery).toBe('accepted')
      expect(native.prompts).toHaveLength(2)
    } finally { await service.shutdown() }
  })

  it('creates exactly one native session on first send and continues it after completion', async () => {
    const { service } = makeService()
    const empty = await service.read(writer, fixture.scope.workspaceId, query(codexNode))
    expect(empty).toMatchObject({ conversation: null, sessionState: 'none', availability: { canSend: true } })
    const first = request(codexNode, 'hello', null)
    const [a, b] = await Promise.all([service.send(writer, fixture.scope.workspaceId, first), service.send(writer, fixture.scope.workspaceId, first)])
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
    const read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
    const done = await settled(service, read)
    const native = FakeNative.all[0]!
    expect(FakeNative.all).toHaveLength(1)
    expect(native.created).toHaveLength(1)
    expect(done.turns.map((turn) => turn.delivery)).toEqual(['completed'])
    expect(done.conversation?.nativeSession?.nativeSessionId).toMatch(/^native-/)
    // Startup system prompt is native developer instructions for Codex, never repeated in the user prompt.
    expect(native.created[0]).toMatchObject({ instructionsDelivered: false })
    expect(native.prompts[0]).toBe('hello')
    await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'again', done.conversation!.id))
    const second = await settled(service, read)
    expect(native.created).toHaveLength(1)
    expect(second.turns.map((turn) => turn.delivery)).toEqual(['completed', 'completed'])
    expect(second.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(AgentChatStateSchema.parse(second).conversation?.id).toBe(done.conversation!.id)
  })

  it('sends OpenCode startup instructions once and resumes without them after restart', async () => {
    const first = makeService()
    const read = (service: AgentChatService) => () => service.read(writer, fixture.scope.workspaceId, query(openCodeNode))
    await first.service.send(writer, fixture.scope.workspaceId, request(openCodeNode, 'one', null))
    const one = await settled(first.service, read(first.service))
    await first.service.send(writer, fixture.scope.workspaceId, request(openCodeNode, 'two', one.conversation!.id))
    await settled(first.service, read(first.service))
    expect(FakeNative.all[0]!.prompts[0]).toContain('SYSTEM-1')
    expect(FakeNative.all[0]!.prompts[1]).toBe('two')
    await first.service.shutdown()
    const restarted = makeService()
    await restarted.service.send(writer, fixture.scope.workspaceId, request(openCodeNode, 'three', one.conversation!.id))
    await settled(restarted.service, read(restarted.service))
    const resumed = FakeNative.all.at(-1)!
    expect(resumed.created).toHaveLength(0)
    expect(resumed.attached).toHaveLength(1)
    expect(resumed.attached[0]).toMatchObject({ instructionsDelivered: true })
    expect(resumed.prompts).toEqual(['three'])
  })

  it('queues next turns FIFO, cancels a queued turn and runs interrupt-and-send once ahead of the queue', async () => {
    const { service } = makeService()
    const read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
    const workspace = fixture.scope.workspaceId
    const first = await service.send(writer, workspace, request(codexNode, 'long', null))
    const conversationId = first.state.conversation!.id
    await settled(service, read, (value) => value.turns[0]?.delivery === 'completed')
    const native = FakeNative.all[0]!
    native.hold = true
    await service.send(writer, workspace, request(codexNode, 'hold me', conversationId))
    await settled(service, read, (value) => Boolean(value.activeTurn?.nativeTurnId)
      && native.activeTurn === value.activeTurn?.nativeTurnId && value.activeTurn?.requestId !== first.turn.requestId)
    const queuedA = await service.send(writer, workspace, request(codexNode, 'queued A', conversationId))
    const queuedB = await service.send(writer, workspace, request(codexNode, 'queued B', conversationId))
    expect(queuedA.turn.delivery).toBe('queued')
    await service.cancelQueued(writer, workspace, conversationId, queuedB.turn.requestId, { requestId: randomUUID() })
    native.hold = false
    const urgent = await service.send(writer, workspace, request(codexNode, 'urgent', conversationId, { intent: 'interrupt_and_send' }))
    const done = await settled(service, read)
    const byId = new Map(done.turns.map((turn) => [turn.requestId, turn.delivery]))
    expect(byId.get(queuedB.turn.requestId)).toBe('canceled')
    expect(byId.get(urgent.turn.requestId)).toBe('completed')
    expect(byId.get(queuedA.turn.requestId)).toBe('completed')
    expect(native.cancels).toBe(1)
    // The interrupted turn is never replayed and urgent input is submitted exactly once, before queued A.
    expect(native.prompts).toEqual(['long', 'hold me', 'urgent', 'queued A'])
    expect(done.turns.find((turn) => turn.intent === 'next_turn' && turn.delivery === 'canceled' && turn.nativeTurnId)).toBeDefined()
  })

  it('steers only the exact active Codex turn and leaves no receipt for a rejected steer', async () => {
    const { service } = makeService()
    const workspace = fixture.scope.workspaceId
    const read = () => service.read(writer, workspace, query(codexNode))
    const first = await service.send(writer, workspace, request(codexNode, 'warm', null))
    await settled(service, read)
    const native = FakeNative.all[0]!
    native.hold = true
    await service.send(writer, workspace, request(codexNode, 'work', first.state.conversation!.id))
    const active = await settled(service, read, (value) => Boolean(value.activeTurn?.nativeTurnId) && native.activeTurn === value.activeTurn?.nativeTurnId)
    const steer = await service.send(writer, workspace, request(codexNode, 'focus', active.conversation!.id,
      { intent: 'steer', expectedNativeTurnId: active.activeTurn!.nativeTurnId! }))
    expect(steer.turn).toMatchObject({ intent: 'steer', delivery: 'accepted', targetNativeTurnId: active.activeTurn!.nativeTurnId })
    await expect(service.send(writer, workspace, request(codexNode, 'stale', active.conversation!.id,
      { intent: 'steer', expectedNativeTurnId: 'turn-old' }))).rejects.toMatchObject({ code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
    native.finish()
    const done = await settled(service, read)
    expect(native.steers.map((entry) => entry.prompt)).toEqual(['focus'])
    expect(done.turns.find((turn) => turn.requestId === steer.turn.requestId)?.delivery).toBe('completed')
    expect(done.messages.some((message) => message.content === 'stale')).toBe(false)
  })

  it('reports OpenCode steering as unavailable and refuses it honestly', async () => {
    const { service } = makeService()
    const state = await service.read(writer, fixture.scope.workspaceId, query(openCodeNode))
    expect(state.capabilities).toMatchObject({ steer: 'unavailable', interruptAndSend: true })
    expect(state.capabilities.unavailable.steer).toBeTruthy()
  })

  it('replays an identical request, rejects a conflicting one and a stale conversation expectation', async () => {
    const { service } = makeService()
    const workspace = fixture.scope.workspaceId
    const first = request(codexNode, 'same', null)
    const accepted = await service.send(writer, workspace, first)
    await settled(service, () => service.read(writer, workspace, query(codexNode)))
    const replay = await service.send(writer, workspace, first)
    expect(replay).toMatchObject({ replayed: true, turn: { requestId: first.requestId, delivery: 'completed' } })
    await expect(service.send(writer, workspace, { ...first, content: 'different' })).rejects.toMatchObject({ code: 'AGENT_CHAT_REQUEST_CONFLICT' })
    await expect(service.send(writer, workspace, request(codexNode, 'stale', null))).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
    expect(FakeNative.all[0]!.prompts).toEqual(['same'])
    expect(accepted.state.conversation?.id).toBeTruthy()
  })

  it('keeps concurrent Agent conversations isolated', async () => {
    const { service } = makeService()
    const workspace = fixture.scope.workspaceId
    await Promise.all([service.send(writer, workspace, request(codexNode, 'for codex', null)),
      service.send(writer, workspace, request(openCodeNode, 'for opencode', null))])
    const [codex, opencode] = await Promise.all([settled(service, () => service.read(writer, workspace, query(codexNode))),
      settled(service, () => service.read(writer, workspace, query(openCodeNode)))])
    expect(codex.conversation!.id).not.toBe(opencode.conversation!.id)
    expect(codex.conversation!.nativeSession!.nativeSessionId).not.toBe(opencode.conversation!.nativeSession!.nativeSessionId)
    expect(codex.messages.map((message) => message.content)).not.toContain('for opencode')
    expect(opencode.messages.map((message) => message.content)).not.toContain('for codex')
  })

  it('blocks chat for an active Run and forks a finished Run session without writing the Run', async () => {
    const { service } = makeService()
    const workspace = fixture.scope.workspaceId
    // Real Run and execution rows (the conversation references them); reads still go through the fake read port.
    const runFixture = await seedAgent3(pool, root, makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'))
    const runId = runFixture.run.id
    const executionId = `exec-${randomUUID()}`
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)`,
      [executionId, runId, runFixture.version.definition.nodes[0]!.id, runFixture.version.definition.nodes[0]!.agentId,
        JSON.stringify({ id: executionId, runId, workflowNodeId: runFixture.version.definition.nodes[0]!.id, agentId: runFixture.version.definition.nodes[0]!.agentId,
          agentConfigurationVersionId: runFixture.version.agentConfigurationVersionIds[runFixture.version.definition.nodes[0]!.agentId],
          attempt: 1, input: {}, state: 'queued', createdAt: runFixture.createdAt })])
    runState = 'running'
    const blocked = await service.read(writer, workspace, query(codexNode, runId))
    expect(blocked.availability).toMatchObject({ canSend: false, reason: 'run_active' })
    await expect(service.send(writer, workspace, { ...request(codexNode, 'x', null), context: query(codexNode, runId) }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_UNAVAILABLE' })
    runState = 'completed'
    const missing = await service.read(writer, workspace, query(codexNode, runId))
    expect(missing.availability).toMatchObject({ canSend: false, reason: 'native_session_missing' })
    runExecutions = [{ id: executionId, runId, workflowNodeId: codexNode.id, agentId: codexNode.agentId,
      agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[codexNode.agentId]!, attempt: 1,
      nativeSessionId: 'run-thread-1', workingDirectory: root, input: {}, state: 'completed', result: { outcome: 'succeeded' },
      createdAt: fixture.createdAt, finishedAt: fixture.createdAt }]
    const before = await pool.query(`select (select record::text from runs where id=$1) as run,
      (select record::text from harness_executions where id=$2) as execution`, [runId, executionId])
    await service.send(writer, workspace, { ...request(codexNode, 'what did you do?', null), context: query(codexNode, runId) })
    const done = await settled(service, () => service.read(writer, workspace, query(codexNode, runId)))
    const native = FakeNative.all[0]!
    expect(native.forked).toEqual([expect.objectContaining({ source: 'run-thread-1' })])
    expect(native.forked[0]!.input).toMatchObject({ instructionsDelivered: true })
    expect(native.created).toHaveLength(0)
    expect(done.conversation).toMatchObject({ origin: { kind: 'run_execution', runId, sourceNativeSessionId: 'run-thread-1' } })
    expect(done.conversation!.nativeSession!.nativeSessionId).not.toBe('run-thread-1')
    expect(native.prompts).toEqual(['what did you do?'])
    expect((await pool.query(`select (select record::text from runs where id=$1) as run,
      (select record::text from harness_executions where id=$2) as execution`, [runId, executionId])).rows[0]).toEqual(before.rows[0])
    // The same Agent without a Run is a different, isolated conversation.
    expect((await service.read(writer, workspace, query(codexNode))).conversation).toBeNull()
  })

  it('A-R07 never resends an in-flight turn after restart and fences queued work until terminal evidence', async () => {
    const first = makeService()
    const workspace = fixture.scope.workspaceId
    const read = (service: AgentChatService) => () => service.read(writer, workspace, query(codexNode))
    const warm = await first.service.send(writer, workspace, request(codexNode, 'warm', null))
    await settled(first.service, read(first.service))
    FakeNative.all[0]!.hold = true
    const inflight = await first.service.send(writer, workspace, request(codexNode, 'inflight', warm.state.conversation!.id))
    await settled(first.service, read(first.service), (value) => Boolean(value.activeTurn?.nativeTurnId))
    const queued = await first.service.send(writer, workspace, request(codexNode, 'after restart', warm.state.conversation!.id))
    await first.service.shutdown()
    const restarted = makeService()
    await restarted.service.recover()
    const unknown = await read(restarted.service)()
    const byId = new Map(unknown.turns.map((turn) => [turn.requestId, turn.delivery]))
    expect(byId.get(inflight.turn.requestId), JSON.stringify(unknown.turns)).toBe('unknown')
    expect(byId.get(queued.turn.requestId)).toBe('queued')
    expect(unknown.activeTurn?.requestId).toBe(inflight.turn.requestId)
    // Native storage becomes readable later. The periodic repair must not need another restart or send.
    const resumed = FakeNative.all.at(-1)!
    const previousReconcile = resumed.reconcile.bind(resumed)
    const correlationId = agentChatCorrelation(warm.state.conversation!.id, inflight.turn.requestId)
    resumed.reconcile = async (session, correlation) => correlation === correlationId
      ? { correlationId, nativeTurnId: unknown.activeTurn!.nativeTurnId!, events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } }
      : previousReconcile(session, correlation)
    const done = await settled(restarted.service, read(restarted.service))
    for (const turn of done.turns) byId.set(turn.requestId, turn.delivery)
    expect(byId.get(inflight.turn.requestId)).toBe('completed')
    expect(byId.get(queued.turn.requestId), JSON.stringify(done.turns)).toBe('completed')
    expect(FakeNative.all.flatMap((native) => native.prompts).filter((prompt) => prompt === 'inflight')).toHaveLength(1)
  })

  it('A-R09/A-R10/A-R20 recovers the exact Codex answer once through HTTP history/state and MCP', async () => {
    const repository = new PostgresAgentChatRepository(pool)
    const workspaceId = fixture.scope.workspaceId
    const input = request(codexNode, 'answer before the crash', null)
    const context = { workspaceId, ...input.context }
    const admitted = await repository.admit({ key: agentChatKey(context), request: input, context, delivery: 'queued', create: {
      context, agentConfigurationVersionId: fixture.configurations[0]!.id, harness: 'codex', origin: { kind: 'fresh' },
      workingDirectory: root, runtimeDirectory: '',
    } })
    const id = admitted.conversationId
    expect(await repository.claim(id, input.requestId)).toBe(true)
    expect(await repository.beginSessionCreation(id, input.requestId)).toBe(true)
    const nativeSessionId = `recovered-session-${randomUUID()}`
    await repository.bindSession(id, 'fixture-1', nativeSessionId)
    await repository.accepted(id, input.requestId, 'recovered-turn')
    // Model the old acknowledgement-boundary crash: the provider accepted, but the app saved no answer/startup flag.
    await pool.query(`update operator_conversations set record=record-'startupDelivered'-'startupReceipt' where id=$1`, [id])
    const { service, managers } = makeService()
    const native = new FakeNative('codex', true)
    const correlationId = agentChatCorrelation(id, input.requestId)
    native.reconcile = async (_session, correlation) => correlation === correlationId
      ? { correlationId, nativeTurnId: 'recovered-turn', nativeMessageId: 'recovered-answer', events: [], pendingInteractions: [],
          terminalResult: { outcome: 'succeeded', output: { text: 'RECOVERED-EXACT-ANSWER\nsecond line' } } }
      : { events: [], pendingInteractions: [] }
    managers.set(id, native)
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const client = new Client({ name: 'agent-chat-f2-recovery', version: '1' })
    try {
      await service.recover()
      await service.recover()
      expect(native.attached).toHaveLength(1)
      expect(native.attached[0]).toMatchObject({ nativeTurnId: 'recovered-turn', instructionsDelivered: true })
      expect(native.created).toHaveLength(0)
      expect(native.prompts).toHaveLength(0)
      expect((await repository.get(id))!.record).toMatchObject({ startupDelivered: true,
        startupReceipt: { requestId: input.requestId, nativeSessionId } })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const base = `/api/workspaces/${workspaceId}/agent-chat`
      const stateReply = await app.inject({ method: 'GET', url: `${base}?workflowId=${fixture.scope.workflowId}&workflowNodeId=${codexNode.id}&agentId=${codexNode.agentId}`,
        headers: { authorization: `Bearer ${readOnlyToken}` } })
      expect(stateReply.statusCode).toBe(200)
      const state = AgentChatStateSchema.parse(stateReply.json())
      expect(state.turns[0]).toMatchObject({ requestId: input.requestId, delivery: 'completed', nativeTurnId: 'recovered-turn' })
      const answers = state.messages.filter((message) => message.role === 'assistant')
      expect(answers).toHaveLength(1)
      expect(answers[0]).toMatchObject({ nativeMessageId: 'recovered-answer', content: 'RECOVERED-EXACT-ANSWER\nsecond line' })
      const historyReply = await app.inject({ method: 'GET', url: `${base}/conversations/${id}/history?limit=100`,
        headers: { authorization: `Bearer ${readOnlyToken}` } })
      expect(historyReply.statusCode).toBe(200)
      expect(AgentChatHistoryPageSchema.parse(historyReply.json()).messages).toEqual(state.messages)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => readOnlyToken } }))
      const read = await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query: query(codexNode) } })
      expect(AgentChatStateSchema.parse(read.structuredContent).messages).toEqual(state.messages)
      const denied = await app.inject({ method: 'POST', url: `${base}/messages`, headers: { authorization: `Bearer ${readOnlyToken}` },
        payload: request(codexNode, 'must not send', id) })
      expect(denied.statusCode).toBe(403)
      await expect(client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: request(codexNode, 'must not send via mcp', id) } })).rejects.toThrow(/not found/)
      expect((await repository.state(id))!.messages).toEqual(state.messages)
      expect(native.prompts).toHaveLength(0)
    } finally {
      await client.close().catch(() => undefined)
      await app.close()
      await service.shutdown()
    }
  })

  it('serves HTTP and Operator MCP on the same service with scope checks and persisted readback', async () => {
    const { service } = makeService()
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const url = `/api/workspaces/${fixture.scope.workspaceId}/agent-chat`
      const denied = await app.inject({ method: 'POST', url: `${url}/messages`, headers: { authorization: `Bearer ${readOnlyToken}` },
        payload: request(codexNode, 'nope', null) })
      expect(denied.statusCode, denied.body).toBe(403)
      const sent = await app.inject({ method: 'POST', url: `${url}/messages`, headers: { authorization: `Bearer ${writerToken}` },
        payload: request(codexNode, 'via http', null) })
      expect(sent.statusCode).toBe(202)
      const connect = async (token: string) => {
        const client = new Client({ name: 'agent-chat-test', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const mcp = await connect(writerToken)
      const tools = (await mcp.listTools()).tools.map((tool) => tool.name)
      expect(tools).toEqual(expect.arrayContaining(['agent_chat_read', 'agent_chat_send', 'agent_chat_interrupt', 'agent_chat_cancel_queued', 'agent_chat_respond']))
      const reader = await connect(readOnlyToken)
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_chat_send')
      await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
      const read = await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: fixture.scope.workspaceId, query: query(codexNode) } })
      const state = AgentChatStateSchema.parse(read.structuredContent)
      const sendResult = await mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId,
        request: request(codexNode, 'via mcp', state.conversation!.id) } })
      expect(sendResult.isError).not.toBe(true)
      // A read-only caller does not get the write tool at all; calling it is refused.
      await expect(reader.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId,
        request: request(codexNode, 'denied mcp', state.conversation!.id) } })).rejects.toThrow(/not found/)
      const final = await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
      const readback = await app.inject({ method: 'GET', url: `${url}?workflowId=${fixture.scope.workflowId}&workflowNodeId=${codexNode.id}&agentId=${codexNode.agentId}`,
        headers: { authorization: `Bearer ${readOnlyToken}` } })
      expect(readback.statusCode).toBe(200)
      const persisted = AgentChatStateSchema.parse(readback.json())
      expect(persisted.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['via http', 'via mcp'])
      expect(persisted.turns).toEqual(final.turns)
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()))
      await app.close()
    }
  })
})

/** F4 regressions: authenticated transports and durable SQL are real; native/Run
 * read ports retain this suite's fakes. Real native/Run proof lives in the opt-in
 * agent-chat-run-native.acceptance.test.ts, not in these tests.
 */
async function f4Transport(service: AgentChatService) {
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  return { app, address, async connect(token: string) {
    const client = new Client({ name: 'f4-regression', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }, async close() { await Promise.allSettled(clients.map((client) => client.close())); await app.close(); await service.shutdown() } }
}
async function f4Rows(id: string) {
  return (await pool.query(`select
    (select to_jsonb(c) from operator_conversations c where id=$1) as conversation,
    (select jsonb_agg(to_jsonb(t) order by request_id) from operator_conversation_turns t where conversation_id=$1) as turns,
    (select jsonb_agg(to_jsonb(m) order by sequence) from operator_conversation_messages m where conversation_id=$1) as messages,
    (select jsonb_agg(to_jsonb(r) order by command_id) from management_command_receipts r
      where operation='agent_chat_control' and target_key=$1) as controls`, [id])).rows[0]
}

describe('F4 authenticated transport / persistence regressions', { timeout: 60_000 }, () => {
  for (const dimension of ['workspaceIds', 'workflowIds', 'runIds'] as const) {
    it(`A-R02 ${dimension}: HTTP/SSE/MCP matching scope works, mismatch has no effect`, async () => {
      const { service } = makeService()
      let runId: string | undefined
      let scopedNode = codexNode
      let scopedWorkspaceId = fixture.scope.workspaceId
      let scopedWorkflowId = fixture.scope.workflowId
      if (dimension === 'runIds') {
        const origin = await seedAgent3(pool, root, makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'))
        runSourceFixture = origin
        runId = origin.run.id
        scopedNode = origin.version.definition.nodes[0]!
        scopedWorkspaceId = origin.scope.workspaceId
        scopedWorkflowId = origin.scope.workflowId
        const executionId = `f4-execution-${randomUUID()}`
        const record: HarnessExecution = { id: executionId, runId, workflowNodeId: scopedNode.id, agentId: scopedNode.agentId,
          agentConfigurationVersionId: origin.version.agentConfigurationVersionIds[scopedNode.agentId]!, attempt: 1,
          nativeSessionId: 'f4-source', workingDirectory: root, input: {}, state: 'completed',
          result: { outcome: 'succeeded' }, createdAt: origin.createdAt, finishedAt: origin.createdAt }
        await pool.query('insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)',
          [executionId, runId, scopedNode.id, scopedNode.agentId, JSON.stringify(record)])
        runExecutions = [record]
      }
      const context = { ...query(scopedNode, runId), workflowId: scopedWorkflowId }
      const input = request(scopedNode, 'scoped conversation', null, { context })
      const first = await service.send(writer, scopedWorkspaceId, input)
      const id = first.state.conversation!.id
      await settled(service, () => service.read(writer, scopedWorkspaceId, context))
      const f = await f4Transport(service)
      const path = `/api/workspaces/${scopedWorkspaceId}/agent-chat`
      const resource = dimension === 'workspaceIds' ? scopedWorkspaceId : dimension === 'workflowIds' ? scopedWorkflowId : runId!
      try {
        for (const matching of [true, false]) {
          const credential = await access.issue({ name: `F4 ${dimension} ${matching}`, audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
            grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond'], scope: { [dimension]: [matching ? resource : 'other'] } }] })
          const headers = { authorization: `Bearer ${credential.token}` }
          const before = await f4Rows(id)
          for (const url of [`${path}?${new URLSearchParams(Object.entries(context).filter((entry): entry is [string, string] => entry[1] !== undefined))}`, `${path}/conversations/${id}/history`]) {
            const response = await f.app.inject({ method: 'GET', url, headers })
            expect(response.statusCode, response.body).toBe(matching ? 200 : 403)
          }
          const replay = await f.app.inject({ method: 'POST', url: `${path}/messages`, headers, payload: input })
          expect(replay.statusCode, replay.body).toBe(matching ? 200 : 403)
          const mcp = await f.connect(credential.token)
          expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['agent_chat_read', 'agent_chat_send',
            'agent_chat_interrupt', 'agent_chat_cancel_queued', 'agent_chat_respond']))
          const read = await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: scopedWorkspaceId, query: context } })
          expect(read.isError === true).toBe(!matching)
          if (matching) expect(AgentChatStateSchema.parse(read.structuredContent).conversation?.id).toBe(id)
          const controller = new AbortController()
          try {
            const stream = await fetch(`${f.address}${path}/conversations/${id}/events`, { headers,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) })
            expect(stream.status).toBe(matching ? 200 : 403)
            if (matching) {
              const reader = stream.body!.getReader()
              try {
                let frames = ''
                while (!frames.includes(': heartbeat')) {
                  const chunk = await reader.read()
                  if (chunk.done) throw new Error('Scoped stream closed before its reauthorized heartbeat.')
                  frames += new TextDecoder().decode(chunk.value)
                }
                expect(frames).toContain('event: snapshot')
              } finally { await reader.cancel() }
            } else { await stream.text() }
          } finally { controller.abort() }
          expect(await f4Rows(id)).toEqual(before)
        }
      } finally { await f.close() }
    }, 30_000)
  }

  it('A-R03 action-only callers cannot disclose command state or mutate before a denied response, over HTTP and MCP', async () => {
    const { service } = makeService()
    const initial = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'protected transcript', null))
    const id = initial.state.conversation!.id
    await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
    const f = await f4Transport(service)
    const path = `/api/workspaces/${fixture.scope.workspaceId}/agent-chat`
    try {
      const native = FakeNative.all[0]!
      for (const action of ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond'] as const) {
        const credential = await access.issue({ name: `F4 ${action}`, audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
          grants: [{ actions: [action], scope: { workspaceIds: [fixture.scope.workspaceId] } }] })
        const headers = { authorization: `Bearer ${credential.token}` }
        const before = await f4Rows(id), calls = { prompts: native.prompts.length, cancels: native.cancels }
        const commands = [
          { tool: 'agent_chat_send', suffix: '/messages', body: request(codexNode, 'denied', id) },
          { tool: 'agent_chat_interrupt', suffix: `/conversations/${id}/interrupt`, body: { requestId: randomUUID() } },
          { tool: 'agent_chat_cancel_queued', suffix: `/conversations/${id}/turns/${initial.turn.requestId}/cancel`, body: { requestId: randomUUID() } },
          { tool: 'agent_chat_respond', suffix: `/conversations/${id}/responses`, body: { requestId: randomUUID(), nativeRequestId: 'approval', optionId: 'accept' } },
        ]
        const mcp = await f.connect(credential.token)
        const available = (await mcp.listTools()).tools.map((tool) => tool.name)
        for (const command of commands) {
          const response = await f.app.inject({ method: 'POST', url: `${path}${command.suffix}`, headers, payload: command.body })
          expect(response.statusCode, response.body).toBe(403)
          expect(response.body).not.toContain('protected transcript')
          expect(available).not.toContain(command.tool)
          await expect(mcp.callTool({ name: command.tool, arguments: { workspaceId: fixture.scope.workspaceId, conversationId: id,
            ...(command.tool === 'agent_chat_send' ? { request: command.body } : command.body) } })).rejects.toThrow(/not found/)
        }
        const history = await f.app.inject({ method: 'GET', url: `${path}/conversations/${id}/history`, headers })
        expect(history.statusCode).toBe(action === 'agent_chat:read' ? 200 : 403)
        expect(await f4Rows(id)).toEqual(before)
        expect({ prompts: native.prompts.length, cancels: native.cancels }).toEqual(calls)
      }
    } finally { await f.close() }
  })

  it('A-R12 lost cancel/respond/interrupt responses replay original SQL receipts across HTTP/MCP and conflict before native effects', async () => {
    const { service } = makeService()
    const initial = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'warm', null))
    const id = initial.state.conversation!.id, read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
    await settled(service, read)
    const native = FakeNative.all[0]!
    native.hold = true
    await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'active', id))
    const active = await settled(service, read, (state) => Boolean(state.activeTurn?.nativeTurnId && native.activeTurn))
    const queued = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'queued', id))
    const f = await f4Transport(service), mcp = await f.connect(writerToken)
    const path = `/api/workspaces/${fixture.scope.workspaceId}/agent-chat/conversations/${id}`
    const headers = { authorization: `Bearer ${writerToken}` }
    const http = (suffix: string, body: Record<string, unknown>) => f.app.inject({ method: 'POST', url: `${path}${suffix}`, headers, payload: body })
    const replay = (name: string, body: Record<string, unknown>) => mcp.callTool({ name, arguments: { workspaceId: fixture.scope.workspaceId, conversationId: id, ...body } })
    const receipt = async (commandId: string) => (await pool.query(`select target_key,input_hash,result from management_command_receipts
      where principal_id=$1 and operation='agent_chat_control' and command_id=$2`, [writer.id, commandId])).rows[0]
    const conflict = async (suffix: string, name: string, body: Record<string, unknown>, addressing = {}) => {
      const response = await http(suffix, body)
      expect(response.statusCode, response.body).toBe(409)
      expect(response.body).toContain('AGENT_CHAT_REQUEST_CONFLICT')
      const result = await replay(name, { ...addressing, ...body })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('AGENT_CHAT_REQUEST_CONFLICT')
    }
    try {
      const cancel = { requestId: randomUUID() }, cancelPath = `/turns/${queued.turn.requestId}/cancel`
      const canceled = await http(cancelPath, cancel)
      expect(canceled.statusCode, canceled.body).toBe(200)
      const cancelReceipt = await receipt(cancel.requestId)
      const later = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'later queued', id))
      expect((await replay('agent_chat_cancel_queued', { ...cancel, turnRequestId: queued.turn.requestId })).structuredContent).toEqual({ state: await read() })
      expect(await receipt(cancel.requestId)).toEqual(cancelReceipt)
      expect(cancelReceipt.result).toMatchObject({ status: 'completed', state: { conversation: { id },
        turns: expect.arrayContaining([expect.objectContaining({ requestId: queued.turn.requestId, delivery: 'canceled' })]) } })
      await conflict(`/turns/${later.turn.requestId}/cancel`, 'agent_chat_cancel_queued', cancel, { turnRequestId: later.turn.requestId })
      expect((await read()).turns.find((turn) => turn.requestId === later.turn.requestId)?.delivery).toBe('queued')
      let responses = 0
      native.respond = async () => { responses++ }
      const repository = new PostgresAgentChatRepository(pool)
      const pending = { session: { harness: 'codex' as const, providerVersion: 'fixture-1', nativeSessionId: active.conversation!.nativeSession!.nativeSessionId },
        turn: { nativeTurnId: active.activeTurn!.nativeTurnId!, nativeRequestId: 'approval-one' }, nativeRequestType: 'approval', request: {},
        responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }
      await repository.pending(id, active.activeTurn!.requestId, pending)
      const respond = { requestId: randomUUID(), nativeRequestId: 'approval-one', optionId: 'codex-approve-once' }
      const responded = await http('/responses', respond)
      expect(responded.statusCode, responded.body).toBe(200)
      const respondReceipt = await receipt(respond.requestId)
      await repository.pending(id, active.activeTurn!.requestId, { ...pending, turn: { ...pending.turn, nativeRequestId: 'approval-two' } })
      expect((await replay('agent_chat_respond', respond)).structuredContent).toEqual({ state: await read() })
      expect(await receipt(respond.requestId)).toEqual(respondReceipt)
      expect(respondReceipt.result).toMatchObject({ status: 'completed', acceptedControl: { modelRequestId: active.activeTurn!.requestId,
        native: { sessionId: pending.session.nativeSessionId, turnId: pending.turn.nativeTurnId, requestId: 'approval-one' } } })
      await conflict('/responses', 'agent_chat_respond', { ...respond, optionId: 'codex-reject' })
      expect(responses).toBe(1)
      expect((await read()).pendingInteraction?.turn.nativeRequestId).toBe('approval-two')
      const interrupt = { requestId: randomUUID() }
      const interrupted = await http('/interrupt', interrupt)
      expect(interrupted.statusCode, interrupted.body).toBe(200)
      const interruptReceipt = await receipt(interrupt.requestId)
      await settled(service, read)
      await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'later active', id))
      const next = await settled(service, read, (state) => Boolean(state.activeTurn?.nativeTurnId && native.activeTurn))
      expect((await replay('agent_chat_interrupt', interrupt)).structuredContent).toEqual({ state: await read() })
      expect(await receipt(interrupt.requestId)).toEqual(interruptReceipt)
      expect(interruptReceipt.result).toMatchObject({ status: 'completed', state: { conversation: { id },
        turns: expect.arrayContaining([expect.objectContaining({ requestId: active.activeTurn!.requestId, nativeTurnId: active.activeTurn!.nativeTurnId })]) } })
      await conflict('/interrupt', 'agent_chat_interrupt', { ...interrupt, expectedNativeTurnId: next.activeTurn!.nativeTurnId! })
      expect(native.cancels).toBe(1)
      expect((await read()).activeTurn?.requestId).toBe(next.activeTurn?.requestId)
      const receipts = (await pool.query<{ result: { status: string } }>(`select result from management_command_receipts
        where principal_id=$1 and operation='agent_chat_control' and target_key=$2`, [writer.id, id])).rows
      expect(receipts.map((row) => row.result.status)).toEqual(['completed', 'completed', 'completed'])
    } finally { await f.close() }
  })

  it('A-R17 keeps snapshots byte bounded while HTTP history returns every oversized message intact and advances', async () => {
    const { service } = makeService()
    try {
      const initial = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'before large history', null))
      const id = initial.state.conversation!.id
      await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
      const huge = '界'.repeat(3 * 1024 * 1024), hugeId = randomUUID()
      for (const [messageId, content] of [[hugeId, huge], [randomUUID(), 'newest message']]) {
        const record = { id: messageId, conversationId: id, role: 'assistant', content, createdAt: new Date().toISOString() }
        await pool.query(`insert into operator_conversation_messages(id,conversation_id,role,content,record) values($1,$2,'assistant',$3,$4::jsonb)`,
          [messageId, id, content, JSON.stringify(record)])
      }
      const state = await service.read(writer, fixture.scope.workspaceId, query(codexNode))
      expect(Buffer.byteLength(JSON.stringify(state.messages))).toBeLessThan(256 * 1024)
      expect(state.hasEarlierMessages).toBe(true)
      expect(state.messages.map((message) => message.content)).toEqual(['newest message'])
      const messages: AgentChatState['messages'] = [], cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await service.history(writer, fixture.scope.workspaceId, id, cursor, 100)
        messages.push(...page.messages)
        cursor = page.nextCursor ?? undefined
        if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor) }
      } while (cursor)
      expect(messages.find((message) => message.id === hugeId)?.content === huge).toBe(true)
      expect(messages).toHaveLength(4)
      expect(new Set(messages.map((message) => message.id)).size).toBe(4)
    } finally { await service.shutdown() }
  })
})
