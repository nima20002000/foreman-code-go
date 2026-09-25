import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test, vi } from 'vitest'
import type { Command } from '@langchain/langgraph'
import type { LangGraphWorkflowEngine, RepeatEngineRuntimeBinding } from '../src/modules/runs/engine.js'
import type { RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'
import type { RepositoryWorkflowRun } from '../src/modules/runs/port.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { startFixture } from './eng04-start-fixtures.js'

// Registration tests ONLY: the existing occurrence runtime is a recording double.
// These tests do not claim native, PostgreSQL, or LangGraph traversal qualification.
const calls = vi.hoisted(() => ({ repeat: [] as RepeatEngineStartContext[], oneShot: 0,
  work: undefined as undefined | ((context: RepeatEngineStartContext) => Promise<void>) }))
vi.mock('../src/modules/runs/repeatStartComposition.js', () => ({
  executeRepeatEngineStart: async (context: RepeatEngineStartContext) => {
    calls.repeat.push(context)
    await calls.work?.(context)
  },
}))
vi.mock('../src/modules/runs/oneShotRuntime.js', () => ({ executeOneShotRuntime: async () => { calls.oneShot++ } }))

type PrivateEntry = {
  executeRun(run: RepositoryWorkflowRun, signal: AbortSignal, owner: RunOwnership, command?: Command): Promise<void>
  reconcileRun(runId: string, controller: AbortController): Promise<void>
  resumeRun(runId: string, controller: AbortController, requestedIds?: string[]): Promise<void>
  buildGraph(version: unknown, action: unknown): unknown
}
async function fixture(binding = true) {
  calls.repeat = []; calls.oneShot = 0; calls.work = undefined
  const f = startFixture(), state = { run: f.run as RepositoryWorkflowRun, owned: true, released: 0,
    legacy: 0, factoryReads: 0, bindingReads: 0 }
  const forbidden = async (): Promise<never> => { state.legacy++; throw new Error('Legacy/native side effect is forbidden in registration tests') }
  const owner = { runId: f.run.id, assertOwned: () => { if (!state.owned) throw new Error('owner-lost') },
    release: async () => { state.released++ } } as unknown as RunOwnership
  const factory = {} as RepeatEngineStartContext['factory']
  const runs = { acquireOwnership: async () => owner, get: async () => state.run,
    repeatRepositoryFactory: () => { state.factoryReads++; return factory },
    getOneShotVersion: async () => f.f.version, settleOrphan: forbidden, requestCleanup: forbidden,
    updateState: forbidden, finishCleanup: forbidden }
  const workflows = { getVersion: forbidden, getAgentConfiguration: forbidden }
  const native = { observeExact: forbidden, assertResume: forbidden, cancelRun: forbidden, finishRun: forbidden }
  const locations = { revalidateRunAuthorization: forbidden, revalidateSnapshot: forbidden }
  const checkpointer = { getTuple: forbidden }
  const lifecycle = Object.fromEntries(['preflight', 'markRunning', 'currentState', 'persistWait',
    'cancelNativeAndRequestCleanup', 'settleRun', 'requestCleanup', 'finishNative', 'finishCleanup'].map((key) => [key, forbidden])) as unknown as RepeatEngineStartContext['lifecycle']
  const bindingObject = { lifecycle, async nativeBoundaryEvidence() {
    assert.equal(this, bindingObject)
    return forbidden()
  } }
  const bind: RepeatEngineRuntimeBinding = (actualOwner, signal) => {
    assert.equal(actualOwner, owner); assert.equal(signal.aborted, false); state.bindingReads++
    return bindingObject
  }
  const { LangGraphWorkflowEngine: Engine } = await import('../src/modules/runs/engine.js')
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const engine = new Engine(runs as unknown as Args[0], workflows as unknown as Args[1], native as unknown as Args[2],
    checkpointer as unknown as Args[3], '/synthetic/eng04-runtime', locations as unknown as Args[5],
    undefined, {} as Args[7], undefined, { workerParallelism: 2 }, binding ? bind : undefined)
  return { f, state, owner, engine, entry: engine as unknown as PrivateEntry,
    factory, native, workflows, locations, checkpointer, lifecycle }
}

test('ENG04 engine: queued v3 enters the existing owner, gate, coordinator and checkpoint thread', async () => {
  const f = await fixture()
  await f.engine.start(f.f.run.id)
  assert.equal(calls.repeat.length, 1)
  const context = calls.repeat[0]!
  assert.equal(context.owner, f.owner); assert.equal(context.factory, f.factory)
  assert.equal(context.native, f.native); assert.equal(context.workflows, f.workflows)
  assert.equal(context.locations, f.locations); assert.equal(context.checkpointer, f.checkpointer)
  assert.equal(context.lifecycle, f.lifecycle); assert.equal(context.configuredParallelism, 2)
  assert.equal(context.runtimeRoot, resolve('/synthetic/eng04-runtime'))
  assert.equal(f.state.released, 1); assert.equal(f.state.legacy, 0)
  await assert.rejects(context.nativeBoundaryEvidence('execution-test'), /forbidden/)
})

test('ENG04 engine: simultaneous Start notifications share one admitted task', async () => {
  const f = await fixture()
  let release!: () => void
  const barrier = new Promise<void>((done) => { release = done })
  calls.work = async () => barrier
  const first = f.engine.start(f.f.run.id), second = f.engine.start(f.f.run.id)
  assert.equal(first, second)
  release(); await first
  assert.equal(calls.repeat.length, 1); assert.equal(f.state.bindingReads, 1)
})

test('ENG04 engine: missing runtime binding fails before factory, candidate or legacy fallback', async () => {
  const f = await fixture(false)
  await assert.rejects(f.engine.start(f.f.run.id), { code: 'REPEAT_NATIVE_HOST_REQUIRED' })
  assert.equal(f.state.factoryReads, 0); assert.equal(calls.repeat.length, 0)
  assert.equal(f.state.legacy, 0); assert.equal(f.state.released, 1)
})

test('ENG04 engine: running cold reconciliation reuses the same worker gate', async () => {
  const f = await fixture()
  await f.engine.start(f.f.run.id)
  const admission = calls.repeat[0]!.admission
  f.state.run = { ...f.state.run, executionState: 'running', startedAt: f.f.run.createdAt }
  await f.entry.reconcileRun(f.f.run.id, new AbortController())
  assert.equal(calls.repeat.length, 2); assert.equal(calls.repeat[1]!.admission, admission)
  assert.equal(f.state.legacy, 0)
})

test('ENG04 engine: cold waiting and direct approval resume are closed before any graph entry', async () => {
  const f = await fixture()
  f.state.run = { ...f.state.run, executionState: 'waiting' }
  await assert.rejects(f.entry.reconcileRun(f.f.run.id, new AbortController()), { code: 'REPEAT_APPROVAL_RESUME_REQUIRED' })
  await assert.rejects(f.entry.resumeRun(f.f.run.id, new AbortController(), ['interaction-test']), { code: 'REPEAT_APPROVAL_RESUME_REQUIRED' })
  assert.equal(calls.repeat.length, 0); assert.equal(f.state.bindingReads, 0); assert.equal(f.state.legacy, 0)
})

test('ENG04 engine: terminal notifications do not allocate candidates or call the runtime', async () => {
  const f = await fixture()
  f.state.run = { ...f.state.run, executionState: 'completed', outcome: 'succeeded' }
  await assert.rejects(f.engine.start(f.f.run.id), { code: 'RUN_NOT_STARTABLE' })
  await f.entry.reconcileRun(f.f.run.id, new AbortController())
  await f.entry.resumeRun(f.f.run.id, new AbortController(), ['already-consumed'])
  assert.equal(calls.repeat.length, 0); assert.equal(f.state.bindingReads, 0); assert.equal(f.state.legacy, 0)
})

test('ENG04 engine: owner mismatch, loss, abort and unreceipted resume cannot reach composition', async () => {
  const f = await fixture(), controller = new AbortController()
  await assert.rejects(f.entry.executeRun(f.f.run, controller.signal,
    { ...f.owner, runId: 'other-run' } as RunOwnership), { code: 'GRAPH_SCOPE_MISMATCH' })
  await assert.rejects(f.entry.executeRun(f.f.run, controller.signal, f.owner, {} as Command), { code: 'REPEAT_APPROVAL_RESUME_REQUIRED' })
  f.state.owned = false
  await assert.rejects(f.entry.executeRun(f.f.run, controller.signal, f.owner), /owner-lost/)
  f.state.owned = true; controller.abort(new Error('stopped'))
  await assert.rejects(f.entry.executeRun(f.f.run, controller.signal, f.owner), /stopped/)
  assert.equal(calls.repeat.length, 0); assert.equal(f.state.factoryReads, 0)
})

test('ENG04 engine: unknown tags and v3 static graph cannot use a legacy fallback; v2 dispatch is retained', async () => {
  const f = await fixture()
  for (const tag of [0, 4, '3', null]) {
    await assert.rejects(f.entry.executeRun({ ...f.f.run, executionSemanticsVersion: tag } as unknown as RepositoryWorkflowRun,
      new AbortController().signal, f.owner), { code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
  }
  assert.throws(() => f.entry.buildGraph(f.f.version, () => undefined), { code: 'REPEAT_GRAPH_DISPATCH_REQUIRED' })
  await f.entry.executeRun(f.f.f.run, new AbortController().signal, f.owner)
  assert.equal(calls.oneShot, 1); assert.equal(calls.repeat.length, 0); assert.equal(f.state.legacy, 0)
})

test('ENG04 engine: a v3 runtime rejection during cold cancellation cannot invoke legacy orphan settlement', async () => {
  const f = await fixture(), controller = new AbortController()
  f.state.run = { ...f.state.run, executionState: 'running' }
  calls.work = async () => { controller.abort(new Error('owner-disconnected')); throw controller.signal.reason }
  await assert.rejects(f.entry.reconcileRun(f.f.run.id, controller), /owner-disconnected/)
  assert.equal(calls.repeat.length, 1); assert.equal(f.state.legacy, 0); assert.equal(f.state.released, 1)
})
