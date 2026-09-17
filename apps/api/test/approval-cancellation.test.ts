import assert from 'node:assert/strict'

import {
  DEFAULT_HARNESS_DEFAULTS,
  type AgentConfigurationVersion,
  type DurableInteraction,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type NativeHarnessEvent,
  type NativeSessionReference,
} from '@graphql/contracts'
import { MemorySaver, interrupt } from '@langchain/langgraph'
import { it } from 'vitest'
import type pg from 'pg'
import { nativeLanes } from './helpers/nativeLanes.js'

import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ExecutionScopedNativeSessionManagerResolver, type NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../src/modules/harnesses/port.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { WorkflowRun, WorkflowVersion } from '@graphql/contracts'

const now = '2026-09-16T00:00:00.000Z'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const never = () => new Promise<never>(() => undefined)
function configuration(id: string): AgentConfigurationVersion {
  return {
    id: `config-${id}`, workspaceId: 'workspace-1', contentHash: 'sha256:test', agentId: `agent-${id}`, version: 1, createdAt: now,
    harness: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [],
  } as AgentConfigurationVersion
}
function execution(id: string, state: HarnessExecution['state'] = 'waiting'): HarnessExecution {
  return {
    id, runId: 'run-1', workflowNodeId: `node-${id}`, agentId: `agent-${id}`,
    agentConfigurationVersionId: `config-${id}`, workingDirectory: '/project', runtimeDirectory: '/runtime',
    attempt: 1, input: {}, state, createdAt: now,
    ...(state === 'starting' ? {} : { nativeSessionId: `native-${id}` }),
    ...(state === 'completed' ? { result: { outcome: 'canceled' as const }, finishedAt: now } : {}),
  }
}
function interaction(item: HarnessExecution, status: DurableInteraction['status'] = 'pending'): DurableInteraction {
  const decided = status === 'pending' ? {} : {
    selectedOptionId: 'reject', selectedSemantic: 'reject' as const,
    nativeResponse: { decision: 'reject' }, decidedAt: now,
  }
  return {
    id: `interaction-${item.id}`, revision: 4, workspaceId: 'workspace-1', workflowId: 'workflow-1',
    runId: item.runId, executionId: item.id, requestingAgentId: item.agentId,
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: `native-${item.id}`,
    nativeRequestId: `request-${item.id}`, nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: item.runId, request: { command: 'test' }, approval: { handler: 'user' },
    responseOptions: [{ optionId: 'reject', semantic: 'reject', label: 'Reject', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    ...decided, status, deliveryState: status === 'delivery_failed' ? 'failed'
      : status === 'delivery_pending' ? 'pending' : 'not_started', createdAt: now, updatedAt: now,
  }
}

class Manager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  cancelImpl = async () => true
  closeImpl = async () => undefined
  capabilitiesImpl = async () => ({ provider: this.harness, providerVersion: '0.154.0', persistentSessions: true,
    reconnect: true, sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true,
    mcpDetection: true, supportedInteractionKinds: ['approval'] })
  createImpl = async (): Promise<NativeSessionReference> => ({ harness: this.harness, providerVersion: '0.154.0', nativeSessionId: `native-${this.id}` })
  attachImpl = async (session: NativeSessionReference) => session
  turnImpl: (signal?: AbortSignal) => AsyncIterable<NativeHarnessEvent> = async function* () { yield { sequence: 0, type: 'turn.completed', occurredAt: now, payload: {} } }
  pendingValue: ReturnType<typeof interaction> | undefined
  started = false
  constructor(readonly id: string, readonly calls: string[]) {}
  async capabilities() { this.calls.push(`capabilities:${this.id}`); return this.capabilitiesImpl() }
  async inspectMcp(): Promise<never> { throw new Error('not used') }
  async createSession() { this.calls.push(`create:${this.id}`); return this.createImpl() }
  async attachSession(session: NativeSessionReference) { this.calls.push(`attach:${this.id}`); return this.attachImpl(session) }
  startTurn(_session: NativeSessionReference, _input: unknown, signal?: AbortSignal) { this.started = true; return this.turnImpl(signal) }
  async pending() {
    const pending = this.pendingValue
    return pending ? { session: { harness: this.harness, providerVersion: pending.providerVersion, nativeSessionId: pending.nativeSessionId },
      turn: { nativeTurnId: 'turn-1', nativeRequestId: pending.nativeRequestId }, nativeRequestType: pending.nativeRequestType,
      request: pending.request, responseOptions: pending.responseOptions } : undefined
  }
  async respond() { throw new Error('Stop must never deliver a decision') }
  async cancel(session: NativeSessionReference, signal?: AbortSignal) {
    assert.equal(signal?.aborted, false, 'cleanup must have a fresh signal')
    assert.equal(session.nativeSessionId, `native-${this.id}`)
    assert.equal(session.providerVersion, '0.154.0')
    this.calls.push(`cancel:${this.id}`)
    return this.cancelImpl()
  }
  async close(session: NativeSessionReference) {
    assert.equal(session.nativeSessionId, `native-${this.id}`)
    this.calls.push(`close:${this.id}`)
    return this.closeImpl()
  }
  async history(): Promise<NativeHistory> {
    const pending = await this.pending()
    return pending ? { events: [], pendingInteractions: [pending] }
      : { events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } }
  }
  async reconcile(_session: NativeSessionReference, correlationId: string) {
    if (!this.started) return { events: [], pendingInteractions: [] }
    const history = await this.history()
    return { ...history, ...(history.terminalResult ? { terminalTurn: { correlationId, providerId: 'turn-1', result: history.terminalResult } } : {}) }
  }
}

