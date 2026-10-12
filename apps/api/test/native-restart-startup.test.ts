import assert from 'node:assert/strict'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { afterEach, it } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { currentRestartUnit } from './helpers/currentRestartUnit.js'

const connections: Array<{ close(): Promise<void> }> = []

function fixture(reviewer = true) {
  const f = currentRestartUnit(reviewer)
  connections.push(f.connection)
  return f
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function startupFailure(startup: Promise<unknown>) {
  return startup.then(
    () => { throw new Error('Startup unexpectedly succeeded during restart') },
    (error: unknown) => error,
  )
}

function assertPreserved(f: ReturnType<typeof fixture>, before: ReturnType<typeof f.execution>) {
  assert.deepEqual(f.execution(), before)
  assert.equal(f.state.stopped, false)
  assert.equal(f.state.cleanup, false)
  assert.equal(f.state.revocations, 0)
  assert.equal(f.state.budgetStops, 0)
  assert.equal(f.state.cancels, 0)
  assert.equal(f.state.turns, 0)
  assert.equal(f.rows().at(-1)!.closed, false)
  assert.equal(f.rows().at(-1)!.detached, false)
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()))
})

for (const { reviewer, wrapped } of [
  { reviewer: false, wrapped: false },
  { reviewer: true, wrapped: false },
  { reviewer: true, wrapped: true },
]) {
  const kind = reviewer ? 'reviewer attachment' : 'workflow observation'
  it(`drains canceled ${kind} before restart succeeds${wrapped ? ' through native delivery errors' : ''}`, async () => {
    const f = fixture(reviewer)
    const first = f.cold()
    const before = structuredClone(f.execution())
    const attaching = deferred()
    const disposing = deferred()
    const disposed = deferred()
    let disposals = 0
    first.manager.attachSession = async (_reference, _input, signal) => {
      attaching.resolve()
      return new Promise<NativeSessionReference>((_resolve, reject) => {
        signal!.addEventListener('abort', () => {
          const error = wrapped
            ? new NativeDeliveryError('session_creation', 'not_sent', signal!.reason)
            : signal!.reason
          reject(error)
        }, { once: true })
      })
    }
    first.manager.dispose = async () => {
      disposals++
      disposing.resolve()
      await disposed.promise
    }
    const failed = startupFailure(first.attachOriginal())
    await attaching.promise
    let settled = false
    const closing = first.coordinator.closeForRestart().finally(() => { settled = true })
    try {
      await Promise.race([disposing.promise, closing])
      assert.equal(settled, false)
      assertPreserved(f, before)
      disposed.resolve()
      await closing
      assert.equal(disposals, 1)
      assert.equal(f.state.restartCloses, 0)
      assertPreserved(f, before)
      const error = await failed
      assert.ok(error instanceof Error)
      assert.match(error.message, /application restart/)
    } finally {
      disposed.resolve()
      await Promise.allSettled([closing, failed])
    }
  })
}

it('waits for canceled credential preflight and disposes without attaching a saved session', async () => {
  const f = fixture()
  const first = f.cold()
  const before = structuredClone(f.execution())
  const preparing = deferred()
  const prepared = deferred()
  let disposals = 0
  f.beforePreflight(async () => {
    preparing.resolve()
    await prepared.promise
  })
  first.manager.dispose = async () => { disposals++ }
  const failed = startupFailure(first.attachOriginal())
  await preparing.promise
  let settled = false
  const closing = first.coordinator.closeForRestart().finally(() => { settled = true })
  try {
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(disposals, 0)
    prepared.resolve()
    await closing
    await failed
    assert.equal(disposals, 1)
    assert.equal(f.state.attaches, 0)
    assert.equal(f.state.restartCloses, 0)
    assertPreserved(f, before)
  } finally {
    prepared.resolve()
    await Promise.allSettled([closing, failed])
  }
})

for (const drainBeforeClosure of [false, true]) {
  it(`preserves caller restart cancellation ${drainBeforeClosure ? 'before closure' : 'while closure drains startup'}`, async () => {
    const f = fixture()
    const first = f.cold()
    const before = structuredClone(f.execution())
    const caller = new AbortController()
    const attaching = deferred()
    const aborted = deferred()
    const canceled = deferred()
    let disposals = 0
    first.manager.attachSession = async (_reference, _input, signal) => {
      attaching.resolve()
      await new Promise<void>((resolve) => {
        signal!.addEventListener('abort', () => {
          aborted.resolve()
          resolve()
        }, { once: true })
      })
      await canceled.promise
      throw signal!.reason
    }
    first.manager.dispose = async () => { disposals++ }
    const failed = startupFailure(first.attachOriginal(caller.signal))
    await attaching.promise
    caller.abort(new DomainError('ENGINE_RESTART', 'The caller is shutting down for restart.', 409))
    await aborted.promise
    let closing: Promise<void> | undefined
    try {
      if (drainBeforeClosure) {
        canceled.resolve()
        await failed
        assertPreserved(f, before)
      }
      closing = first.coordinator.closeForRestart()
      canceled.resolve()
      await closing
      const error = await failed
      assert.ok(error instanceof Error)
      assert.match(error.message, /caller is shutting down/)
      assert.equal(disposals, 1)
      assert.equal(f.state.restartCloses, 0)
      assertPreserved(f, before)
    } finally {
      canceled.resolve()
      await Promise.allSettled([closing, failed])
    }
  })
}

