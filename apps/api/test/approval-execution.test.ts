import assert from 'node:assert/strict'

import type {
  AgentConfigurationVersion, AgentHarness, ApprovalResponseOption, DurableInteraction,
  ExecutionResult, HarnessExecution, HarnessExecutionRequest, McpDetection,
  NativeHarnessCapabilities, NativeHarnessEvent, NativeSessionReference, PendingNativeInteraction,
} from '@graphql/contracts'
import { it } from 'vitest'
import { nativeLanes } from './helpers/nativeLanes.js'

import { DomainError } from '../src/modules/errors.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'

const now = '2026-09-16T00:00:00.000Z'
const success: ExecutionResult = { outcome: 'succeeded', output: { done: true } }

class ScriptedManager implements NativeHarnessSessionManager {
  readonly session: NativeSessionReference
  snapshot: NativeHistory = { events: [], pendingInteractions: [] }
  readonly creates: NativeSessionStart[] = []
  readonly attaches: NativeSessionStart[] = []
  readonly turns: Array<{ session: NativeSessionReference; input: NativeTurnInput; signal?: AbortSignal }> = []
  readonly observed: NativeSessionReference[] = []
  readonly closed: NativeSessionReference[] = []
  readonly canceled: NativeSessionReference[] = []
  responses = 0
  createError: Error | undefined
  attachError: Error | undefined
  turnError: Error | undefined
  historyError: Error | undefined
  onHistory: (() => void) | undefined
  attachedSession: NativeSessionReference | undefined

  constructor(readonly harness: AgentHarness) {
    this.session = { harness, providerVersion: harness === 'codex' ? 'codex-cli 0.154.0' : '1.18.31', nativeSessionId: 'native-session-exact' }
  }
  async capabilities(): Promise<NativeHarnessCapabilities> {
    return { provider: this.harness, providerVersion: this.session.providerVersion, persistentSessions: true,
      reconnect: true, sameRequestResponses: true, cancellation: true, history: true,
      configurationInspection: true, mcpDetection: true, supportedInteractionKinds: ['approval'] }
  }
  async inspectMcp(): Promise<McpDetection> {
    return { harness: this.harness, serverName: 'graphql-app', state: 'connected', endpointMatches: true,
      credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', checkedAt: now }
  }
  async createSession(input: NativeSessionStart) {
    this.creates.push(input)
    if (this.createError) throw this.createError
    return this.session
  }
  async attachSession(session: NativeSessionReference, input: NativeSessionStart) {
    this.attaches.push(input)
    if (this.attachError) throw this.attachError
    // Mirrors the App-MCP precondition that exposed the resident Codex bug.
    if (!input.environment) throw new Error('scoped process environment required at start')
    return this.attachedSession ?? session
  }
  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    this.turns.push({ session, input, ...(signal ? { signal } : {}) })
    if (this.turnError) throw this.turnError
    yield { sequence: 0, type: 'turn.started', occurredAt: now, payload: {} }
  }
  async pending() { return this.snapshot.pendingInteractions[0] }
  async respond() { this.responses += 1 }
  async cancel(session: NativeSessionReference) { this.canceled.push(session); return true }
  async history(session: NativeSessionReference): Promise<NativeHistory> {
    this.observed.push(session)
    this.onHistory?.()
    if (this.historyError) throw this.historyError
    assert.deepEqual(session, this.session)
    return this.snapshot
  }
  async reconcile(session: NativeSessionReference, correlationId: string) {
    if (!this.turns.length && !this.attaches.length) return { events: [], pendingInteractions: [] }
    const history = await this.history(session)
    return { ...history, ...(history.terminalResult ? { terminalTurn: { correlationId, providerId: 'workflow-turn', result: history.terminalResult } } : {}) }
  }
  async close(session: NativeSessionReference) { this.closed.push(session) }
}

