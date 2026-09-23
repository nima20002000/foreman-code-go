/* global AbortController, process */
// Dependency-free check of the production cancellation helper, not a PostgreSQL
// or provider acceptance suite. Run explicitly (separate from Vitest):
// node --experimental-strip-types --test test/wave25-r1-dispatch.smoke.mjs
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { observeNativeDispatch } from '../src/modules/interactions/wave25/dispatchWait.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

test('returns the actual provider result once and releases its abort listener', async () => {
  const controller = new AbortController()
  const result = { state: 'delivered', evidence: { receipt: 'exact' } }
  let calls = 0
  assert.equal(await observeNativeDispatch(async () => { calls++; return result }, controller.signal), result)
  assert.equal(calls, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('a pre-aborted dispatch never calls the provider', async () => {
  const controller = new AbortController(), stop = new Error('stop-before-dispatch')
  controller.abort(stop)
  let calls = 0
  await assert.rejects(observeNativeDispatch(async () => { calls++ }, controller.signal), (error) => error === stop)
  assert.equal(calls, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('Stop between scheduling and dispatch prevents the effect', async () => {
  const controller = new AbortController(), stop = new Error('stop-before-microtask')
  let calls = 0
  const pending = observeNativeDispatch(async () => { calls++ }, controller.signal)
  controller.abort(stop)
  await assert.rejects(pending, (error) => error === stop)
  assert.equal(calls, 0)
})

test('a provider ignoring cancellation cannot hold the caller until it settles', async () => {
  const controller = new AbortController(), provider = deferred(), entered = deferred()
  let calls = 0
  const pending = observeNativeDispatch(() => { calls++; entered.resolve(); return provider.promise }, controller.signal)
  await entered.promise
  const stop = new Error('durable-stop')
  controller.abort(stop)
  await assert.rejects(pending, (error) => error === stop)
  assert.equal(calls, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  // Deliberately settle the old, non-cooperative call only AFTER caller rejection.
  provider.resolve({ state: 'delivered' })
  await nextTurn()
  assert.equal(calls, 1)
})

test('a late rejection after Stop is observed and does not create a retry', async () => {
  const controller = new AbortController(), provider = deferred(), entered = deferred()
  const unhandled = []
  const listener = (error) => unhandled.push(error)
  process.on('unhandledRejection', listener)
  try {
    let calls = 0
    const pending = observeNativeDispatch(() => { calls++; entered.resolve(); return provider.promise }, controller.signal)
    await entered.promise
    controller.abort(new Error('ownership-lost'))
    await assert.rejects(pending, /ownership-lost/)
    provider.reject(new Error('late-native-failure'))
    await nextTurn(); await nextTurn()
    assert.deepEqual(unhandled, [])
    assert.equal(calls, 1)
  } finally { process.removeListener('unhandledRejection', listener) }
})

test('simultaneous successful response and cancellation do not publish success', async () => {
  const controller = new AbortController()
  const stop = new Error('stop-at-completion')
  await assert.rejects(observeNativeDispatch(async () => {
    controller.abort(stop)
    return { state: 'delivered' }
  }, controller.signal), (error) => error === stop)
})

test('provider failures propagate without retry and without listener retention', async () => {
  const controller = new AbortController(), failure = new Error('provider-failed')
  let calls = 0
  await assert.rejects(observeNativeDispatch(async () => { calls++; throw failure }, controller.signal), (error) => error === failure)
  assert.equal(calls, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('cooperative cancellation also terminates exactly once', async () => {
  const controller = new AbortController(), entered = deferred()
  let canceled = 0
  const pending = observeNativeDispatch(() => new Promise((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => { canceled++; reject(controller.signal.reason) }, { once: true })
    entered.resolve()
  }), controller.signal)
  await entered.promise
  controller.abort(new Error('cancel'))
  await assert.rejects(pending, /cancel/)
  assert.equal(canceled, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
