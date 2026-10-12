import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import assert from 'node:assert/strict'

import type {
  AgentConfigurationVersion, AgentHarness, ApprovalResponseOption, DurableInteraction,
  ExecutionResult, HarnessExecution, HarnessExecutionRequest, HarnessNativeEvent, McpDetection,
  NativeHarnessCapabilities, NativeHarnessEvent, NativeSessionReference, PendingNativeInteraction,
} from '@foreman-code/contracts'
import { afterEach, expect, it } from 'vitest'
import type pg from 'pg'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { nativeLanes } from './helpers/nativeLanes.js'

import { DomainError } from '../src/modules/errors.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { Wave25InteractionRepository as PostgresInteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import type { RepeatNativeObservationStore } from '../src/modules/interactions/repeatObservation.js'
import type { WorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import type { RepeatNativeEvidence } from '../src/modules/runs/repeatNativeRepository.js'
import { nativeApprovalContext } from '../src/modules/interactions/nativeApprovalContext.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { normalizeRepeatTerminal } from '../src/modules/runs/repeatNode.js'
import { currentInitialPrompt } from '../src/modules/runs/currentRouting.js'

const connections: ExclusiveGraphConnection[] = []
afterEach(async () => { await Promise.all(connections.splice(0).map((connection) => connection.close())) })

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
    return { harness: this.harness, serverName: 'graphql', state: 'connected', endpointMatches: true,
      credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', checkedAt: now }
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
    return { ...history, correlationId, nativeTurnId: 'workflow-turn', ...(history.terminalResult ? { terminalTurn: { correlationId, providerId: 'workflow-turn', result: history.terminalResult } } : {}) }
  }
  async close(session: NativeSessionReference) { this.closed.push(session) }
}

it('rejects unsupported Claude configuration before allocating the approval fixture', () => {
  assert.throws(() => fixture('claude'), /supports only Codex/)
})

