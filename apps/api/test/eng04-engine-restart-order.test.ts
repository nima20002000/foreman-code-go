import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { test, vi } from 'vitest'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'

const runtime = vi.hoisted(() => ({ work: async (context: RepeatEngineStartContext) => { void context } }))
vi.mock('../src/modules/runs/repeatStartComposition.js', () => ({
  executeRepeatEngineStart: (context: RepeatEngineStartContext) => runtime.work(context),
}))

function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Current engine and checkpoint inspection; recording repository/native ports.
// This isolates shutdown ordering and does not claim database or provider proof.
for (const uncertain of [false, true]) test(`restart holds owner until captured native closure ${uncertain ? 'rejects' : 'completes'}`, async () => {
  const f = makeCurrentWorkflowFixture('restart-order', 'single')
  const entered = deferred(), closure = deferred(), events: string[] = []
  const owner = { runId: f.run.id, assertOwned() {}, release: async () => { events.push('release') } }
  const runs = {
    repeatRepositoryFactory: () => ({}), acquireOwnership: async () => owner,
    get: async (runId: string) => { assert.equal(runId, f.run.id); return f.run },
    requestCleanup: async (runId: string, actual: typeof owner) => {
      assert.equal(runId, f.run.id); assert.equal(actual, owner); events.push('cleanup-intent')
    },
    getRepeatSnapshot: async () => ({ run: f.run, version: f.version, configurations: f.configurations,
      stopRequested: false, cleanupPending: false }),
  }
  const native = {
    adoptRunOwner: () => {},
    requestColdRunCleanup: vi.fn(async (actual: typeof owner) => {
      assert.equal(actual, owner)
      return false
    }),
    closeForRestart: vi.fn(async () => {
      events.push('close-start')
      try { await closure.promise } finally { events.push('close-settled') }
    }),
    cancelRun: vi.fn(), finishRun: vi.fn(),
  }
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const engine = new LangGraphWorkflowEngine(runs as unknown as Args[0], {
    getVersion: async (versionId: string) => { assert.equal(versionId, f.version.id); return f.version },
  } as unknown as Args[1],
    native as unknown as Args[2], new MemorySaver(), '/tmp/eng04-restart-order', {} as Args[5], {} as Args[6], {} as Args[7])
  runtime.work = async ({ signal }) => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
      events.push('abort'); reject(signal.reason)
    }, { once: true }))
  }
  const active = engine.start(f.run.id)
  const activeResult = assert.rejects(active)
  // A broken port should fail with its original error, not a barrier timeout.
  await Promise.race([entered.promise, active.then(() => { throw new Error('Runtime entry was not reached') })])
  assert.equal(native.requestColdRunCleanup.mock.calls.length, 1)
  const shutdown = engine.shutdown()
  const shutdownResult = uncertain ? assert.rejects(shutdown, /closure or task draining remains unconfirmed/) : shutdown
  assert.equal(engine.shutdown(), shutdown)
  // Drain every microtask caused by abort, not merely its first continuation.
  await setImmediate()
  assert.equal(events.includes('abort'), true)
  assert(events.indexOf('cleanup-intent') < events.indexOf('close-start'))
  assert(events.indexOf('cleanup-intent') < events.indexOf('abort'))
  assert.equal(events.includes('release'), false)
  assert.equal(native.closeForRestart.mock.calls.length, 1)
  if (uncertain) closure.reject(new Error('original native detachment unconfirmed'))
  else closure.resolve()
  await shutdownResult
  await activeResult
  assert(events.indexOf('close-settled') < events.indexOf('release'))
  assert.equal(events.filter((event) => event === 'release').length, 1)
  assert.equal(native.cancelRun.mock.calls.length, 0)
  assert.equal(native.finishRun.mock.calls.length, 0)
  await assert.rejects(engine.start(f.run.id), { code: 'ENGINE_CLOSING' })
  if (uncertain) {
    native.closeForRestart.mockResolvedValueOnce(undefined)
    const retry = engine.shutdown()
    assert.notEqual(retry, shutdown)
    assert.equal(engine.shutdown(), retry)
    await retry
    assert.equal(native.closeForRestart.mock.calls.length, 2)
    assert.equal(native.cancelRun.mock.calls.length, 0)
    assert.equal(native.finishRun.mock.calls.length, 0)
    await assert.rejects(engine.start(f.run.id), { code: 'ENGINE_CLOSING' })
  }
})