function fixture(harness: AgentHarness = 'codex') {
  const configuration: AgentConfigurationVersion = {
    id: 'configuration-pinned', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
    prompt: {}, assignedSkills: [], contentHash: 'sha256:fixture', createdAt: now,
    harness: harness === 'codex'
      ? { harness, model: 'fixture-model', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' }
      : { harness, model: 'fixture/model', variant: 'default', nativeAgent: 'build', thinking: false, autoApprove: false },
  }
  const candidate: HarnessExecution = {
    id: 'execution-durable', runId: 'run-1', workflowNodeId: 'node-1', agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, input: { accepted: true },
    workingDirectory: '/accepted/project', runtimeDirectory: '/accepted/runtime',
    state: 'starting', createdAt: now, startedAt: now,
  }
  const request: HarnessExecutionRequest = {
    executionId: candidate.id, runId: candidate.runId, workspaceId: configuration.workspaceId,
    workflowNodeId: candidate.workflowNodeId, workingDirectory: candidate.workingDirectory!,
    runtimeDirectory: candidate.runtimeDirectory!, configuration, input: candidate.input,
  }
  const executions = new Map<string, HarnessExecution>()
  const records = new Map<string, DurableInteraction>()
  const updates: HarnessExecution[] = []
  const revoked: string[] = []
  const prepared: string[] = []
  const waits: string[] = []
  const resumes: string[] = []
  const stops: string[] = []
  let activityFailure: Error | undefined
  let prepareFailure: Error | undefined
  let budgetFailure: Error | undefined
  let stopFailure: Error | undefined
  let cancelPendingCalls = 0
  const owner = { assertOwned() {}, client: {} } as unknown as RunOwnership
  const runs = {
    async ensureExecution(input: HarnessExecution) {
      const existing = [...executions.values()].find((item) => item.runId === input.runId
        && item.workflowNodeId === input.workflowNodeId && item.attempt === input.attempt)
      if (existing) return { execution: structuredClone(existing), created: false }
      executions.set(input.id, structuredClone(input))
      return { execution: structuredClone(input), created: true }
    },
    async getExecution(id: string) { return executions.get(id) },
    async getExecutionConfiguration() { return configuration },
    async get() { return { id: candidate.runId, workspaceId: configuration.workspaceId } },
    async listExecutions() { return [...executions.values()].map((item) => structuredClone(item)) },
    async updateExecution(execution: HarnessExecution, actualOwner: RunOwnership) {
      assert.equal(actualOwner, owner)
      assert.ok(executions.has(execution.id), 'must update the ensured durable execution, not a candidate')
      executions.set(execution.id, structuredClone(execution))
      updates.push(structuredClone(execution))
    },
    async recordActivity() {
      if (activityFailure) { const error = activityFailure; activityFailure = undefined; throw error }
    },
    async appendNativeEvent() {
      if (activityFailure) { const error = activityFailure; activityFailure = undefined; throw error }
    },
  } as unknown as PostgresRunRepository
  const interactions = {
    coordination: nativeLanes(),
    async create(input: DurableInteraction) {
      const existing = [...records.values()].find((item) => item.harness === input.harness
        && item.nativeSessionId === input.nativeSessionId && item.nativeRequestId === input.nativeRequestId)
      if (existing) {
        assert.equal(existing.executionId, input.executionId)
        assert.equal(existing.requestingAgentId, input.requestingAgentId)
        return { interaction: structuredClone(existing), created: false }
      }
      records.set(input.id, structuredClone(input))
      return { interaction: structuredClone(input), created: true }
    },
    async get(id: string) { return records.get(id) },
    async getForExecution(id: string) { return [...records.values()].filter((item) => item.executionId === id).at(-1) },
    async cancelPendingForExecution(executionId: string, ids?: readonly string[]) {
      for (const [id, row] of records) if (row.executionId === executionId && row.status === 'pending'
        && (!ids || ids.includes(row.nativeRequestId))) records.set(id, { ...row, status: 'canceled' })
    },
    async cancelPendingForRun() { cancelPendingCalls += 1; return 0 },
  } as unknown as PostgresInteractionRepository
  const budgets = {
    async ensure() {},
    async remaining() { if (budgetFailure) throw budgetFailure; return 60_000 },
    async assertActive() { if (budgetFailure) throw budgetFailure },
    async beginWait(id: string) { waits.push(id) },
    async resume(id: string) { resumes.push(id) },
    async finish() {},
    async stop(id: string) {
      stops.push(id)
      if (stopFailure) { const error = stopFailure; stopFailure = undefined; throw error }
    },
  } as unknown as PostgresApprovalBudgetRepository
  const credentials = {
    async prepare(input: { executionId: string }) {
      prepared.push(input.executionId)
      if (prepareFailure) throw prepareFailure
      return { credential: { principalId: 'fixture-principal', expiresAt: new Date(Date.now() + 900_000).toISOString(), environment: {
        agentId: configuration.agentId, variables: { GRAPHQL_APP_MCP_TOKEN: 'test-scoped-token' },
      } } }
    },
    async revokeForExecution(id: string) { revoked.push(id) },
  } as unknown as ExecutionCredentialProvider
  const manager = new ScriptedManager(harness)
  const resolver = new ExecutionScopedNativeSessionManagerResolver(() => manager)
  const coordinator = new ApprovalExecutionCoordinator(runs, interactions, budgets, resolver, 60_000, credentials)
  const controller = new AbortController()
  const input = { candidate, request, approval: { handler: 'user' as const }, workflowId: 'workflow-1',
    graphThreadId: candidate.runId, owner, signal: controller.signal }
  function pending(id: string): PendingNativeInteraction {
    const option: ApprovalResponseOption = { optionId: `option:${id}`, semantic: 'approve_once', label: 'Approve once',
      persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }
    return { session: manager.session, turn: { nativeTurnId: 'turn-exact', nativeRequestId: id },
      nativeRequestType: harness === 'codex' ? 'item/commandExecution/requestApproval' : 'permission.asked',
      request: { command: id }, responseOptions: [option] }
  }
  function snapshot(...ids: string[]) { manager.snapshot = { events: [], pendingInteractions: ids.map(pending) } }
  function delivered(id: string) {
    const record = [...records.values()].find((item) => item.nativeRequestId === id)
    assert.ok(record)
    const next: DurableInteraction = { ...record, status: 'delivered', deliveryState: 'delivered' }
    records.set(next.id, next)
    return next
  }
  return { candidate, configuration, request, input, executions, records, updates, revoked, prepared, waits, resumes, stops,
    coordinator, manager, resolver, controller, owner, pending, snapshot, delivered, budgets, interactions, runs,
    failActivity(error: Error) { activityFailure = error },
    failPrepare(error: Error) { prepareFailure = error },
    failBudget(error: Error) { budgetFailure = error },
    failStop(error: Error) { stopFailure = error },
    cancelPendingCalls: () => cancelPendingCalls }
}

it('continues observing normal native work after approval without replay or credential revocation', async () => {
  const f = fixture()
  f.snapshot('request-a')
  assert.equal((await f.coordinator.ensureObserve(f.input)).state, 'waiting')
  f.delivered('request-a')
  f.snapshot()
  let observations = 0
  f.manager.onHistory = () => {
    assert.equal(f.revoked.length, 0)
    if (++observations === 3) f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  }
  const result = await f.coordinator.ensureObserve(f.input)
  assert.equal(result.state, 'completed')
  assert.equal(observations, 3)
  assert.equal(f.manager.creates.length, 1)
  assert.equal(f.manager.turns.length, 1)
  assert.equal(f.manager.responses, 0)
  assert.deepEqual(f.prepared, [f.candidate.id])
  assert.deepEqual(f.resumes, [f.candidate.id])
  assert.deepEqual(f.revoked, [f.candidate.id])
  assert.ok(f.manager.observed.every((session) => session.nativeSessionId === f.manager.session.nativeSessionId))
})

it('persists a later approval under its own exact request and does not return the prior delivery', async () => {
  const f = fixture()
  f.snapshot('request-a')
  const first = await f.coordinator.ensureObserve(f.input)
  assert.equal(first.state, 'waiting')
  const delivered = f.delivered('request-a')
  f.snapshot('request-b')
  const second = await f.coordinator.ensureObserve(f.input)
  assert.equal(second.state, 'waiting')
  if (second.state !== 'waiting') throw new Error('expected approval')
  assert.equal(second.interaction.nativeRequestId, 'request-b')
  assert.notEqual(second.interaction.id, delivered.id)
  assert.equal(f.records.size, 2)
  assert.equal(f.manager.turns.length, 1)
})

it('persists redacted context from the exact native file-change item with the pending approval', async () => {
  const f = fixture()
  const request = { ...f.pending('request-file'), nativeRequestType: 'item/fileChange/requestApproval',
    request: { turnId: 'turn-exact', itemId: 'item-file' } }
  f.manager.snapshot = { pendingInteractions: [request], events: [{ sequence: 49, type: 'item.started', occurredAt: now,
    payload: { threadId: f.manager.session.nativeSessionId, turnId: 'turn-exact', item: { id: 'item-file', type: 'fileChange',
      changes: [{ path: '/accepted/test-scoped-token.ts', diff: '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-secret\n+test-scoped-token' }] } } }] }
  const observed = await f.coordinator.ensureObserve(f.input)
  assert.equal(observed.state, 'waiting')
  if (observed.state !== 'waiting') throw new Error('expected approval')
  assert.deepEqual(observed.interaction.reviewContext, {
    target: '/accepted/[REDACTED].ts', changeSummary: '1 file; 1 added, 1 removed lines. Patch contents are not shown here.',
  })
  assert.equal(JSON.stringify(observed.interaction).includes('test-scoped-token'), false)
})

it('persists all simultaneous OpenCode approvals and tolerates out-of-order delivery', async () => {
  const f = fixture('opencode')
  f.snapshot('request-a', 'request-b', 'request-c')
  const first = await f.coordinator.ensureObserve(f.input)
  assert.equal(first.state, 'waiting')
  if (first.state !== 'waiting') throw new Error('expected approval')
  assert.deepEqual(first.interactions.map((item) => item.nativeRequestId), ['request-a', 'request-b', 'request-c'])
  const ids = [...f.records.keys()]
  f.delivered('request-b')
  // The native snapshot may still include a delivered request while applying it.
  const second = await f.coordinator.ensureObserve(f.input)
  assert.equal(second.state, 'waiting')
  if (second.state !== 'waiting') throw new Error('expected approval')
  assert.deepEqual(second.interactions.map((item) => item.nativeRequestId), ['request-a', 'request-c'])
  assert.deepEqual([...f.records.keys()], ids)
  assert.equal(f.manager.turns.length, 1)
})

it('ignores an already-delivered native ask until its same turn becomes terminal', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  f.delivered('request-a')
  let observed = 0
  f.manager.onHistory = () => {
    if (++observed === 2) f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  }
  assert.equal((await f.coordinator.ensureObserve(f.input)).state, 'completed')
  assert.equal(f.records.size, 1)
  assert.equal(f.manager.turns.length, 1)
})