function fixture(harness: AgentHarness = 'codex') {
  if (harness === 'claude') throw new Error('Approval execution fixture supports only Codex')
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
  const captures = createWorkflowNativeCaptureChannel()
  const capturedSourceKinds: string[] = []
  const executions = new Map<string, HarnessExecution>([[candidate.id, structuredClone(candidate)]])
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
  let stopRequested = false, cleanupPending = false
  const negativeSettlements: Array<{ id: string; canceled: boolean }> = []
  // The owner-only Stop pass now re-reads a physical receipt even after the
  // original resident manager closed. Model ONLY that exact persisted close;
  // no SQL arm fabricates recovery evidence from a missing manager.
  const identity = (execution: HarnessExecution) => ({ id: execution.id, runId: execution.runId,
    workflowNodeId: execution.workflowNodeId, agentId: execution.agentId,
    agentConfigurationVersionId: execution.agentConfigurationVersionId, attempt: execution.attempt,
    workingDirectory: execution.workingDirectory, runtimeDirectory: execution.runtimeDirectory })
  const connection = new ExclusiveGraphConnection({ query: async (text: string, values: unknown[] = []) => {
    const q = text.replace(/\s+/g, ' ').trim()
    const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] })
    if (q.startsWith('begin ') || q === 'commit' || q === 'rollback') return result()
    if (q.startsWith("select r.record->>'executionSemanticsVersion' as semantics,")) {
      assert.deepEqual(values, [candidate.runId])
      return result([{ semantics: '3', fenced: stopRequested || cleanupPending }])
    }
    if (q === 'select record from harness_executions where id=$1 and run_id=$2 for update') {
      assert.deepEqual(values, [candidate.id, candidate.runId])
      return result([{ record: executions.get(candidate.id) }])
    }
    if (q.startsWith('select generation::text,execution_identity,')) {
      assert.deepEqual(values, [candidate.id])
      assert.ok(closed, 'the original manager must commit its close before cold cleanup')
      return result([{ generation: closed.durableGeneration, execution_identity: identity(closed.execution as HarnessExecution),
        expected_reference: closed.session, closed_reference: closed.session, closed: true,
        detached: false, detached_reference: null, closed_without_session: false, prior_unclosed: false }])
    }
    if (q.startsWith('select c.generation::text,c.execution_identity,')) {
      assert.deepEqual(values, [candidate.id, candidate.runId])
      assert.ok(closed, 'only the exact original-session close is available in this fixture')
      return result([{ generation: closed.durableGeneration, execution_identity: identity(closed.execution as HarnessExecution),
        expected_reference: closed.session, closed_reference: closed.session, closed: true,
        detached: false, detached_reference: null, closed_without_session: false, prior_unclosed: false,
        record: executions.get(candidate.id), reference: closed.session }])
    }
    throw new Error(`Unscripted approval execution recovery SQL: ${q}`)
  } } as unknown as pg.ClientBase, () => owner.assertOwned())
  connections.push(connection)
  const owner = { runId: candidate.runId, assertOwned() {}, client: {}, oneShotConnection: () => connection,
    readOneShotFence: async () => { owner.assertOwned(); return { ownerId: 'approval-unit-owner', fence: '1' } },
  } as unknown as RunOwnership
  const runs = {
    async getRepeatSnapshot() { return { run: { executionState: 'running' }, stopRequested, cleanupPending } },
    async requestCleanup() { cleanupPending = true },
    async *executionPages() { yield [...executions.values()] },
    async repeat() { return { async settleNegativeExecution(id: string, canceled: boolean) {
      // This recording repository port models idempotent disposition receipts,
      // not native evidence or the production execution/result SQL writer.
      // A later caller cannot silently change an already recorded disposition.
      const prior = negativeSettlements.find((receipt) => receipt.id === id)
      if (prior) assert.deepEqual(prior, { id, canceled })
      else negativeSettlements.push({ id, canceled })
    } } },
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
    async updateExecution(execution: HarnessExecution, actualOwner: RunOwnership, evidence: RepeatNativeEvidence) {
      const captured = captures.verify.read(evidence)
      if (captured.source.type === 'history') for (const pending of captured.source.history.pendingInteractions) {
        const id = pending.turn.nativeRequestId!
        if (![...records.values()].some((item) => item.nativeRequestId === id)) {
          const context = nativeApprovalContext(pending, captured.source.history.events)
          records.set(id, { id, revision: 0, workspaceId: configuration.workspaceId, workflowId: 'workflow-1',
            runId: execution.runId, executionId: execution.id, requestingAgentId: execution.agentId,
            ...pending.session, nativeRequestId: id, nativeRequestType: pending.nativeRequestType,
            graphThreadId: execution.runId, request: pending.request, responseOptions: pending.responseOptions,
            ...(context ? { reviewContext: context } : {}), approval: { handler: 'user' },
            status: 'pending', deliveryState: 'not_started', createdAt: now, updatedAt: now })
        }
      }
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
    async appendNativeEvents() {
      if (activityFailure) { const error = activityFailure; activityFailure = undefined; throw error }
    },
  } as unknown as PostgresRunRepository
  const interactions = {
    coordination: nativeLanes(),
    assertOrchestratorConnection: async () => ({ orchestratorNodeId: 'node-reviewer' }),
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
    async getNativeRequest(_executionId: string, _harness: string, _sessionId: string, requestId: string) { return [...records.values()].find((item) => item.nativeRequestId === requestId) },
    async getForExecution(id: string) { return [...records.values()].filter((item) => item.executionId === id).at(-1) },
    async cancelPendingForExecution(executionId: string, ids?: readonly string[]) {
      for (const [id, row] of records) if (row.executionId === executionId && row.status === 'pending'
        && (!ids || ids.includes(row.nativeRequestId))) records.set(id, { ...row, status: 'canceled' })
    },
    async cancelPendingForRun() { cancelPendingCalls += 1; return 0 },
  } as unknown as PostgresInteractionRepository
  let activeBudgetMs: number | undefined
  const budgets = {
    async ensure(_executionId: string, _graphThreadId: string, timeoutMs: number) { activeBudgetMs ??= timeoutMs },
    async remaining() { if (budgetFailure) throw budgetFailure; return activeBudgetMs ?? 60_000 },
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
        agentId: configuration.agentId, variables: { GRAPHQL_MCP_TOKEN: 'test-scoped-token' },
      } } }
    },
    async revoke() { revoked.push(candidate.id) },
    async revokeForExecution(id: string) { revoked.push(id) },
  } as unknown as ExecutionCredentialProvider
  const manager = new ScriptedManager(harness)
  const resolver = new ExecutionScopedNativeSessionManagerResolver(() => manager)
  let closed: Awaited<ReturnType<WorkflowClosureStore['read']>>
  const closures: WorkflowClosureStore = {
    async begin() { closed = undefined; return '1' },
    async record(execution, session, durableGeneration, check) { check(); closed = { execution, session, durableGeneration }; return closed },
    async read() { return closed },
    async recordDetached(_execution, _session, _generation, check) { check() },
    async recordUnbound(execution, durableGeneration, check) { check(); return { execution: { ...execution, workingDirectory: execution.workingDirectory!, runtimeDirectory: execution.runtimeDirectory! }, durableGeneration } },
    async readUnbound() { return undefined },
  }
  let launch = true
  const store: RepeatNativeObservationStore = {
    async readExecution(id) {
      const execution = executions.get(id)
      if (!execution) throw new DomainError('EXECUTION_NOT_FOUND', 'No admitted execution', 404)
      return { execution, ref: { nodeId: execution.workflowNodeId, occurrence: null }, slotId: 'approval-slot',
        input: { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] },
        inputDigest: `sha256:${'1'.repeat(64)}`, accepted: false }
    },
    async assertExecutionAdmission(id) { assert.ok(executions.has(id)) },
    async assertNativeBoundary(id) { assert.ok(executions.has(id)) },
    async exactSession() { return manager.session },
    async authorizeNativeSubmission() {},
    consumeLaunch() { const available = launch; launch = false; return available },
    async settleNativeExecution() {
      if (!closed) throw new DomainError('REPEAT_CLEANUP_PENDING', 'Original manager close is required', 409)
    },
  }
  const coordinator = new ApprovalExecutionCoordinator(runs, interactions, budgets, resolver, 60_000, credentials,
    undefined, closures, undefined, { capture(input) {
      capturedSourceKinds.push(input.source.type)
      return captures.capture.capture(input)
    } })
  const controller = new AbortController()
  const input = { execution: candidate, store, request, approval: { handler: 'user' as const }, workflowId: 'workflow-1',
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
    store, negativeSettlements, stopFence() { stopRequested = true }, loseLaunch() { launch = false },
    coordinator, manager, resolver, controller, owner, pending, snapshot, delivered, budgets, interactions, runs, capturedSourceKinds,
    failActivity(error: Error) { activityFailure = error },
    failPrepare(error: Error) { prepareFailure = error },
    failBudget(error: Error) { budgetFailure = error },
    failStop(error: Error) { stopFailure = error },
    cancelPendingCalls: () => cancelPendingCalls }
}