it('records detachment only after an attachment that completes late is positively closed', async () => {
  const f = fixture()
  const first = f.cold()
  const before = structuredClone(f.execution())
  const attaching = deferred()
  const attached = deferred()
  const closingNative = deferred()
  const closedNative = deferred()
  first.manager.attachSession = async (reference) => {
    attaching.resolve()
    await attached.promise
    return reference
  }
  f.beforeClose(async () => {
    closingNative.resolve()
    await closedNative.promise
  })
  const failed = startupFailure(first.attachOriginal())
  await attaching.promise
  const closing = first.coordinator.closeForRestart()
  try {
    assertPreserved(f, before)
    attached.resolve()
    await Promise.race([closingNative.promise, closing])
    assertPreserved(f, before)
    closedNative.resolve()
    await closing
    await failed
    assert.equal(f.rows().at(-1)!.detached, true)
    assert.equal(f.rows().at(-1)!.closed, false)
    assert.equal(f.state.restartCloses, 1)
    assert.equal(f.state.revocations, 0)
    assert.equal(f.state.cancels, 0)
    assert.deepEqual(f.execution(), before)
  } finally {
    attached.resolve()
    closedNative.resolve()
    await Promise.allSettled([closing, failed])
  }
})

it('retries disposal of the same aborted attachment without inventing closure records', async () => {
  const f = fixture()
  const first = f.cold()
  const before = structuredClone(f.execution())
  const attaching = deferred()
  first.manager.attachSession = async (_reference, _input, signal) => {
    attaching.resolve()
    return new Promise<NativeSessionReference>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  }
  let disposals = 0
  first.manager.dispose = async () => {
    disposals++
    if (disposals === 1) throw new Error('Original transport disposal is uncertain')
  }
  const failed = startupFailure(first.attachOriginal())
  await attaching.promise
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  await failed
  assertPreserved(f, before)
  assert.equal(f.state.restartCloses, 0)
  await first.coordinator.closeForRestart()
  assert.equal(disposals, 2)
  assertPreserved(f, before)
})

it('does not reinterpret uncertain native cleanup as expected restart cancellation', async () => {
  const f = fixture()
  const first = f.cold()
  const attaching = deferred()
  first.manager.attachSession = async (_reference, _input, signal) => {
    attaching.resolve()
    return new Promise<NativeSessionReference>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new NativeDeliveryError(
        'session_creation', 'unknown', signal!.reason, 'pending',
      )), { once: true })
    })
  }
  const failed = startupFailure(first.attachOriginal())
  await attaching.promise
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  await failed
  assert.equal(f.rows().at(-1)!.closed, false)
  assert.equal(f.rows().at(-1)!.detached, false)
  assert.equal(f.state.restartCloses, 0)
})

it('hands over an interrupted ordinary remote workflow attachment before disposing its manager', async () => {
  const placement = { hostRef: { kind: 'device' } } as AcceptedNodePlacement
  const f = currentRestartUnit(false, placement)
  connections.push(f.connection)
  const first = f.cold()
  const before = structuredClone(f.execution())
  const attaching = deferred()
  let attempts = 0
  let detached = false
  first.manager.attachSession = async (reference, input, signal) => {
    attempts++
    assert.deepEqual(reference, f.session)
    assert.equal(input.correlationId, `execution:${before.id}`)
    if (attempts > 1) {
      assert.equal(signal?.aborted, false)
      return reference
    }
    attaching.resolve()
    return new Promise<NativeSessionReference>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  }
  const closeForRestart = first.manager.closeForRestart!.bind(first.manager)
  first.manager.closeForRestart = async reference => {
    await closeForRestart(reference)
    detached = true
  }
  first.manager.dispose = async () => {
    assert.equal(detached, true, 'live remote work requires confirmed restart detachment')
  }
  const failed = startupFailure(first.attachOriginal())
  await attaching.promise
  await first.coordinator.closeForRestart()
  const error = await failed
  assert.ok(error instanceof DomainError)
  assert.equal(error.code, 'ENGINE_RESTART')
  assert.equal(attempts, 2)
  assert.equal(f.state.preflightCalls, 0)
  assert.equal(f.state.restores, 0)
  await first.manager.dispose!()
  assert.deepEqual(f.execution(), before)
  assert.equal(f.rows().at(-1)!.detached, true)
  assert.equal(f.rows().at(-1)!.closed, false)
  assert.equal(f.state.creates, 0)
  assert.equal(f.state.turns, 0)
  assert.equal(f.state.cancels, 0)
  assert.equal(f.state.revocations, 0)
  assert.equal(f.state.budgetStops, 0)
})