it('reuses a resident Codex App-MCP context without attaching, replacing credentials, or closing it', async () => {
  const f = fixture()
  f.snapshot('request-a')
  const waiting = await f.coordinator.ensureObserve(f.input)
  if (waiting.state !== 'waiting') throw new Error('expected approval')
  const attached = await f.coordinator.attachInteraction(waiting.interaction)
  assert.deepEqual(attached.session, f.manager.session)
  assert.equal(f.manager.attaches.length, 0)
  assert.deepEqual(f.prepared, [f.candidate.id])
  assert.equal(f.revoked.length, 0)
  assert.equal(f.manager.closed.length, 0)
})

it('rejects a different native session before touching a healthy resident manager', async () => {
  const f = fixture()
  f.snapshot('request-a')
  const waiting = await f.coordinator.ensureObserve(f.input)
  if (waiting.state !== 'waiting') throw new Error('expected approval')
  const reads = f.manager.observed.length
  await assert.rejects(f.coordinator.attachInteraction({ ...waiting.interaction, nativeSessionId: 'other-session' }), /ownership context/)
  assert.equal(f.manager.observed.length, reads)
  assert.equal(f.manager.closed.length, 0)
})

it('reconstructs cold attachment from the ensured durable execution rather than a fresh candidate', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, { ...f.candidate, state: 'running', nativeSessionId: f.manager.session.nativeSessionId })
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  const observation = await f.coordinator.ensureObserve({ ...f.input,
    candidate: { ...f.candidate, id: 'fresh-candidate', input: { wrong: true } },
    request: { ...f.request, executionId: 'fresh-candidate', input: { wrong: true }, runtimeDirectory: '/fresh/runtime' },
  })
  assert.equal(observation.execution.id, f.candidate.id)
  const attached = f.manager.attaches[0]!
  assert.notEqual(attached.kind, 'operator')
  if (attached.kind === 'operator') throw new Error('expected workflow')
  assert.equal(attached.request.executionId, f.candidate.id)
  assert.equal(attached.request.runtimeDirectory, f.candidate.runtimeDirectory)
  assert.deepEqual(attached.request.input, f.candidate.input)
  assert.equal(attached.correlationId, `execution:${f.candidate.id}`)
  assert.deepEqual(f.prepared, [f.candidate.id])
  assert.equal(f.manager.creates.length, 0)
  assert.equal(f.manager.turns.length, 0)
})