it('captures complete native history only when needed for a pending request or terminal proof', async () => {
  const f = fixture()
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  const result = await f.coordinator.observeExact(f.input)
  assert.equal(result.state, 'completed')
  assert.equal(f.capturedSourceKinds.filter((kind) => kind === 'history').length, 1)
})

function workResultFixture(results: ExecutionResult[]) {
  const f = fixture()
  const pinned = makeCurrentWorkflowFixture('result-repair')
  const version = WorkflowVersionV3Schema.parse({ ...pinned.version,
    definition: { ...pinned.version.definition, handoffs: { contractVersion: 1 } } })
  const node = version.definition.nodes[0]!
  if (node.kind === 'job') throw new Error('The repair fixture requires an Agent node')
  const update = f.runs.updateExecution.bind(f.runs)
  f.runs.updateExecution = async (execution, owner, evidence) => {
    const normalized = normalizeRepeatTerminal(version, pinned.scope, { nodeId: node.id, occurrence: null }, {
      ...execution, runId: pinned.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId]!,
    }, { workResultRepair: f.manager.turns.length > 1 })
    await update({ ...execution, ...(normalized.result ? { result: normalized.result } : {}) }, owner, evidence)
  }
  const reservations = new Set<string>()
  f.runs.readWorkResultRepairAttempt = async () => reservations.size
  f.runs.reserveWorkResultRepair = async (id, providerId, owner) => {
    assert.equal(id, f.candidate.id)
    assert.equal(owner, f.owner)
    assert.ok(['running', 'waiting'].includes(f.executions.get(id)!.state))
    if (reservations.has(providerId)) return undefined
    reservations.add(providerId)
    return reservations.size
  }
  f.manager.startTurn = async function* (session, input, signal) {
    this.turns.push({ session, input, ...(signal ? { signal } : {}) })
    const index = this.turns.length - 1
    const providerId = `workflow-turn-${index}`
    await input.onSubmitted?.(providerId)
    const result = results[Math.min(index, results.length - 1)]!
    const terminal = { sequence: index * 2 + 1, type: 'turn.completed', occurredAt: now,
      payload: { threadId: session.nativeSessionId, turnId: providerId,
        status: result.outcome === 'failed' ? 'failed' : 'completed',
        clientCorrelationId: input.clientCorrelationId } }
    this.snapshot = { events: [terminal], pendingInteractions: [], terminalResult: result }
    yield { sequence: index * 2, type: 'turn.started', occurredAt: now,
      payload: { threadId: session.nativeSessionId, turnId: providerId, clientCorrelationId: input.clientCorrelationId } }
    yield terminal
  }
  f.manager.reconcile = async function (session, correlationId) {
    const history = await this.history(session)
    const providerId = `workflow-turn-${this.turns.length - 1}`
    return { ...history, correlationId, nativeTurnId: providerId,
      terminalTurn: { correlationId, providerId, result: history.terminalResult! } }
  }
  return { ...f, reservations, input: { ...f.input, workHandoffContract: currentInitialPrompt({}, false, true)! } }
}

const workData = { latestDeliverable: { summary: 'Done' }, remainingFindings: [] }
const invalidWorkResult: ExecutionResult = { outcome: 'succeeded', output: {
  routing: { kind: 'finish', outcome: 'Run the check.' }, data: workData,
} }
const validWorkResult: ExecutionResult = { outcome: 'succeeded', output: {
  routing: { kind: 'finish' }, data: workData,
} }

it.each([1, 2])('accepts a strictly corrected work result after %s same-session repair turns', async repairs => {
  const f = workResultFixture([...Array<ExecutionResult>(repairs).fill(invalidWorkResult), validWorkResult])
  const result = await f.coordinator.observeExact(f.input)
  expect(result).toMatchObject({ state: 'completed', result: validWorkResult })
  expect(f.manager.creates).toHaveLength(1)
  expect(f.manager.attaches).toHaveLength(0)
  expect(f.manager.turns).toHaveLength(repairs + 1)
  expect(f.reservations.size).toBe(repairs)
  expect(f.prepared).toEqual([f.candidate.id])
  for (const [index, turn] of f.manager.turns.slice(1).entries()) {
    expect(turn.session).toEqual(f.manager.session)
    expect(turn.input.clientCorrelationId).toBe(`execution:${f.candidate.id}:result-repair:${index + 1}`)
    expect(turn.input.prompt).toContain('Validation issues:')
    expect(turn.input.prompt).toContain('"path":["routing","outcome"]')
    expect(turn.input.prompt).toContain(f.input.workHandoffContract)
  }
  expect(f.updates.filter(execution => execution.state === 'completed')).toHaveLength(1)
})

