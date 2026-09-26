import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { readWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'
import { recoveryDatabase, recoveryExecution } from './helpers/eng06Recovery.testSupport.js'

type CoordinatorArgs = ConstructorParameters<typeof ApprovalExecutionCoordinator>
type EngineArgs = ConstructorParameters<typeof LangGraphWorkflowEngine>

function fixture(options: Parameters<typeof recoveryDatabase>[0] = {}) {
  const db = recoveryDatabase(options), calls: string[] = []
  const snapshot = { run: { id: db.owner.runId, executionState: 'running', outcome: 'pending' },
    version: {}, cleanupPending: false, stopRequested: false }
  const runs = {
    repeatRepositoryFactory: () => ({}),
    getExecution: async () => db.state.execution,
    getRepeatSnapshot: async () => structuredClone(snapshot),
    requestCleanup: async () => { calls.push('request-cleanup'); db.state.fenced = true; snapshot.cleanupPending = true },
    async *executionPages() { yield structuredClone([db.state.execution, ...db.state.others.values()]) },
    repeat: async () => ({ settleNegativeExecution: async (id: string, canceled: boolean) => {
      const execution = id === db.state.execution.id ? db.state.execution : db.state.others.get(id)
      assert.ok(execution)
      if (execution.nativeSessionId) assert.ok(await readWorkflowClosure(db.connection, db.state.execution), 'settlement cannot precede closure')
      calls.push(canceled ? 'settle-canceled' : 'settle-interrupted')
    } }),
    acquireOwnership: async () => db.owner,
  }
  const interactions = { coordination: { finishStoppedReviews: async () => {
    assert.ok(await readWorkflowClosure(db.connection, db.state.execution), 'retirement cannot precede closure')
    calls.push('retire-reviews')
  } }, cancelPendingForRun: async () => { calls.push('cancel-interactions'); return 1 } }
  const manager = { resolve: () => { calls.push('resolve'); throw new Error('Cold native allocation is forbidden') } }
  const coordinator = new ApprovalExecutionCoordinator(runs as unknown as CoordinatorArgs[0],
    interactions as unknown as CoordinatorArgs[1], { stop: async () => { calls.push('stop-budget') } } as unknown as CoordinatorArgs[2],
    manager as unknown as CoordinatorArgs[3], 5_000,
    { revokeForExecution: async () => { calls.push('revoke-credential') } } as unknown as CoordinatorArgs[5],
    undefined, { read: (execution) => readWorkflowClosure(db.connection, execution) } as CoordinatorArgs[7], undefined, undefined, undefined,
    async (id) => { assert.equal(id, db.state.execution.id); assert.equal(db.state.active, false); calls.push('close-processes'); return true })
  return { ...db, calls, runs, snapshot, coordinator }
}

describe('ENG06-A cold Run and Stop orchestration', () => {
  for (const state of ['starting', 'running', 'waiting'] as const) it(`fences a cold ${state} execution before reentry`, async () => {
    const f = fixture(); f.state.execution.state = state; f.state.fenced = false
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), true)
    assert.deepEqual(f.calls, ['request-cleanup']); assert.equal(f.snapshot.cleanupPending, true)
    await f.owner.release()
  })

  for (const state of ['queued', 'completed'] as const) it(`does not reinterpret ${state} execution absence as death`, async () => {
    const f = fixture({ closed: true }); f.state.execution = recoveryExecution(state)
    if (state === 'queued') delete f.state.execution.nativeSessionId
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), false)
    assert.deepEqual(f.calls, [])
    await f.owner.release()
  })

  it('recovers physical lifetime without poisoning a completed result with a Run cleanup intent', async () => {
    const f = fixture({ detached: true }); f.state.execution = recoveryExecution('completed'); f.state.fenced = false
    const original = structuredClone(f.state.execution)
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), false)
    assert.deepEqual(f.state.execution, original)
    assert.deepEqual(f.calls, ['close-processes'])
    assert.equal(f.snapshot.cleanupPending, false)
    assert.ok(await readWorkflowClosure(f.connection, original))
    await f.owner.release()
  })

  it('leaves a completed terminal uncertain, not failed, when registry evidence is absent', async () => {
    const f = fixture(); f.state.execution = recoveryExecution('completed'); f.state.fenced = false
    const original = structuredClone(f.state.execution)
    const internals = f.coordinator as unknown as { recoverNativeProcesses: () => Promise<boolean> }
    internals.recoverNativeProcesses = async () => false
    await assert.rejects(f.coordinator.requestColdRunCleanup(f.owner), AggregateError)
    assert.deepEqual(f.state.execution, original)
    assert.deepEqual(f.calls, [])
    assert.equal(f.snapshot.cleanupPending, false)
    assert.equal(f.state.proof, undefined)
    await f.owner.release()
  })

  it('leaves a genuine in-process approval owner available for normal delivery', async () => {
    const f = fixture(); f.state.execution.state = 'waiting'
    // Only this local selection path is under test; no manager operation runs.
    const internals = f.coordinator as unknown as { ownedSessions: Map<string, unknown> }
    internals.ownedSessions.set(f.state.execution.id, { execution: f.state.execution })
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), false)
    assert.deepEqual(f.calls, [])
    await f.owner.release()
  })

  it('blocks the delivery reconciler from allocating a cold requester before the Run recovery scan', async () => {
    const f = fixture(); f.state.execution.state = 'waiting'
    await assert.rejects(f.coordinator.attachOwnedSession({ executionId: f.state.execution.id,
      agentId: f.state.execution.agentId, harness: 'opencode', workingDirectory: f.state.execution.workingDirectory! },
    f.state.session!), { code: 'NATIVE_SESSION_RECOVERY_REQUIRED' })
    assert.deepEqual(f.calls, [])
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), true)
    await f.owner.release()
  })

  it('orders cold Stop closure before review retirement and negative attempt settlement; repeats without new native work', async () => {
    const f = fixture({ detached: true }); f.snapshot.stopRequested = true
    await f.coordinator.cancelRun(f.owner.runId, f.owner)
    assert.deepEqual(f.calls, ['cancel-interactions', 'revoke-credential', 'stop-budget',
      'close-processes', 'retire-reviews', 'settle-canceled'])
    await f.coordinator.cancelRun(f.owner.runId, f.owner)
    assert.equal(f.calls.filter((call) => call === 'close-processes').length, 1)
    assert.equal(f.state.inserts, 1); assert.equal(f.calls.includes('resolve'), false)
    await f.owner.release()
  })

  it('settles an ordinary sequential two-node admission without starting the second node', async () => {
    const f = fixture()
    const next = recoveryExecution('queued')
    Object.assign(next, { id: 'execution-b', workflowNodeId: 'node-b', runtimeDirectory: '/runtime/execution-b' })
    delete next.nativeSessionId
    f.state.others.set(next.id, next)
    const pins = structuredClone([f.state.execution.input, next.input])
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), true)
    await f.coordinator.cancelRun(f.owner.runId, f.owner)
    assert.equal(f.calls.filter((call) => call === 'close-processes').length, 1)
    assert.equal(f.calls.filter((call) => call === 'settle-interrupted').length, 2)
    assert.equal(f.calls.includes('resolve'), false)
    assert.deepEqual([f.state.execution.input, next.input], pins)
    assert.equal(f.state.inserts, 1, 'queued sibling must not acquire a native lifetime receipt')
    await f.owner.release()
  })

  it('does not let the ownerless early Stop pass mint a durable recovery receipt', async () => {
    const f = fixture(); f.snapshot.stopRequested = true
    await f.coordinator.cancelRun(f.owner.runId)
    assert.deepEqual(f.calls, ['cancel-interactions', 'revoke-credential', 'stop-budget'])
    assert.equal(f.state.proof, undefined)
    await f.owner.release()
  })

  it('keeps uncertainty retryable without settling or retiring when physical evidence is unavailable', async () => {
    const f = fixture(); f.snapshot.cleanupPending = true
    const internals = f.coordinator as unknown as { recoverNativeProcesses: () => Promise<boolean> }
    internals.recoverNativeProcesses = async () => false
    await assert.rejects(f.coordinator.cancelRun(f.owner.runId, f.owner), AggregateError)
    assert.equal(f.state.proof, undefined)
    assert.equal(f.calls.includes('retire-reviews'), false); assert.equal(f.calls.includes('settle-interrupted'), false)
    internals.recoverNativeProcesses = async () => true
    await f.coordinator.cancelRun(f.owner.runId, f.owner)
    assert.equal(f.calls.at(-1), 'settle-interrupted')
    await f.owner.release()
  })

  it('reaches cleanup before reading an interrupted approval checkpoint after restart', async () => {
    const f = fixture({ detached: true }); f.snapshot.run.executionState = 'waiting'; f.state.execution.state = 'waiting'; f.state.fenced = false
    const engine = new LangGraphWorkflowEngine(f.runs as unknown as EngineArgs[0], {} as EngineArgs[1], f.coordinator,
      {} as EngineArgs[3], '/runtime', {} as EngineArgs[5], {} as EngineArgs[6], {} as EngineArgs[7])
    let cleanup = 0
    // Test the engine's real owner/reentry ordering, not a fake checkpoint saver
    // accepting an invalid interrupt. Any checkpoint read would fail this test.
    const internals = engine as unknown as { cleanupOwned: (owner: typeof f.owner) => Promise<void> }
    internals.cleanupOwned = async (owner) => { cleanup++; await f.coordinator.cancelRun(owner.runId, owner) }
    await engine.start(f.owner.runId)
    assert.equal(cleanup, 1)
    assert.equal(f.calls[0], 'request-cleanup'); assert.equal(f.calls.at(-1), 'settle-interrupted')
    assert.equal(f.calls.includes('resolve'), false)
  })
})
