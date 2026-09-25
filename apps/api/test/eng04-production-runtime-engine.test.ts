import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import type { DurableInteraction } from '@graphql/contracts'
import type { GraphResumeClaim } from '../src/modules/interactions/deliveryPostgres.js'
import type { LangGraphWorkflowEngine, RepeatEngineRuntimeBinding, CurrentEngineRuntimeBinding } from '../src/modules/runs/engine.js'
import type { RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

// Engine REGISTRATION/fence tests with explicit recording ports. Actual graph
// progression lives in eng04-a1-engine-foundation.test.ts. Neither is PG/native proof.
const calls = vi.hoisted(() => ({ entries: [] as RepeatEngineStartContext[],
  work: undefined as undefined | ((context: RepeatEngineStartContext) => Promise<void>) }))
vi.mock('../src/modules/runs/repeatStartComposition.js', () => ({ executeRepeatEngineStart: async (context: RepeatEngineStartContext) => {
  calls.entries.push(context); await calls.work?.(context)
} }))

async function fixture(options: { form?: 'single' | 'parallel' | 'conditional' | 'approval' | 'repeat'; binding?: boolean } = {}) {
  calls.entries = []; calls.work = undefined
  const f = makeCurrentWorkflowFixture('a1-engine-registration', options.form ?? 'single')
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: 'principal-a1-engine',
    executionLocation: { runnerId: 'runner-a1-engine', rootPath: '/synthetic/a1-engine', locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } })
  const state = { run: run as unknown, stopRequested: false, cleanupPending: false, owned: true, released: 0,
    factoryReads: 0, bindingReads: 0, nativeCancel: 0, continuation: 'ready' as 'ready' | 'waiting' | 'stale',
    clean: true, events: [] as string[], prepared: [] as Parameters<CurrentEngineRuntimeBinding['prepareContinuation']>[0][] }
  const snapshot = () => ({ run: state.run as typeof run, version: f.version, configurations: f.configurations,
    stopRequested: state.stopRequested, cleanupPending: state.cleanupPending })
  const owner = { runId: run.id, assertOwned() { if (!state.owned) throw new Error('owner-lost') },
    release: async () => { state.released++ } } as unknown as RunOwnership
  const factory = {} as RepeatEngineStartContext['factory']
  const runs = { acquireOwnership: async () => owner, get: async () => state.run,
    getRepeatSnapshot: async () => snapshot(), repeatRepositoryFactory() { state.factoryReads++; return factory },
    reconciliationCandidates: async () => [state.run] }
  const terminal = () => { state.run = { ...(state.run as typeof run), executionState: 'completed', outcome: 'canceled',
    result: { outcome: 'canceled' }, finishedAt: f.createdAt } }
  const lifecycle: RepeatEngineStartContext['lifecycle'] = {
    preflight: async () => { state.events.push('preflight') }, markRunning: async () => { state.events.push('running') },
    currentState: async () => ({ executionState: snapshot().run.executionState, stopRequested: state.stopRequested }),
    persistWait: async () => false,
    cancelNativeAndRequestCleanup: async () => { state.events.push('cancel-settle'); state.cleanupPending = true; return state.clean },
    settleRun: async () => { state.events.push('settle'); terminal() },
    requestCleanup: async () => { state.events.push('request-cleanup'); state.cleanupPending = true },
    finishNative: async () => { state.events.push('finish-native') },
    finishCleanup: async () => { state.events.push('finish-cleanup'); state.cleanupPending = false },
  }
  const object: CurrentEngineRuntimeBinding = { lifecycle,
    async nativeBoundaryEvidence() { assert.equal(this, object); throw new Error('No fake native evidence in registration tests') },
    async prepareContinuation(input) { state.prepared.push(input); return state.continuation },
  }
  const binding: RepeatEngineRuntimeBinding = (actual, signal) => {
    assert.equal(actual, owner); signal.throwIfAborted(); state.bindingReads++; return object
  }
  const native = { cancelRun: async () => { state.nativeCancel++ }, finishRun: async () => undefined,
    closeForRestart: async () => { state.events.push('restart-close') }, reconcileReviews: async () => undefined }
  const { LangGraphWorkflowEngine: Engine } = await import('../src/modules/runs/engine.js')
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const engine = new Engine(runs as unknown as Args[0], {} as Args[1], native as unknown as Args[2], {} as Args[3],
    '/synthetic/a1-engine', {} as Args[5], undefined, undefined,
    async () => { state.events.push('terminal-notification') }, { workerParallelism: 2 }, options.binding === false ? undefined : binding)
  return { f, run, state, owner, native, runs, engine, factory, object, terminal }
}

for (const form of ['single', 'parallel', 'conditional', 'approval', 'repeat'] as const) test(`ENG04 A1 engine ${form}: the same owner/gate/composition entry`, async () => {
  const h = await fixture({ form })
  await h.engine.start(h.run.id)
  assert.equal(calls.entries.length, 1); assert.equal(calls.entries[0]!.owner, h.owner)
  assert.equal(calls.entries[0]!.factory, h.factory); assert.equal(calls.entries[0]!.lifecycle, h.object.lifecycle)
  assert.equal(calls.entries[0]!.configuredParallelism, 2); assert.equal(h.state.released, 1)
  await assert.rejects(calls.entries[0]!.nativeBoundaryEvidence('synthetic-execution'), /No fake native evidence/)
})