it('fails closed for an existing attempt with no durable native identity rather than replaying a start', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, f.candidate)
  await assert.rejects(f.coordinator.ensureObserve(f.input), /will not be replayed/)
  assert.equal(f.manager.creates.length, 0)
  assert.equal(f.manager.turns.length, 0)
  assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'failed')
})

for (const failure of ['prepare', 'create', 'turn', 'activity', 'budget'] as const) {
  it(`terminally settles the durable execution after a ${failure} failure`, async () => {
    const f = fixture()
    const error = new Error(`${failure} failed`)
    f.snapshot('request-a')
    if (failure === 'prepare') f.failPrepare(error)
    if (failure === 'create') f.manager.createError = error
    if (failure === 'turn') f.manager.turnError = error
    if (failure === 'activity') f.failActivity(error)
    if (failure === 'budget') f.failBudget(error)
    await assert.rejects(f.coordinator.ensureObserve(f.input), error)
    assert.equal(f.executions.get(f.candidate.id)?.state, 'completed')
    assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'failed')
    assert.ok(f.executions.get(f.candidate.id)?.finishedAt)
    assert.ok(f.revoked.includes(f.candidate.id))
  })
}

it('settles resumed history failure using the durable identity and preserves the native failure code', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  f.delivered('request-a')
  f.manager.historyError = new HarnessExecutionError('TRANSPORT_LOST', 'The native transport disconnected.')
  await assert.rejects(f.coordinator.ensureObserve({ ...f.input, candidate: { ...f.candidate, id: 'fresh-candidate' } }), /disconnected/)
  assert.equal(f.executions.get(f.candidate.id)?.result?.error?.code, 'TRANSPORT_LOST')
  assert.equal(f.manager.canceled.length, 1)
  assert.equal(f.manager.closed.length, 1)
  assert.equal(f.updates.some((item) => item.id === 'fresh-candidate'), false)
})