it('fails with the original work result code after two invalid corrections and never repairs a terminal replay', async () => {
  const f = workResultFixture([invalidWorkResult])
  const result = await f.coordinator.observeExact(f.input)
  expect(result).toMatchObject({ state: 'completed', result: {
    outcome: 'failed', error: { code: 'WORK_RESULT_INVALID', retryable: false },
  } })
  expect(f.manager.turns).toHaveLength(3)
  expect(f.reservations.size).toBe(2)
  await f.coordinator.observeExact(f.input)
  expect(f.manager.turns).toHaveLength(3)
})

it('does not send a repair turn for a valid work result', async () => {
  const f = workResultFixture([validWorkResult])
  expect(await f.coordinator.observeExact(f.input)).toMatchObject({ state: 'completed', result: validWorkResult })
  expect(f.manager.turns).toHaveLength(1)
  expect(f.reservations.size).toBe(0)
})

it('keeps the original code when a corrective turn fails natively', async () => {
  const nativeFailure: ExecutionResult = { outcome: 'failed', error: {
    code: 'NATIVE_ERROR', message: 'The corrective turn failed', retryable: true,
  } }
  const f = workResultFixture([invalidWorkResult, nativeFailure])
  expect(await f.coordinator.observeExact(f.input)).toMatchObject({ state: 'completed', result: {
    outcome: 'failed', error: { code: 'WORK_RESULT_INVALID', retryable: false },
  } })
  expect(f.manager.turns).toHaveLength(2)
})

it('retains the repair allowance and session through an approval pause', async () => {
  const f = workResultFixture([invalidWorkResult, invalidWorkResult, validWorkResult])
  const start = f.manager.startTurn.bind(f.manager)
  f.manager.startTurn = async function* (...args) {
    for await (const event of start(...args)) {
      if (this.turns.length === 2) this.snapshot.pendingInteractions = [{ ...f.pending('repair-approval'),
        turn: { nativeTurnId: 'workflow-turn-1', nativeRequestId: 'repair-approval' } }]
      yield event
    }
  }
  const waiting = await f.coordinator.observeExact(f.input)
  expect(waiting.state).toBe('waiting')
  expect(f.reservations.size).toBe(1)
  expect(f.manager.turns).toHaveLength(2)
  f.delivered('repair-approval')
  f.manager.snapshot.pendingInteractions = []
  expect(await f.coordinator.observeExact(f.input)).toMatchObject({ state: 'completed', result: validWorkResult })
  expect(f.reservations.size).toBe(2)
  expect(f.manager.turns).toHaveLength(3)
  expect(f.manager.creates).toHaveLength(1)
})

it('rechecks the native boundary after reserving a correction', async () => {
  const f = workResultFixture([invalidWorkResult, validWorkResult])
  const boundary = f.store.assertNativeBoundary.bind(f.store)
  f.store.assertNativeBoundary = async id => {
    await boundary(id)
    if (f.reservations.size) throw new DomainError('GRAPH_STOP_CONFLICT', 'Stopped before correction', 409)
  }
  await expect(f.coordinator.observeExact(f.input)).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
  expect(f.manager.turns).toHaveLength(1)
})

it('publishes queued native events before committing their complete terminal history', async () => {
  const f = fixture()
  const published: HarnessNativeEvent[] = []
  const append = f.runs.appendNativeEvents.bind(f.runs)
  f.runs.appendNativeEvents = async (...args) => {
    await append(...args)
    published.push(...args[0].map(({ event }) => structuredClone(event)))
  }
  const update = f.runs.updateExecution.bind(f.runs)
  f.runs.updateExecution = async (...args) => {
    if (args[0].state === 'completed') {
      const lane = await f.interactions.coordination.getLane('codex', f.manager.session.nativeSessionId)
      assert.equal(lane?.currentTurnOrMessageId, 'workflow-turn')
      assert.ok(lane?.leaseToken)
      assert.deepEqual(published, events.map(event => ({ ...event, executionId: f.candidate.id })))
    }
    return update(...args)
  }
  let consumed = 0
  const events = Array.from({ length: 8 }, (_, sequence) => ({ sequence, type: 'native.notification',
    occurredAt: now, payload: { original: `queued-${sequence}` } }))
  f.manager.snapshot = { events, pendingInteractions: [], terminalResult: success }
  f.manager.startTurn = async function* (session, input, signal) {
    f.manager.turns.push({ session, input, ...(signal ? { signal } : {}) })
    for (const event of events) { consumed++; yield event }
  }
  const completed = await f.coordinator.observeExact(f.input)
  assert.equal(completed.state, 'completed')
  assert.equal(consumed, events.length)
  assert.equal(f.manager.turns.length, 1)
  assert.deepEqual(f.executions.get(f.candidate.id)?.result, success)
  assert.equal(f.capturedSourceKinds.filter((kind) => kind === 'history').length, 1)
  assert.equal(f.manager.closed.length, 1)
})