test('ENG04 A1 simultaneous Start notifications allocate only one owner/runtime task', async () => {
  const h = await fixture(); let release!: () => void
  const barrier = new Promise<void>((done) => { release = done })
  calls.work = async () => barrier
  const one = h.engine.start(h.run.id), two = h.engine.start(h.run.id)
  assert.equal(one, two); release(); await one
  assert.equal(calls.entries.length, 1); assert.equal(h.state.released, 1)
})

for (const tag of [undefined, null, 0, 1, 2, 4, '3']) test(`ENG04 A1 engine denies tag ${String(tag)} before runtime/factory/native/binding work`, async () => {
  const h = await fixture(); h.state.run = { ...h.run, executionSemanticsVersion: tag }
  await assert.rejects(h.engine.start(h.run.id), { code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
  assert.equal(calls.entries.length, 0); assert.equal(h.state.factoryReads, 0); assert.equal(h.state.bindingReads, 0)
  assert.equal(h.state.nativeCancel, 0); assert.deepEqual(h.state.events, []); assert.equal(h.state.released, 1)
})

test('ENG04 A1 engine missing ports fail closed, never dispatch to a legacy runtime or fake publisher', async () => {
  const h = await fixture({ binding: false })
  await assert.rejects(h.engine.start(h.run.id), { code: 'REPEAT_NATIVE_HOST_REQUIRED' })
  assert.equal(calls.entries.length, 0); assert.equal(h.state.factoryReads, 0)
})

test('ENG04 A1 cold running recovery uses the same gate but requires authoritative continuation', async () => {
  const h = await fixture(); await h.engine.start(h.run.id)
  const gate = calls.entries[0]!.admission
  h.state.run = { ...h.run, executionState: 'running', startedAt: h.f.createdAt }
  await h.engine.resume(h.run.id)
  assert.equal(h.state.prepared.length, 1); assert.equal(calls.entries.length, 2)
  assert.equal(calls.entries[1]!.admission, gate)
})

test('ENG04 A1 approval notices are hints; waiting/stale claims cannot enter runtime', async () => {
  const h = await fixture(); h.state.run = { ...h.run, executionState: 'waiting' }
  const interaction = { id: 'approval-a1', runId: h.run.id, graphThreadId: h.run.id } as DurableInteraction
  const claim = { id: 'claim-a1' } as unknown as GraphResumeClaim
  for (const result of ['waiting', 'stale'] as const) {
    h.state.continuation = result; await h.engine.resumeInteraction(interaction, claim)
  }
  assert.equal(calls.entries.length, 0)
  assert.deepEqual(h.state.prepared[0]!.requestedInteractionIds, [interaction.id]); assert.equal(h.state.prepared[0]!.claim, claim)
  h.state.continuation = 'ready'; await h.engine.resumeInteraction(interaction, claim)
  assert.equal(calls.entries.length, 1)
  await assert.rejects(h.engine.resumeInteraction({ ...interaction, graphThreadId: 'another-run' }), { code: 'INTERACTION_RUN_MISMATCH' })
})

test('ENG04 A1 cancellation requires a committed authorized Stop before any native action', async () => {
  const h = await fixture()
  await assert.rejects(h.engine.cancel(h.run.id), { code: 'REPEAT_STOP_AUTHORIZATION_REQUIRED' })
  assert.equal(h.state.nativeCancel, 0); assert.equal(h.state.bindingReads, 0)
  h.state.stopRequested = true
  assert.equal(await h.engine.cancel(h.run.id), true)
  assert.equal(h.state.nativeCancel, 1); assert.equal(h.state.cleanupPending, false)
  assert(h.state.events.indexOf('settle') < h.state.events.indexOf('finish-cleanup'))
})

test('ENG04 A1 uncertain native cleanup retains intent and cannot report stopped-and-settled', async () => {
  const h = await fixture(); h.state.stopRequested = true; h.state.clean = false
  assert.equal(await h.engine.cancel(h.run.id), false)
  assert.equal(h.state.cleanupPending, true); assert(!h.state.events.includes('finish-cleanup'))
})

test('ENG04 A1 terminal notifications finish exact lifecycle, never re-enter graph execution', async () => {
  const h = await fixture(); h.terminal()
  await h.engine.start(h.run.id)
  assert.equal(calls.entries.length, 0)
  assert(h.state.events.includes('finish-native')); assert(h.state.events.includes('terminal-notification'))
  assert.equal(h.state.cleanupPending, false)
})

test('ENG04 A1 owner loss blocks factory/runtime without creating fallback work', async () => {
  const h = await fixture(); h.state.owned = false
  await assert.rejects(h.engine.start(h.run.id), /owner-lost/)
  assert.equal(h.state.factoryReads, 0); assert.equal(calls.entries.length, 0)
})

test('ENG04 A1 restart closes captured native sessions before owner release; no synthetic user Stop', async () => {
  const h = await fixture(); let entered!: () => void, closed!: () => void
  const started = new Promise<void>((done) => { entered = done }), closure = new Promise<void>((done) => { closed = done })
  h.native.closeForRestart = async () => { await closure; h.state.events.push('restart-close') }
  calls.work = async (context) => {
    entered()
    await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
  }
  const active = h.engine.start(h.run.id); void active.catch(() => undefined)
  await started; const shutdown = h.engine.shutdown()
  await Promise.resolve(); assert.equal(h.state.released, 0)
  closed(); await shutdown; await assert.rejects(active, { code: 'ENGINE_RESTART' })
  assert.equal(h.state.released, 1); assert.equal(h.state.stopRequested, false)
  assert(!h.state.events.includes('settle')); assert(!h.state.events.includes('finish-cleanup'))
  await assert.rejects(h.engine.start(h.run.id), { code: 'ENGINE_CLOSING' })
})