function fixture(items: HarnessExecution[]) {
  const calls: string[] = []
  const rows = new Map(items.map((item) => [item.id, item]))
  const managers = new Map(items.map((item) => [item.id, new Manager(item.id, calls)]))
  const pending = new Map<string, DurableInteraction>()
  const runs = {
    listExecutions: async () => { calls.push('list'); return [...rows.values()] },
    getExecutionConfiguration: async (id: string) => configuration(id.slice('config-'.length)),
    ensureExecution: async (item: HarnessExecution) => ({ execution: rows.get(item.id) ?? item, created: !rows.get(item.id)?.nativeSessionId }),
    updateExecution: async (item: HarnessExecution) => { rows.set(item.id, item) },
    recordActivity: async () => undefined,
    appendNativeEvent: async () => undefined,
  }
  const interactions = {
    coordination: nativeLanes(),
    getForExecution: async (id: string) => pending.get(id),
    create: async (item: DurableInteraction) => { pending.set(item.executionId, item); return { interaction: item, created: true } },
    cancelPendingForExecution: async () => undefined,
    cancelPendingForRun: async () => { calls.push('interactions'); return 1 },
  }
  const budgets = { remaining: async () => 60_000, ensure: async () => undefined, assertActive: async () => undefined, beginWait: async () => undefined,
    finish: async () => undefined, resume: async () => undefined,
    stop: async (id: string) => { calls.push(`budget:${id}`) } }
  const credentials = {
    prepare: async () => ({ credential: { principalId: 'fixture-principal', expiresAt: new Date(Date.now() + 900_000).toISOString(), environment: { agentId: 'agent', variables: {} } } }),
    revokeForExecution: async (id: string) => { calls.push(`revoke:${id}`) },
  }
  const rawResolver = new ExecutionScopedNativeSessionManagerResolver((context) => managers.get(context.executionId)!)
  const contextFor = (item: HarnessExecution) => ({ executionId: item.id, agentId: item.agentId,
    harness: 'codex' as const, workingDirectory: '/project', configuration: configuration(item.id) })
  for (const item of items) if (item.nativeSessionId) {
    const resolved = rawResolver.resolve(contextFor(item))
    resolved.beginStart!(); resolved.markResident!()
  }
  const resolver: NativeSessionManagerResolver = {
    resolve: (context) => rawResolver.resolve(context),
    release: (context, manager, state) => { calls.push(`release:${context.executionId}`); rawResolver.release(context, manager, state) },
  }
  const coordinator = new ApprovalExecutionCoordinator(
    runs as unknown as PostgresRunRepository, interactions as unknown as PostgresInteractionRepository,
    budgets as unknown as PostgresApprovalBudgetRepository, resolver as NativeSessionManagerResolver, 60_000,
    credentials as unknown as ExecutionCredentialProvider,
  )
  const observe = (item: HarnessExecution, signal = new AbortController().signal) => coordinator.ensureObserve({
    candidate: item, owner: { client: {}, assertOwned() {} } as RunOwnership, graphThreadId: item.runId,
    workflowId: 'workflow-1', approval: { handler: 'user' }, signal,
    request: { executionId: item.id, runId: item.runId, workspaceId: 'workspace-1', workflowNodeId: item.workflowNodeId,
      workingDirectory: item.workingDirectory!, runtimeDirectory: item.runtimeDirectory!, configuration: configuration(item.id), input: {} } as HarnessExecutionRequest,
  })
  return { calls, rows, managers, pending, runs, interactions, budgets, credentials, resolver, coordinator, observe,
    cold: (item: HarnessExecution) => rawResolver.release(contextFor(item)),
  }
}