it('continues observing normal native work after approval without replay or credential revocation', async () => {
  const f = fixture()
  f.snapshot('request-a')
  assert.equal((await f.coordinator.observeExact(f.input)).state, 'waiting')
  assert.deepEqual(f.resumes, [f.candidate.id])
  f.delivered('request-a')
  f.snapshot()
  let observations = 0
  f.manager.onHistory = () => {
    assert.equal(f.revoked.length, 0)
    if (++observations === 3) f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  }
  const result = await f.coordinator.observeExact(f.input)
  assert.equal(result.state, 'completed')
  assert.equal(observations, 3)
  assert.equal(f.manager.creates.length, 1)
  assert.equal(f.manager.turns.length, 1)
  assert.equal(f.manager.responses, 0)
  assert.deepEqual(f.prepared, [f.candidate.id])
  assert.deepEqual(f.resumes, [f.candidate.id, f.candidate.id])
  assert.deepEqual(f.revoked, [f.candidate.id])
  assert.ok(f.manager.observed.every((session) => session.nativeSessionId === f.manager.session.nativeSessionId))
})

it('persists a later approval under its own exact request and does not return the prior delivery', async () => {
  const f = fixture()
  f.snapshot('request-a')
  const first = await f.coordinator.observeExact(f.input)
  assert.equal(first.state, 'waiting')
  const delivered = f.delivered('request-a')
  f.snapshot('request-b')
  const second = await f.coordinator.observeExact(f.input)
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
  const observed = await f.coordinator.observeExact(f.input)
  assert.equal(observed.state, 'waiting')
  if (observed.state !== 'waiting') throw new Error('expected approval')
  assert.deepEqual(observed.interaction.reviewContext, {
    target: '/accepted/[REDACTED].ts', changeSummary: '1 file; 1 added, 1 removed lines. Patch contents are not shown here.',
  })
  assert.equal(JSON.stringify(observed.interaction).includes('test-scoped-token'), false)
})

it('ignores an already-delivered native ask until its same turn becomes terminal', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.delivered('request-a')
  let observed = 0
  f.manager.onHistory = () => {
    if (++observed === 2) f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  }
  assert.equal((await f.coordinator.observeExact(f.input)).state, 'completed')
  assert.equal(f.records.size, 1)
  assert.equal(f.manager.turns.length, 1)
})

it('reuses a resident Codex App-MCP context without attaching, replacing credentials, or closing it', async () => {
  const f = fixture()
  f.snapshot('request-a')
  const waiting = await f.coordinator.observeExact(f.input)
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
  const waiting = await f.coordinator.observeExact(f.input)
  if (waiting.state !== 'waiting') throw new Error('expected approval')
  const reads = f.manager.observed.length
  await assert.rejects(f.coordinator.attachInteraction({ ...waiting.interaction, nativeSessionId: 'other-session' }), /ownership context/)
  assert.equal(f.manager.observed.length, reads)
  assert.equal(f.manager.closed.length, 0)
})

it('reconstructs cold attachment from the ensured durable execution rather than a fresh candidate', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, { ...f.candidate, state: 'running', nativeSessionId: f.manager.session.nativeSessionId })
  await f.interactions.coordination.ensureLane({
    id: 'saved-workflow-lane', harness: 'codex', nativeSessionId: f.manager.session.nativeSessionId,
    ownerAgentId: f.candidate.agentId, correlationId: `execution:${f.candidate.id}`,
    currentTurnOrMessageId: 'workflow-turn', observedStatus: 'disconnected',
    revision: 0, connectionGeneration: 0, observedAt: now,
  })
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  await assert.rejects(f.coordinator.observeExact({ ...f.input,
    execution: { ...f.candidate, id: 'fresh-candidate', input: { wrong: true } },
  }), { code: 'EXECUTION_NOT_FOUND' })
  assert.equal(f.manager.attaches.length, 0)
  const observation = await f.coordinator.observeExact(f.input)
  assert.equal(observation.execution.id, f.candidate.id)
  const attached = f.manager.attaches[0]!
  assert.notEqual(attached.kind, 'operator')
  if (!isWorkflowStart(attached)) throw new Error('expected workflow')
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
  f.loseLaunch()
  await assert.rejects(f.coordinator.observeExact(f.input), { code: 'NATIVE_SESSION_START_UNCERTAIN' })
  assert.equal(f.manager.creates.length, 0)
  assert.equal(f.manager.turns.length, 0)
  assert.equal(f.executions.get(f.candidate.id)?.result, undefined)
})

for (const failure of ['prepare', 'create', 'turn', 'activity', 'budget'] as const) {
  it(`preserves uncertain execution after a ${failure} transport or persistence failure`, async () => {
    const f = fixture()
    const error = new Error(`${failure} failed`)
    f.snapshot('request-a')
    if (failure === 'prepare') f.failPrepare(error)
    if (failure === 'create') f.manager.createError = error
    if (failure === 'turn') f.manager.turnError = error
    if (failure === 'activity') f.failActivity(error)
    if (failure === 'budget') f.failBudget(error)
    await assert.rejects(f.coordinator.observeExact(f.input), error)
    assert.notEqual(f.executions.get(f.candidate.id)?.state, 'completed')
    assert.equal(f.negativeSettlements.length, 0)
    assert.equal(f.executions.get(f.candidate.id)?.finishedAt, undefined)
    assert.equal(f.revoked.length, 0)
  })
}