test('restart retains the original owner when cleanup persistence fails and retries before abort', async () => {
  const f = makeCurrentWorkflowFixture('restart-intent-failure', 'single')
  const entered = deferred(), events: string[] = []
  let fail = true
  const owner = { runId: f.run.id, assertOwned() {}, release: async () => { events.push('release') } }
  const runs = {
    repeatRepositoryFactory: () => ({}), acquireOwnership: async () => owner,
    get: async (runId: string) => { assert.equal(runId, f.run.id); return f.run },
    getRepeatSnapshot: async () => ({ run: f.run, version: f.version, configurations: f.configurations,
      stopRequested: false, cleanupPending: false }),
    requestCleanup: vi.fn(async (runId: string, actual: typeof owner) => {
      assert.equal(runId, f.run.id); assert.equal(actual, owner)
      if (fail) throw new Error('cleanup persistence unavailable')
      events.push('cleanup-intent')
    }),
  }
  const native = { adoptRunOwner: () => {}, requestColdRunCleanup: async () => false, closeForRestart: vi.fn(async () => { events.push('close') }),
    cancelRun: vi.fn(), finishRun: vi.fn() }
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const engine = new LangGraphWorkflowEngine(runs as unknown as Args[0], {
    getVersion: async (versionId: string) => { assert.equal(versionId, f.version.id); return f.version },
  } as unknown as Args[1],
    native as unknown as Args[2], new MemorySaver(), '/tmp/eng04-restart-intent-failure', {} as Args[5], {} as Args[6], {} as Args[7])
  runtime.work = async ({ signal }) => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
      events.push('abort'); reject(signal.reason)
    }, { once: true }))
  }
  const active = engine.start(f.run.id)
  const activeResult = assert.rejects(active)
  await Promise.race([entered.promise, active.then(() => { throw new Error('Runtime entry was not reached') })])
  await assert.rejects(engine.shutdown(), /cleanup intent remains unconfirmed/)
  assert.deepEqual(events, [])
  assert.equal(native.closeForRestart.mock.calls.length, 0)
  assert.equal(engine.start(f.run.id), active)
  await assert.rejects(engine.start('another-run'), { code: 'ENGINE_CLOSING' })
  fail = false
  await engine.shutdown()
  await activeResult
  assert.deepEqual(events, ['cleanup-intent', 'close', 'abort', 'release'])
  assert.equal(runs.requestCleanup.mock.calls.length, 2)
  assert.equal(native.cancelRun.mock.calls.length, 0)
  assert.equal(native.finishRun.mock.calls.length, 0)
})

for (const failFirst of [false, true]) test(`naturally completing drive holds its owner through restart persistence${failFirst ? ' and retries failed intent' : ''}`, async () => {
  const f = makeCurrentWorkflowFixture('restart-natural-finish', 'single')
  const entered = deferred(), complete = deferred(), persisting = deferred(), persisted = deferred(), events: string[] = []
  let released = false, attempt = 0
  const owner = { runId: f.run.id, assertOwned() { assert.equal(released, false) }, release: async () => { released = true; events.push('release') } }
  const runs = {
    repeatRepositoryFactory: () => ({}), acquireOwnership: async () => owner,
    get: async (runId: string) => { assert.equal(runId, f.run.id); return f.run },
    getRepeatSnapshot: async () => ({ run: f.run, version: f.version, configurations: f.configurations, stopRequested: false, cleanupPending: false }),
    requestCleanup: async () => {
      attempt++; persisting.resolve(); await persisted.promise; owner.assertOwned()
      if (failFirst && attempt === 1) throw new Error('cleanup intent unavailable')
      events.push('cleanup-intent')
    },
  }
  const native = { adoptRunOwner: () => {}, requestColdRunCleanup: async () => false, closeForRestart: vi.fn(async () => { owner.assertOwned(); events.push('close') }) }
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const engine = new LangGraphWorkflowEngine(runs as unknown as Args[0], {
    getVersion: async (versionId: string) => { assert.equal(versionId, f.version.id); return f.version },
  } as unknown as Args[1], native as unknown as Args[2],
    new MemorySaver(), '/tmp/eng04-natural-finish', {} as Args[5], {} as Args[6], {} as Args[7])
  runtime.work = async () => { entered.resolve(); await complete.promise }
  const active = engine.start(f.run.id), activeResult = active.then(() => null, (error: unknown) => error)
  await entered.promise
  const shutdown = engine.shutdown(), shutdownResult = shutdown.then(() => null, (error: unknown) => error)
  await persisting.promise
  complete.resolve(); await setImmediate()
  const releasedBeforeIntent = released
  persisted.resolve()
  const shutdownError = await shutdownResult, activeError = await activeResult
  assert.equal(releasedBeforeIntent, false, 'intent persistence must retain the original owner even when its drive finishes')
  if (!failFirst) { assert.equal(shutdownError, null); assert.equal(activeError, null) }
  if (failFirst) {
    assert.match(String(shutdownError), /cleanup intent remains unconfirmed/)
    assert.equal(activeError, shutdownError)
    assert.equal(released, false); assert.equal(native.closeForRestart.mock.calls.length, 0)
    await engine.shutdown()
  }
  assert.deepEqual(events, ['cleanup-intent', 'close', 'release'])
  assert.equal(attempt, failFirst ? 2 : 1)
  await assert.rejects(engine.start('another-run'), { code: 'ENGINE_CLOSING' })
})