it('cancels completed database executions that still have resident native sessions (#13)', async () => {
  const f = fixture([execution('one', 'completed')])
  await f.coordinator.cancelRun('run-1')
  assert.ok(f.calls.includes('cancel:one'))
  assert.ok(f.calls.indexOf('close:one') < f.calls.indexOf('budget:one'))
  assert.ok(!f.calls.some((call) => call.startsWith('create:') || call.startsWith('attach:')))
})

it('cleans every sibling despite cancellation, close, budget, and credential failures (#23)', async () => {
  const f = fixture([execution('one'), execution('two'), execution('three')])
  f.managers.get('one')!.cancelImpl = async () => { throw new Error('cancel failed') }
  f.managers.get('one')!.closeImpl = async () => { throw new Error('close failed') }
  f.budgets.stop = async (id) => { f.calls.push(`budget:${id}`); if (id === 'one') throw new Error('budget failed') }
  f.credentials.revokeForExecution = async (id) => { f.calls.push(`revoke:${id}`); if (id === 'one') throw new Error('revoke failed') }
  const error = await f.coordinator.cancelRun('run-1').catch((value: unknown) => value)
  assert.ok(error instanceof AggregateError)
  assert.ok(error.errors.length >= 4)
  for (const id of ['one', 'two', 'three']) {
    for (const operation of ['cancel', 'close', 'budget', 'revoke']) assert.ok(f.calls.includes(`${operation}:${id}`))
  }
  assert.ok(f.calls.includes('interactions'))
  assert.ok(!f.calls.includes('release:one'), 'unconfirmed native closure must remain supervised')
  assert.deepEqual(f.coordinator.residentRunIds(), ['run-1'])
})

it('a capability failure does not skip sibling cleanup or execution credential revocation', async () => {
  const f = fixture([execution('one'), execution('two')])
  f.managers.get('one')!.capabilitiesImpl = async () => { throw new Error('capabilities failed') }
  await assert.rejects(f.coordinator.cancelRun('run-1'), AggregateError)
  assert.ok(f.calls.includes('close:two'))
  assert.ok(f.calls.includes('revoke:one'))
  assert.ok(f.calls.includes('budget:one'))
})

it('uses the persisted native identity instead of capabilities when canceling a waiting interaction', async () => {
  const item = execution('one')
  const f = fixture([item])
  f.pending.set(item.id, interaction(item, 'delivery_failed'))
  f.managers.get(item.id)!.capabilitiesImpl = async () => { throw new Error('must not be called') }
  await f.coordinator.cancelRun(item.runId)
  assert.ok(!f.calls.includes('capabilities:one'))
  assert.ok(f.calls.includes('close:one'))
})

it('bounds a hung native cancel, still closes it, and cancels siblings (#20)', async () => {
  const f = fixture([execution('one'), execution('two')])
  f.managers.get('one')!.cancelImpl = never
  await assert.rejects(f.coordinator.cancelRun('run-1'), AggregateError)
  assert.ok(f.calls.includes('close:one'))
  assert.ok(f.calls.indexOf('close:two') < f.calls.indexOf('close:one'))
  assert.ok(f.calls.includes('interactions'))
}, 20_000)

it('retains a timed-out native close for retry instead of evicting the manager', async () => {
  const f = fixture([execution('one'), execution('two')])
  f.managers.get('one')!.closeImpl = never
  await assert.rejects(f.coordinator.cancelRun('run-1'), AggregateError)
  assert.ok(!f.calls.includes('release:one'))
  assert.ok(f.calls.includes('release:two'))
  f.managers.get('one')!.closeImpl = async () => undefined
  await f.coordinator.cancelRun('run-1')
  assert.ok(f.calls.includes('release:one'))
  assert.deepEqual(f.coordinator.residentRunIds(), [])
}, 20_000)