it('settles resumed history failure using the durable identity and preserves the native failure code', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.delivered('request-a')
  f.manager.historyError = new HarnessExecutionError('TRANSPORT_LOST', 'The native transport disconnected.')
  await assert.rejects(f.coordinator.observeExact(f.input), /disconnected/)
  assert.deepEqual(f.negativeSettlements, [{ id: f.candidate.id, canceled: false }])
  assert.equal(f.manager.canceled.length, 1)
  assert.equal(f.manager.closed.length, 1)
  assert.equal(f.updates.some((item) => item.id === 'fresh-candidate'), false)
})

it('does not return an old delivered interaction when cold attachment fails', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.delivered('request-a')
  f.resolver.release({ harness: f.manager.harness, executionId: f.candidate.id, agentId: f.candidate.agentId,
    workingDirectory: f.candidate.workingDirectory!, configuration: f.configuration })
  f.manager.attachError = new Error('native session unavailable')
  await assert.rejects(f.coordinator.observeExact(f.input), /native session unavailable/)
  assert.notEqual(f.executions.get(f.candidate.id)?.state, 'completed')
  assert.equal(f.executions.get(f.candidate.id)?.result, undefined)
  assert.equal(f.manager.creates.length, 1)
  assert.equal(f.manager.turns.length, 1)
})

it('handles cancellation during post-approval observation without replay', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.delivered('request-a')
  f.snapshot()
  f.manager.onHistory = () => {
    // The authorized Stop commits before its cancellation signal reaches native work.
    f.stopFence()
    f.controller.abort()
  }
  await assert.rejects(f.coordinator.observeExact(f.input))
  await f.coordinator.cancelRun(f.candidate.runId, f.owner)
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
  assert.equal(f.manager.turns.length, 1)
  assert.equal(f.manager.canceled.length, 1)
  assert.deepEqual([...new Set(f.revoked)], [f.candidate.id])
  assert.deepEqual(f.negativeSettlements, [{ id: f.candidate.id, canceled: true }])
})

it('passes the abort signal to the initial native turn', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  const nativeSignal = f.manager.turns[0]?.signal
  assert.ok(nativeSignal)
  assert.equal(nativeSignal.aborted, false)
  f.controller.abort(new Error('cancel execution'))
  assert.equal(nativeSignal.aborted, true)
})

it('returns a terminal canceled result without replacing the native session', async () => {
  const f = fixture()
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: { outcome: 'canceled' } }
  const observation = await f.coordinator.observeExact(f.input)
  assert.equal(observation.state, 'completed')
  assert.equal(observation.execution.result?.outcome, 'canceled')
  assert.equal(f.manager.creates.length, 1)
  assert.equal(f.manager.closed.length, 1)
})

it('returns a completed durable result before checking its stopped active-time budget', async () => {
  const f = fixture()
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  await f.coordinator.observeExact(f.input)
  const reads = f.manager.observed.length
  f.failBudget(new Error('budget already stopped'))
  const observation = await f.coordinator.observeExact(f.input)
  assert.equal(observation.state, 'completed')
  assert.equal(f.manager.creates.length, 1)
  assert.equal(f.manager.observed.length, reads)
})

it('cannot return a native ask whose original-source publication did not commit', async () => {
  const f = fixture()
  f.snapshot('request-a')
  f.interactions.getNativeRequest = async () => undefined
  await assert.rejects(f.coordinator.observeExact(f.input), { code: 'APPROVAL_ORIGINAL_SOURCE_REQUIRED' })
  assert.equal(f.executions.get(f.candidate.id)?.result, undefined)
  assert.equal(f.manager.responses, 0)
})

it('consumes only delivered resume identities belonging to this exact durable execution', async () => {
  const f = fixture()
  f.snapshot('request-a', 'request-b')
  const waiting = await f.coordinator.observeExact(f.input)
  if (waiting.state !== 'waiting') throw new Error('expected approval')
  const a = f.delivered('request-a')
  await f.coordinator.assertResume(waiting.execution, { interactionId: a.id })
  const b = [...f.records.values()].find((item) => item.nativeRequestId === 'request-b')!
  await assert.rejects(f.coordinator.assertResume(waiting.execution, { interactionId: b.id }), /not a delivered interaction/)
  await assert.rejects(f.coordinator.assertResume({ ...waiting.execution, id: 'other-execution' }, { interactionId: a.id }))
  await assert.rejects(f.coordinator.assertResume({ ...waiting.execution, nativeSessionId: 'other-session' }, { interactionId: a.id }))
  await assert.rejects(f.coordinator.assertResume(waiting.execution, undefined))
  f.records.set(a.id, { ...a, harness: 'claude' })
  await assert.rejects(f.coordinator.assertResume(waiting.execution, { interactionId: a.id }))
  assert.equal(f.manager.responses, 0)
})