it('does not return an old delivered interaction when cold attachment fails', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  f.delivered('request-a')
  f.resolver.release({ harness: f.manager.harness, executionId: f.candidate.id, agentId: f.candidate.agentId,
    workingDirectory: f.candidate.workingDirectory!, configuration: f.configuration })
  f.manager.attachError = new Error('native session unavailable')
  await assert.rejects(f.coordinator.ensureObserve(f.input), /native session unavailable/)
  assert.equal(f.executions.get(f.candidate.id)?.state, 'completed')
  assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'failed')
  assert.equal(f.manager.creates.length, 1)
  assert.equal(f.manager.turns.length, 1)
})

it('handles cancellation during post-approval observation without replay', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  f.delivered('request-a')
  f.snapshot()
  f.manager.onHistory = () => f.controller.abort()
  await assert.rejects(f.coordinator.ensureObserve(f.input))
  assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'canceled')
  assert.equal(f.manager.turns.length, 1)
  assert.equal(f.manager.canceled.length, 1)
  assert.deepEqual(f.revoked, [f.candidate.id])
})

it('passes the abort signal to the initial native turn', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  const nativeSignal = f.manager.turns[0]?.signal
  assert.ok(nativeSignal)
  assert.equal(nativeSignal.aborted, false)
  f.controller.abort(new Error('cancel execution'))
  assert.equal(nativeSignal.aborted, true)
})