it('passes an execution-owned abort signal to native iteration and cancels before database discovery', async () => {
  const item = execution('one', 'starting')
  const f = fixture([item])
  const entered = deferred<AbortSignal>()
  f.managers.get('one')!.turnImpl = async function* (signal) {
    assert.ok(signal)
    entered.resolve(signal)
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    signal.throwIfAborted()
    yield { sequence: 0, type: 'unreachable', occurredAt: now, payload: {} }
  }
  const observed = f.observe(item).catch((error: unknown) => error)
  const signal = await entered.promise
  f.runs.listExecutions = async () => { assert.equal(signal.aborted, true); throw new Error('database unavailable') }
  await assert.rejects(f.coordinator.cancelRun(item.runId), AggregateError)
  assert.equal(signal.aborted, true)
  assert.ok(await observed instanceof Error)
  assert.ok(f.calls.includes('cancel:one'))
  assert.ok(f.calls.includes('close:one'))
  assert.ok(f.calls.includes('budget:one'))
})

it('keeps waiting sessions resident, preserves exact identities, and makes repeated Stop idempotent', async () => {
  const item = execution('one', 'starting')
  const f = fixture([item])
  f.managers.get('one')!.pendingValue = interaction(item)
  const waiting = await f.observe(item)
  assert.equal(waiting.state, 'waiting')
  assert.deepEqual(f.coordinator.residentRunIds(), [item.runId])
  assert.ok(!f.calls.includes('close:one'))
  // Reproduce the database row becoming terminal before native cleanup.
  f.rows.set(item.id, { ...execution('one', 'completed') })
  await Promise.all([f.coordinator.cancelRun(item.runId), f.coordinator.cancelRun(item.runId)])
  await f.coordinator.cancelRun(item.runId)
  assert.equal(f.calls.filter((call) => call === 'create:one').length, 1)
  assert.equal(f.calls.filter((call) => call === 'close:one').length, 1)
  assert.equal(f.pending.get(item.id)?.nativeRequestId, 'request-one')
})

it('does not start replacement native work when Stop finds a nonresident session', async () => {
  const f = fixture([execution('one')])
  const resolver: NativeSessionManagerResolver = { resolve: () => ({ manager: f.managers.get('one')!, processState: 'needs_start' }), release: () => undefined }
  const coordinator = new ApprovalExecutionCoordinator(f.runs as unknown as PostgresRunRepository,
    f.interactions as unknown as PostgresInteractionRepository, f.budgets as unknown as PostgresApprovalBudgetRepository, resolver, 60_000)
  await assert.rejects(coordinator.cancelRun('run-1'), AggregateError)
  assert.ok(!f.calls.some((call) => call.startsWith('create:') || call.startsWith('attach:')))
})

it('closes a session created concurrently with Stop before any turn is started', async () => {
  const item = execution('one', 'starting')
  const f = fixture([item])
  const creating = deferred<void>()
  const opened = deferred<NativeSessionReference>()
  f.managers.get('one')!.createImpl = async () => { creating.resolve(); return opened.promise }
  f.managers.get('one')!.turnImpl = () => { throw new Error('a stopped execution must not start a turn') }
  const observed = f.observe(item).catch((error: unknown) => error)
  await creating.promise
  const stopping = f.coordinator.cancelRun(item.runId)
  opened.resolve({ harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-one' })
  await stopping
  assert.ok(await observed instanceof Error)
  assert.ok(f.calls.includes('cancel:one'))
  assert.ok(f.calls.includes('close:one'))
})

it('Stop cancels every unresolved SQL state including delivery_failed without changing native identity (#31)', async () => {
  const states = ['pending', 'decided', 'delivery_pending', 'delivery_failed'] as const
  const rows = states.map((status, index) => interaction(execution(String(index)), status))
  const updated: DurableInteraction[] = []
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('select id,record')) {
        for (const state of states) assert.ok(sql.includes(`'${state}'`))
        assert.ok(sql.includes('for update'))
        return { rows: rows.map((record) => ({ id: record.id, record })), rowCount: rows.length }
      }
      if (sql.startsWith('update durable_interactions')) updated.push(JSON.parse(values![3] as string) as DurableInteraction)
      return { rows: [], rowCount: 1 }
    }, release: () => undefined,
  }
  const repository = new PostgresInteractionRepository({ connect: async () => client } as unknown as pg.Pool)
  assert.equal(await repository.cancelPendingForRun('run-1'), 4)
  for (const [index, item] of updated.entries()) {
    assert.equal(item.status, 'canceled')
    assert.equal(item.revision, rows[index]!.revision + 1)
    assert.equal(item.nativeRequestId, rows[index]!.nativeRequestId)
    assert.equal(item.nativeSessionId, rows[index]!.nativeSessionId)
  }
})