it('settles every unfinished execution on owned run cleanup even if one budget stop fails', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, f.candidate)
  f.executions.set('execution-sibling', { ...f.candidate, id: 'execution-sibling', workflowNodeId: 'sibling', state: 'waiting' })
  f.executions.set('execution-success', { ...f.candidate, id: 'execution-success', workflowNodeId: 'success',
    state: 'completed', result: success, finishedAt: now })
  f.stopFence()
  f.failStop(new Error('budget cleanup unavailable'))
  await assert.rejects(f.coordinator.cancelRun(f.candidate.runId, f.owner), AggregateError)
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
  assert.equal(f.executions.get('execution-sibling')?.result, undefined)
  assert.equal(f.negativeSettlements.length, 0)
  assert.deepEqual(f.executions.get('execution-success')?.result, success)
  assert.equal(f.cancelPendingCalls(), 1)
  assert.equal(f.revoked.length, 3)
})

it('does not overwrite a live execution when cancellation is requested without its owner', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, f.candidate)
  await assert.rejects(f.coordinator.cancelRun(f.candidate.runId), { code: 'GRAPH_STOP_CONFLICT' })
  assert.equal(f.executions.get(f.candidate.id)?.state, 'starting')
  assert.equal(f.updates.length, 0)
})

it('rejects a cold attach that returns a different native identity', async () => {
  const f = fixture()
  f.executions.set(f.candidate.id, { ...f.candidate, state: 'running', nativeSessionId: f.manager.session.nativeSessionId })
  f.manager.attachedSession = { ...f.manager.session, nativeSessionId: 'replacement-session' }
  await assert.rejects(f.coordinator.observeExact(f.input), /different session identity/)
  assert.equal(f.manager.creates.length, 0)
  assert.equal(f.manager.turns.length, 0)
  assert.equal(f.executions.get(f.candidate.id)?.nativeSessionId, f.manager.session.nativeSessionId)
})

it('settles an active-time timeout detected by a budget check before the timer aborts', async () => {
  const f = fixture()
  const startTurn = f.manager.startTurn.bind(f.manager)
  f.manager.startTurn = async function* (session, input, signal) {
    for await (const event of startTurn(session, input, signal)) {
      assert.equal(signal?.aborted, false)
      f.failBudget(new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'active budget exhausted', 409))
      yield event
    }
  }
  await assert.rejects(f.coordinator.observeExact(f.input), { code: 'EXECUTION_ACTIVE_TIMEOUT' })
  assert.equal(f.manager.turns.length, 1)
  assert.deepEqual(f.manager.canceled, [f.manager.session])
  assert.deepEqual(f.manager.closed, [f.manager.session])
  assert.deepEqual(f.stops, [f.candidate.id])
  assert.deepEqual(f.revoked, [f.candidate.id])
  assert.deepEqual(f.negativeSettlements, [{ id: f.candidate.id, canceled: false }])
})

it('stops post-approval observation when the active-time budget expires', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.delivered('request-a')
  f.snapshot()
  f.manager.onHistory = () => f.failBudget(new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'active budget exhausted', 409))
  await assert.rejects(f.coordinator.observeExact(f.input), /active budget exhausted/)
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
  assert.equal(f.manager.turns.length, 1)
  assert.deepEqual(f.manager.canceled, [f.manager.session])
  assert.deepEqual(f.manager.closed, [f.manager.session])
  assert.deepEqual(f.negativeSettlements, [{ id: f.candidate.id, canceled: false }])
})

it('does not accept a terminal success when cancellation arrives during the history read', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.delivered('request-a')
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  f.manager.onHistory = () => f.controller.abort()
  await assert.rejects(f.coordinator.observeExact(f.input))
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
  assert.equal(f.manager.turns.length, 1)
})

it('retries a failed budget stop after closing the resident native session', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.stopFence()
  f.failStop(new Error('budget stop failed'))
  await f.coordinator.cancelRun(f.candidate.runId, f.owner)
  assert.equal(f.manager.canceled.length, 1)
  assert.equal(f.manager.closed.length, 1)
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
  assert.deepEqual(f.stops, [f.candidate.id, f.candidate.id])
  assert.deepEqual(f.revoked, [f.candidate.id, f.candidate.id, f.candidate.id])
  assert.equal(f.cancelPendingCalls(), 2)
  assert.deepEqual(f.negativeSettlements, [{ id: f.candidate.id, canceled: true }])
})

it('keeps cleanup retryable when stopping the budget keeps failing', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.stopFence()
  f.budgets.stop = async id => {
    f.stops.push(id)
    throw new Error('budget stop failed')
  }
  await assert.rejects(f.coordinator.cancelRun(f.candidate.runId, f.owner), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.ok(error.errors.some(failure => failure instanceof Error
      && failure.cause instanceof Error && failure.cause.message === 'budget stop failed'))
    return true
  })
  assert.equal(f.manager.canceled.length, 1)
  assert.equal(f.manager.closed.length, 1)
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
  assert.deepEqual(f.stops, [f.candidate.id, f.candidate.id])
  assert.equal(f.cancelPendingCalls(), 2)
  assert.deepEqual(f.negativeSettlements, [])
})