it('returns a terminal canceled result without replacing the native session', async () => {
  const f = fixture()
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: { outcome: 'canceled' } }
  const observation = await f.coordinator.ensureObserve(f.input)
  assert.equal(observation.state, 'completed')
  assert.equal(observation.execution.result?.outcome, 'canceled')
  assert.equal(f.manager.creates.length, 1)
  assert.equal(f.manager.closed.length, 1)
})

it('returns a completed durable result before checking its stopped active-time budget', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, { ...f.candidate, state: 'completed', result: success, finishedAt: now })
  f.failBudget(new Error('budget already stopped'))
  const observation = await f.coordinator.ensureObserve(f.input)
  assert.equal(observation.state, 'completed')
  assert.equal(f.manager.creates.length, 0)
  assert.equal(f.manager.observed.length, 0)
})

it('rejects a native pending request whose harness/session identity does not match the observed turn', async () => {
  const f = fixture()
  const pending = f.pending('request-a')
  f.manager.snapshot = { events: [], pendingInteractions: [{ ...pending,
    session: { ...pending.session, nativeSessionId: 'other-session' } }] }
  await assert.rejects(f.coordinator.ensureObserve(f.input), /session identity/)
  assert.equal(f.records.size, 0)
  assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'failed')
})

it('consumes only delivered resume identities belonging to this exact durable execution', async () => {
  const f = fixture()
  f.snapshot('request-a', 'request-b')
  const waiting = await f.coordinator.ensureObserve(f.input)
  if (waiting.state !== 'waiting') throw new Error('expected approval')
  const a = f.delivered('request-a')
  await f.coordinator.assertResume(waiting.execution, { interactionId: a.id })
  const b = [...f.records.values()].find((item) => item.nativeRequestId === 'request-b')!
  await assert.rejects(f.coordinator.assertResume(waiting.execution, { interactionId: b.id }), /not a delivered interaction/)
  await assert.rejects(f.coordinator.assertResume({ ...waiting.execution, id: 'other-execution' }, { interactionId: a.id }))
  await assert.rejects(f.coordinator.assertResume({ ...waiting.execution, nativeSessionId: 'other-session' }, { interactionId: a.id }))
  await assert.rejects(f.coordinator.assertResume(waiting.execution, undefined))
  f.records.set(a.id, { ...a, harness: 'opencode' })
  await assert.rejects(f.coordinator.assertResume(waiting.execution, { interactionId: a.id }))
  assert.equal(f.manager.responses, 0)
})

it('settles every unfinished execution on owned run cleanup even if one budget stop fails', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, f.candidate)
  f.executions.set('execution-sibling', { ...f.candidate, id: 'execution-sibling', workflowNodeId: 'sibling', state: 'waiting' })
  f.executions.set('execution-success', { ...f.candidate, id: 'execution-success', workflowNodeId: 'success',
    state: 'completed', result: success, finishedAt: now })
  f.failStop(new Error('budget cleanup unavailable'))
  await assert.rejects(f.coordinator.cancelRun(f.candidate.runId, f.owner), AggregateError)
  assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'canceled')
  assert.equal(f.executions.get('execution-sibling')?.result?.outcome, 'canceled')
  assert.deepEqual(f.executions.get('execution-success')?.result, success)
  assert.equal(f.cancelPendingCalls(), 1)
  assert.equal(f.revoked.length, 3)
})

it('does not overwrite a live execution when cancellation is requested without its owner', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, f.candidate)
  await f.coordinator.cancelRun(f.candidate.runId)
  assert.equal(f.executions.get(f.candidate.id)?.state, 'starting')
  assert.equal(f.updates.length, 0)
})

it('rejects a cold attach that returns a different native identity', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, { ...f.candidate, state: 'running', nativeSessionId: f.manager.session.nativeSessionId })
  f.manager.attachedSession = { ...f.manager.session, nativeSessionId: 'replacement-session' }
  await assert.rejects(f.coordinator.ensureObserve(f.input), /different session identity/)
  assert.equal(f.manager.creates.length, 0)
  assert.equal(f.manager.turns.length, 0)
  assert.equal(f.executions.get(f.candidate.id)?.nativeSessionId, f.manager.session.nativeSessionId)
})