function engineFixture(approvals: ApprovalExecutionCoordinator) {
  Object.assign(approvals, { finishRun: async () => undefined, reconcileReviews: async () => undefined, reviewers: { shutdown: async () => undefined } })
  const calls: string[] = []
  let owned = true
  const owner = { client: {}, assertOwned: () => { if (!owned) throw new Error('ownership lost') }, release: async () => { calls.push('release-owner') } } as unknown as RunOwnership
  let run: WorkflowRun = {
    id: 'run-1', workspaceId: 'workspace-1', workflowId: 'workflow-1', workflowVersionId: 'version-1',
    agentConfigurationVersionIds: {}, executionState: 'waiting', outcome: 'pending', input: {},
    executionLocation: { runnerId: 'runner-1', rootPath: '/project', locationRevision: 1, identityHash: 'sha256:test' },
    executionCondition: { kind: 'manual' }, createdAt: now,
  }
  const version: WorkflowVersion = {
    id: 'version-1', workspaceId: 'workspace-1', workflowId: 'workflow-1', version: 1,
    entryNodeId: 'node-1', contentHash: 'sha256:test', createdAt: now, agentConfigurationVersionIds: {},
    definition: { id: 'workflow-1', workspaceId: 'workspace-1', name: 'Stop fixture', version: 1,
      executionCondition: { kind: 'manual' }, nodes: [{ id: 'node-1', agentId: 'agent-1', name: 'Agent' }], edges: [],
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 } },
  }
  const runs = {
    acquireOwnership: async () => owner,
    get: async () => run,
    settleOrphan: async (_id: string, _owner: RunOwnership, canceled: boolean) => {
      calls.push(`settle:${canceled}`)
      if (run.executionState === 'completed') return false
      run = canceled ? { ...run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: now }
        : { ...run, executionState: 'interrupted', outcome: 'pending' }
      return true
    },
    updateState: async (_id: string, update: Partial<WorkflowRun>) => { calls.push(`state:${update.executionState}:${update.outcome}`); run = { ...run, ...update } },
    getAcceptedResult: async () => ({ outcome: 'succeeded' as const }),
  }
  const nativeExecution = execution('one')
  const pendingInteraction = { ...interaction(nativeExecution), id: 'interaction-1', graphInterruptId: undefined }
  Object.assign(runs, { getExecution: async () => nativeExecution })
  const interactions = {
    get: async () => pendingInteraction,
    bindGraphInterrupt: async (_id: string, graphInterruptId: string) => ({ ...pendingInteraction, graphInterruptId }),
  }
  const engine = new LangGraphWorkflowEngine(runs as unknown as PostgresRunRepository,
    { getVersion: async () => version } as unknown as PostgresWorkflowRepository,
    approvals, new MemorySaver(), '/runtime',
    { revalidateSnapshot: async () => undefined } as unknown as WorkspaceLocationService, undefined,
    interactions as unknown as PostgresInteractionRepository)
  const internals = engine as unknown as {
    executeRun: (run: WorkflowRun, signal: AbortSignal, owner: RunOwnership) => Promise<void>
    executeNode: () => Promise<{ executionIds: Record<string, string> }>
    activeRuns: Map<string, AbortController>
    activeTasks: Map<string, Promise<void>>
  }
  return { engine, internals, runs, owner, calls, run: () => run, loseOwnership: () => { owned = false } }
}

it('cancels native sessions before settling an inactive waiting Run (#13)', async () => {
  const calls: string[] = []
  const f = engineFixture({ residentRunIds: () => ['run-1'], cancelRun: async () => { calls.push('native') } } as unknown as ApprovalExecutionCoordinator)
  const settle = f.runs.settleOrphan
  f.runs.settleOrphan = async (...args) => { assert.deepEqual(calls, ['native']); return settle(...args) }
  assert.equal(await f.engine.cancel('run-1'), true)
  assert.equal(f.run().outcome, 'canceled')
})