it('does not stop the shared budget or revoke replacement credentials after ownership is lost', async () => {
  const f = fixture()
  f.snapshot('request-a')
  await f.coordinator.observeExact(f.input)
  f.delivered('request-a')
  f.snapshot()
  f.manager.onHistory = () => {
    f.owner.assertOwned = () => { throw new Error('execution owner disconnected') }
  }
  await assert.rejects(f.coordinator.observeExact(f.input), /owner disconnected/)
  assert.equal(f.stops.length, 0)
  assert.equal(f.revoked.length, 0)
  assert.equal(f.manager.canceled.length, 0)
  assert.equal(f.manager.closed.length, 0)
})

it.each([undefined, 3_600_000])('initializes an execution budget from the workflow or server default (%s)', async (override) => {
  const f = fixture()
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  const observation = await f.coordinator.observeExact({ ...f.input, agentActiveTimeoutMs: override })
  assert.equal(observation.state, 'completed')
  assert.equal(await f.budgets.remaining(f.candidate.id), override ?? 60_000)
})

it('preserves the initialized budget across an approval wait and recovery', async () => {
  const f = fixture()
  f.snapshot('approve-budget')
  assert.equal((await f.coordinator.observeExact({ ...f.input, agentActiveTimeoutMs: 3_600_000 })).state, 'waiting')
  f.delivered('approve-budget')
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  assert.equal((await f.coordinator.observeExact(f.input)).state, 'completed')
  assert.equal(await f.budgets.remaining(f.candidate.id), 3_600_000)
})

it('aborts a stalled native iterator at its workflow active-time budget', async () => {
  const f = fixture()
  f.manager.startTurn = async function* () { await new Promise(() => undefined); yield {} as NativeHarnessEvent }
  await assert.rejects(f.coordinator.observeExact({ ...f.input, agentActiveTimeoutMs: 20 }),
    { code: 'EXECUTION_ACTIVE_TIMEOUT' })
  assert.equal(f.manager.canceled.length, 1)
  assert.equal(f.manager.closed.length, 1)
})

it('aborts a stalled native iterator at its own remaining execution budget', async () => {
  const f = fixture()
  f.budgets.remaining = async () => 20
  f.manager.startTurn = async function* () { await new Promise(() => undefined); yield {} as NativeHarnessEvent }
  const started = Date.now()
  await assert.rejects(f.coordinator.observeExact(f.input), { code: 'EXECUTION_ACTIVE_TIMEOUT' })
  assert.ok(Date.now() - started < 1000)
  assert.equal(f.manager.canceled.length, 1)
  assert.equal(f.manager.closed.length, 1)
  assert.equal(f.executions.get(f.candidate.id)?.result, undefined)
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
})

it('refuses a generic terminal result that belongs to a different native turn', async () => {
  const f = fixture()
  f.budgets.remaining = async () => 30
  f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: success }
  f.manager.reconcile = async () => ({ events: [], pendingInteractions: [], terminalResult: success,
    terminalTurn: { correlationId: 'unrelated-review', providerId: 'review-turn', result: success } })
  await assert.rejects(f.coordinator.observeExact(f.input), (error: unknown) => error instanceof DomainError && error.code === 'EXECUTION_ACTIVE_TIMEOUT'
    || error instanceof Error && error.cause instanceof DomainError && error.cause.code === 'EXECUTION_ACTIVE_TIMEOUT')
  assert.notEqual(f.executions.get(f.candidate.id)?.result?.outcome, 'succeeded')
})

it('does not replay sibling asks after exact provider completion', async () => {
  const f = fixture('codex')
  f.snapshot('first', 'sibling')
  await f.coordinator.observeExact(f.input)
  f.delivered('first')
  f.manager.snapshot = { events: [], pendingInteractions: [], canceledRequestIds: ['sibling'], terminalResult: success }
  const completed = await f.coordinator.observeExact(f.input)
  assert.equal(completed.state, 'completed')
  assert.equal(f.manager.responses, 0)
  assert.equal(f.manager.turns.length, 1)
  assert.equal([...f.records.values()].find((row) => row.nativeRequestId === 'first')?.status, 'delivered')
})

for (const boundary of ['terminal result', 'approval source', 'native error'] as const) {
  it(`redacts a historical App credential at the ${boundary} boundary`, async () => {
    const f = fixture()
    const historicalToken = `opm_${'a'.repeat(43)}`
    if (boundary === 'terminal result') {
      f.manager.snapshot = { events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded', output: { text: historicalToken } } }
      const observed = await f.coordinator.observeExact(f.input)
      assert.equal(JSON.stringify(observed).includes(historicalToken), false)
      assert.equal(JSON.stringify(f.updates).includes(historicalToken), false)
    } else if (boundary === 'approval source') {
      const pending = f.pending('historical-token-source')
      pending.request = { command: `echo ${historicalToken}` }
      f.manager.snapshot = { events: [], pendingInteractions: [pending] }
      const observed = await f.coordinator.observeExact(f.input)
      assert.equal(JSON.stringify(observed).includes(historicalToken), false)
      assert.equal(JSON.stringify([...f.records.values()]).includes(historicalToken), false)
    } else {
      f.manager.turnError = new Error(`Provider failed: ${historicalToken}`)
      let thrown: unknown
      try { await f.coordinator.observeExact(f.input) } catch (error) { thrown = error }
      assert.ok(thrown instanceof Error)
      assert.equal(thrown.message.includes(historicalToken), false)
    }
  })
}