it('stops post-approval observation when the active-time budget expires', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  f.delivered('request-a')
  f.snapshot()
  f.manager.onHistory = () => f.failBudget(new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'active budget exhausted', 409))
  await assert.rejects(f.coordinator.ensureObserve(f.input), /active budget exhausted/)
  assert.equal(f.executions.get(f.candidate.id)?.result?.error?.code, 'EXECUTION_ACTIVE_TIMEOUT')
  assert.equal(f.manager.turns.length, 1)
})


it('does not accept a terminal success when cancellation arrives during the history read', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  f.delivered('request-a')
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  f.manager.onHistory = () => f.controller.abort()
  await assert.rejects(f.coordinator.ensureObserve(f.input))
  assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'canceled')
  assert.equal(f.manager.turns.length, 1)
})

it('still cancels the resident native session when stopping its budget fails', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  f.failStop(new Error('budget stop failed'))
  await assert.rejects(f.coordinator.cancelRun(f.candidate.runId, f.owner), AggregateError)
  assert.equal(f.manager.canceled.length, 1)
  assert.equal(f.manager.closed.length, 1)
  assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'canceled')
  assert.equal(f.cancelPendingCalls(), 1)
})


it('does not stop the shared budget or revoke replacement credentials after ownership is lost', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.ensureObserve(f.input)
  f.delivered('request-a')
  f.snapshot()
  f.manager.onHistory = () => {
    f.owner.assertOwned = () => { throw new Error('execution owner disconnected') }
  }
  await assert.rejects(f.coordinator.ensureObserve(f.input), /owner disconnected/)
  assert.equal(f.stops.length, 0)
  assert.equal(f.revoked.length, 0)
  assert.equal(f.manager.canceled.length, 0)
  assert.equal(f.manager.closed.length, 1)
})


it('aborts a stalled native iterator at its own remaining execution budget', async () => {
  const f = fixture()
  f.budgets.remaining = async () => 20
  f.manager.startTurn = async function* () { await new Promise(() => undefined); yield {} as NativeHarnessEvent }
  const started = Date.now()
  await assert.rejects(f.coordinator.ensureObserve(f.input), { code: 'EXECUTION_ACTIVE_TIMEOUT' })
  assert.ok(Date.now() - started < 1000)
  assert.equal(f.manager.canceled.length, 1)
  assert.equal(f.manager.closed.length, 1)
  assert.equal(f.executions.get(f.candidate.id)?.result?.outcome, 'failed')
  assert.equal(f.executions.get(f.candidate.id)?.result?.error?.code, 'EXECUTION_ACTIVE_TIMEOUT')
})

it('refuses a generic terminal result that belongs to a different native turn', async () => {
  const f = fixture()
  f.budgets.remaining = async () => 30
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  f.manager.reconcile = async () => ({ events: [], pendingInteractions: [], terminalResult: success,
    terminalTurn: { correlationId: 'unrelated-review', providerId: 'review-turn', result: success } })
  await assert.rejects(f.coordinator.ensureObserve(f.input), (error: unknown) => error instanceof Error && error.cause instanceof DomainError && error.cause.code === 'EXECUTION_ACTIVE_TIMEOUT')
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
})


it('cancels durable sibling asks after a provider rejection and successful completion', async () => {
  const f = fixture('opencode')
  f.snapshot('first', 'sibling')
  await f.coordinator.ensureObserve(f.input)
  f.delivered('first')
  f.manager.snapshot = { events: [], pendingInteractions: [], canceledRequestIds: ['sibling'], terminalResult: success }
  const completed = await f.coordinator.ensureObserve(f.input)
  assert.equal(completed.state, 'completed')
  assert.equal([...f.records.values()].find((row) => row.nativeRequestId === 'sibling')?.status, 'canceled')
  assert.equal([...f.records.values()].find((row) => row.nativeRequestId === 'first')?.status, 'delivered')
})