it('settles a cleanup failure as failed, never as a successful canceled Run (#23)', async () => {
  const f = engineFixture({ residentRunIds: () => ['run-1'], cancelRun: async () => { throw new Error('close failed') } } as unknown as ApprovalExecutionCoordinator)
  await assert.rejects(f.engine.cancel('run-1'), /close failed/)
  assert.equal(f.run().outcome, 'failed')
  assert.equal(f.run().result?.error?.code, 'RUN_CLEANUP_FAILED')
  assert.ok(f.calls.includes('release-owner'))
})

it('shutdown preserves resident waiting Runs for restart recovery', async () => {
  const canceled: string[] = []
  const f = engineFixture({ residentRunIds: () => ['one', 'two'], cancelRun: async (runId: string) => {
    canceled.push(runId)
    if (runId === 'one') throw new Error('one failed')
  } } as unknown as ApprovalExecutionCoordinator)
  await f.engine.shutdown()
  assert.deepEqual(canceled, [])
})

it('shutdown signals native cancellation before waiting for active graph tasks', async () => {
  const task = deferred<void>()
  const f = engineFixture({ residentRunIds: () => [], cancelRun: async () => { task.resolve() } } as unknown as ApprovalExecutionCoordinator)
  const controller = new AbortController()
  f.internals.activeRuns.set('run-1', controller)
  f.internals.activeTasks.set('run-1', task.promise)
  await f.engine.shutdown()
  assert.equal(controller.signal.aborted, true)
  assert.equal(f.run().outcome, 'canceled')
})

it('Stop still settles a Run when its active graph task races the transition to waiting', async () => {
  const f = engineFixture({ residentRunIds: () => ['run-1'], cancelRun: async () => undefined } as unknown as ApprovalExecutionCoordinator)
  f.internals.activeRuns.set('run-1', new AbortController())
  f.internals.activeTasks.set('run-1', Promise.resolve())
  await f.engine.cancel('run-1')
  assert.equal(f.run().outcome, 'canceled')
})

it('normal graph interrupts leave native sessions resident rather than canceling them', async () => {
  let cancellations = 0
  const f = engineFixture({ residentRunIds: () => ['run-1'], cancelRun: async () => { cancellations += 1 } } as unknown as ApprovalExecutionCoordinator)
  f.internals.executeNode = async () => { interrupt({ interactionId: 'interaction-1' }); return { executionIds: {} } }
  await f.internals.executeRun(f.run(), new AbortController().signal, f.owner)
  assert.equal(f.run().executionState, 'waiting')
  assert.equal(cancellations, 0)
})

it('ownership loss cancels native work before ownership assertions or graph task drain (#20)', async () => {
  const entered = deferred<void>()
  const task = deferred<{ executionIds: Record<string, string> }>()
  let cancellations = 0
  const f = engineFixture({ residentRunIds: () => ['run-1'], cancelRun: async () => {
    cancellations += 1
    task.resolve({ executionIds: {} })
  } } as unknown as ApprovalExecutionCoordinator)
  const controller = new AbortController()
  f.internals.executeNode = async () => { entered.resolve(); return task.promise }
  const running = f.internals.executeRun(f.run(), controller.signal, f.owner).catch((error: unknown) => error)
  await entered.promise
  f.loseOwnership()
  controller.abort(new Error('ownership lost'))
  assert.ok(await running instanceof Error)
  assert.equal(cancellations, 1)
  assert.notEqual(f.run().outcome, 'canceled')
})

it('an ignored native iterator cannot prevent timeout cleanup and failed settlement', async () => {
  const entered = deferred<void>()
  let canceled = false
  const f = engineFixture({ residentRunIds: () => ['run-1'], cancelRun: async () => { canceled = true } } as unknown as ApprovalExecutionCoordinator)
  f.internals.executeNode = async () => { entered.resolve(); return never() }
  const controller = new AbortController()
  const running = f.internals.executeRun(f.run(), controller.signal, f.owner)
  await entered.promise
  controller.abort(new Error('execution timeout'))
  await running
  assert.equal(canceled, true)
  assert.equal(f.run().outcome, 'failed')
  assert.equal(f.run().result?.error?.code, 'RUN_CLEANUP_FAILED')
}, 20_000)


it('retrying credential cleanup does not cancel or close an already confirmed closed native session', async () => {
  const f = fixture([execution('one')])
  f.credentials.revokeForExecution = async () => { throw new Error('credential store unavailable') }
  await assert.rejects(f.coordinator.cancelRun('run-1'), AggregateError)
  assert.ok(!f.calls.includes('release:one'))
  f.credentials.revokeForExecution = async () => undefined
  await f.coordinator.cancelRun('run-1')
  assert.equal(f.calls.filter((call) => call === 'cancel:one').length, 1)
  assert.equal(f.calls.filter((call) => call === 'close:one').length, 1)
  assert.ok(f.calls.includes('release:one'))
  assert.deepEqual(f.coordinator.residentRunIds(), [])
})

it('settles cleanup failure even if an active graph task rejects while Stop drains it', async () => {
  const task = deferred<void>()
  const f = engineFixture({ residentRunIds: () => ['run-1'], cancelRun: async () => undefined } as unknown as ApprovalExecutionCoordinator)
  f.internals.activeRuns.set('run-1', new AbortController())
  f.internals.activeTasks.set('run-1', task.promise)
  const stopped = f.engine.cancel('run-1')
  task.reject(new Error('graph drain failed'))
  await assert.rejects(stopped, /graph drain failed/)
  assert.equal(f.run().result?.error?.code, 'RUN_CLEANUP_FAILED')
  assert.ok(f.calls.includes('release-owner'))
})

it('does not claim native closure when a failed create never returned a session identity', async () => {
  const item = execution('one', 'starting')
  const f = fixture([item])
  f.managers.get('one')!.createImpl = async () => { throw new Error('native creation failed after process start') }
  await assert.rejects(f.observe(item), /native creation failed/)
  await assert.rejects(f.coordinator.cancelRun(item.runId), AggregateError)
  assert.ok(!f.calls.includes('release:one'))
  assert.deepEqual(f.coordinator.residentRunIds(), [item.runId])
})

it('closes an exact native attach that finishes after Stop times out, without starting another turn', async () => {
  const item = execution('one')
  const f = fixture([item])
  f.cold(item)
  const attaching = deferred<void>()
  const opened = deferred<NativeSessionReference>()
  f.managers.get('one')!.attachImpl = async () => { attaching.resolve(); return opened.promise }
  const observed = f.observe(item).catch((error: unknown) => error)
  await attaching.promise
  await assert.rejects(f.coordinator.cancelRun(item.runId), AggregateError)
  assert.ok(!f.calls.includes('release:one'), 'an in-flight attach cannot be forgotten')
  const closesBefore = f.calls.filter((call) => call === 'close:one').length
  opened.resolve({ harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-one' })
  assert.ok(await observed instanceof Error)
  assert.ok(f.calls.filter((call) => call === 'close:one').length > closesBefore)
  await f.coordinator.cancelRun(item.runId)
  assert.equal(f.calls.filter((call) => call === 'attach:one').length, 1)
  assert.ok(!f.calls.includes('create:one'))
  assert.deepEqual(f.coordinator.residentRunIds(), [])
}, 20_000)


it('does not accept an older close as evidence that a late native attach is closed', async () => {
  const item = execution('one')
  const f = fixture([item])
  f.cold(item)
  const attaching = deferred<void>()
  const opened = deferred<NativeSessionReference>()
  const closing = deferred<void>()
  const closed = deferred<undefined>()
  const manager = f.managers.get('one')!
  manager.attachImpl = async () => { attaching.resolve(); return opened.promise }
  manager.closeImpl = async () => { closing.resolve(); return closed.promise }
  const observed = f.observe(item).catch((error: unknown) => error)
  await attaching.promise
  const stopping = f.coordinator.cancelRun(item.runId).catch((error: unknown) => error)
  await closing.promise
  opened.resolve({ harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-one' })
  // Let the in-flight attach complete while the older close still awaits its acknowledgment.
  await new Promise<void>((resolve) => setImmediate(resolve))
  closed.resolve(undefined)
  assert.ok(await stopping instanceof AggregateError)
  assert.ok(await observed instanceof Error)
  assert.ok(!f.calls.includes('release:one'))
  manager.closeImpl = async () => undefined
  await f.coordinator.cancelRun(item.runId)
  assert.equal(f.calls.filter((call) => call === 'close:one').length, 2)
  assert.deepEqual(f.coordinator.residentRunIds(), [])
}, 20_000)
