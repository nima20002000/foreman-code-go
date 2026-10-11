import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import { deferred } from './helpers/wave25Agent3.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const session: NativeSessionReference = {
  harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'stream-session',
}
const frame: NativeHarnessEvent = {
  sequence: 0, type: 'native.notification', occurredAt: '2026-10-05T00:00:00.000Z', payload: { text: 'partial' },
}

function silentProvider() {
  const reading = deferred()
  const release = deferred()
  const detached = deferred()
  let nativeSignal: AbortSignal | undefined
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider operation') }
  const manager: NativeHarnessSessionManager = {
    harness: 'codex', capabilities: unexpected, inspectMcp: unexpected,
    createSession: async () => session, attachSession: unexpected,
    startTurn: (_session, _input, signal) => stream(signal),
    async *startInitialTurn(_start, input, signal) {
      await input.onSessionObserved(session)
      yield* stream(signal)
    },
    pending: unexpected, respond: unexpected, history: unexpected,
    reconcile: async () => ({ events: [], pendingInteractions: [] }),
    cancel: vi.fn(async () => true), close: vi.fn(async () => undefined),
  }
  async function* stream(signal?: AbortSignal) {
    nativeSignal = signal
    try {
      yield frame
      reading.resolve()
      await release.promise
    } finally {
      detached.resolve()
    }
  }
  return { manager, reading, release, detached, signal: () => nativeSignal }
}

it('submits the first turn when session publication finishes under the same writer', async () => {
  vi.useFakeTimers()
  const provider = silentProvider()
  const publishing = deferred()
  const published = deferred()
  const submitted = deferred()
  const offered = vi.fn()
  const coordination = nativeLanes()
  const claim = vi.spyOn(coordination, 'claimLane')
  const release = vi.spyOn(coordination, 'releaseLane')
  const writer = new SingleWriterSessionManager(provider.manager, coordination, 'stream-agent')
  provider.manager.startTurn = vi.fn(async function* (_session, input) {
    expect(input).not.toHaveProperty('onSessionReady')
    await input.onSubmitted?.('provider-turn')
    submitted.resolve()
    yield frame
  })
  const created = await writer.createSession({ kind: 'operator' } as Parameters<typeof writer.createSession>[0])
  const startedAt = Date.now()
  let publicationToken: string | undefined
  const iterator = writer.startTurnBatches(created, {
    prompt: 'stream', clientCorrelationId: 'stream-turn', onTurnOffered: offered,
    onSessionReady: async () => {
      publicationToken = writer.capturedLease(created)?.fence.token
      publishing.resolve()
      await published.promise
    },
  })[Symbol.asyncIterator]()
  const first = iterator.next()
  try {
    await publishing.promise
    expect(publicationToken).toBeDefined()
    expect(provider.manager.startTurn).not.toHaveBeenCalled()
    expect(offered).not.toHaveBeenCalled()
    expect(claim).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    await expect(writer.withLane(created, 'competing-turn', undefined, async () => undefined))
      .rejects.toMatchObject({ code: 'SESSION_LANE_BUSY' })
    expect(claim).toHaveBeenCalledTimes(2)
    published.resolve()
    await submitted.promise
    expect(Date.now()).toBe(startedAt)
    expect(claim).toHaveBeenCalledTimes(2)
    expect(release).not.toHaveBeenCalled()
    expect(writer.capturedLease(created)?.fence.token).toBe(publicationToken)
    expect((await coordination.getLane('codex', created.nativeSessionId))?.currentTurnOrMessageId)
      .toBe('provider-turn')
    expect(offered).toHaveBeenCalledOnce()
    expect(await first).toEqual({ value: [frame], done: false })
    expect((await iterator.next()).done).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  } finally {
    published.resolve()
    await Promise.allSettled([first])
    await iterator.return?.()
  }
})

it.each(['rejected', 'aborted'] as const)('keeps native input unoffered when publication is %s', async failure => {
  const provider = silentProvider()
  provider.manager.startTurn = vi.fn(provider.manager.startTurn)
  const coordination = nativeLanes()
  const release = vi.spyOn(coordination, 'releaseLane')
  const writer = new SingleWriterSessionManager(provider.manager, coordination, 'stream-agent')
  const controller = new AbortController()
  const error = new Error('Session publication did not complete')
  const offered = vi.fn()
  const created = await writer.createSession({ kind: 'operator' } as Parameters<typeof writer.createSession>[0])
  const iterator = writer.startTurnBatches(created, {
    prompt: 'stream', clientCorrelationId: 'stream-turn', onTurnOffered: offered,
    onSessionReady: async () => {
      expect(writer.capturedLease(created)).toBeDefined()
      if (failure === 'rejected') throw error
      controller.abort(error)
    },
  }, controller.signal)[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toBe(error)
  expect(provider.manager.startTurn).not.toHaveBeenCalled()
  expect(offered).not.toHaveBeenCalled()
  expect(writer.isActive(created)).toBe(false)
  expect(release).toHaveBeenCalledOnce()
})

it('retries failed disposal on the same manager while keeping native writes closed', async () => {
  const provider = silentProvider()
  const disposed = deferred()
  const retryStarted = deferred()
  let disposals = 0
  provider.manager.dispose = async () => {
    disposals++
    if (disposals === 1) throw new Error('Native transport close is uncertain')
    retryStarted.resolve()
    await disposed.promise
  }
  const writer = new SingleWriterSessionManager(provider.manager, nativeLanes(), 'stream-agent')
  const start = { kind: 'operator' } as Parameters<typeof writer.createSession>[0]
  await expect(writer.dispose()).rejects.toThrow('Native transport close is uncertain')
  await expect(writer.createSession(start)).rejects.toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
  await expect(writer.attachSession(session, start)).rejects.toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
  await expect(writer.startInitialTurn!(start, {
    prompt: 'stream', clientCorrelationId: 'stream-turn', onSessionObserved: async () => undefined,
  })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'NATIVE_INITIAL_TURN_UNAVAILABLE' })
  const retry = writer.dispose()
  const concurrent = writer.dispose()
  try {
    await retryStarted.promise
    expect(concurrent).toBe(retry)
    expect(disposals).toBe(2)
    await expect(writer.createSession(start)).rejects.toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
    disposed.resolve()
    await retry
    await writer.dispose()
    expect(disposals).toBe(2)
    await expect(writer.attachSession(session, start)).rejects.toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
  } finally {
    disposed.resolve()
    await Promise.allSettled([retry, concurrent])
  }
})

it('drains a retained observer aborted during the restart ownership check before detaching', async () => {
  const provider = silentProvider()
  provider.manager.closeForRestart = vi.fn(async () => undefined)
  const coordination = nativeLanes()
  const writer = new SingleWriterSessionManager(provider.manager, coordination, 'stream-agent')
  const controller = new AbortController()
  const observing = deferred()
  const checkEntered = deferred()
  const checkFinished = deferred()
  const releaseEntered = deferred()
  const releaseFinished = deferred()
  const observationFinished = deferred()
  const observation = writer.withLane(session, 'review-turn', controller.signal, async (_manager, lease) => {
    await coordination.bindLaneTurn(lease.fence, 'review-turn')
    await coordination.acknowledgeLaneTurn(lease.fence, 'review-turn', 'provider-review-turn')
    lease.providerId = 'provider-review-turn'
    observing.resolve()
    await observationFinished.promise
  })
  await observing.promise
  const assertLease = coordination.assertLaneLease.bind(coordination)
  vi.spyOn(coordination, 'assertLaneLease').mockImplementationOnce(async (...args) => {
    checkEntered.resolve()
    await checkFinished.promise
    await assertLease(...args)
  })
  const releaseLane = coordination.releaseLane.bind(coordination)
  vi.spyOn(coordination, 'releaseLane').mockImplementationOnce(async (...args) => {
    releaseEntered.resolve()
    await releaseFinished.promise
    return releaseLane(...args)
  })
  const closing = writer.closeForRestart(session)
  try {
    await checkEntered.promise
    controller.abort(new DomainError('ENGINE_RESTART', 'Main is restarting.', 409))
    checkFinished.resolve()
    observationFinished.resolve()
    await releaseEntered.promise
    expect(provider.manager.closeForRestart).not.toHaveBeenCalled()
    releaseFinished.resolve()
    await Promise.all([closing, observation])
    expect(provider.manager.closeForRestart).toHaveBeenCalledExactlyOnceWith(session)
    expect(provider.manager.cancel).not.toHaveBeenCalled()
    expect(provider.manager.close).not.toHaveBeenCalled()
    expect(await coordination.getLane('codex', session.nativeSessionId)).toMatchObject({
      correlationId: 'review-turn', currentTurnOrMessageId: 'provider-review-turn', observedStatus: 'disconnected',
    })
    expect((await coordination.getLane('codex', session.nativeSessionId))?.leaseToken).toBeUndefined()
  } finally {
    checkFinished.resolve()
    observationFinished.resolve()
    releaseFinished.resolve()
    await Promise.allSettled([closing, observation])
  }
})

it('batches ready output independently of database lease-check latency', async () => {
  vi.useFakeTimers()
  const frames = Array.from({ length: 35 }, (_, sequence) => ({ ...frame, sequence }))
  const provider = silentProvider()
  provider.manager.startTurn = async function* () { yield* frames }
  const coordination = nativeLanes()
  const assertLease = coordination.assertLaneLease.bind(coordination)
  vi.spyOn(coordination, 'assertLaneLease').mockImplementation(async (...args) => {
    await assertLease(...args)
    // Each database check outlasts the partial-batch deadline, without delaying the provider.
    vi.setSystemTime(Date.now() + 30)
  })
  const writer = new SingleWriterSessionManager(provider.manager, coordination, 'stream-agent')
  await writer.createSession({ kind: 'operator' } as Parameters<typeof writer.createSession>[0])
  const batches: NativeHarnessEvent[][] = []
  for await (const batch of writer.startTurnBatches(session, {
    prompt: 'stream', clientCorrelationId: 'stream-turn',
  })) {
    expect(writer.capturedLease(session)).toBeDefined()
    batches.push(batch)
  }
  expect(batches.map((batch) => batch.length)).toEqual([16, 16, 3])
  expect(batches.flat()).toEqual(frames)
  expect(writer.isActive(session)).toBe(false)
  expect((await coordination.getLane('codex', session.nativeSessionId))?.leaseToken).toBeUndefined()
})

it.each(['stream-turn', 'foreign-turn'])('binds earlier history only to its active correlation: %s', async correlationId => {
  const provider = silentProvider()
  const coordination = nativeLanes()
  const history = { events: [], pendingInteractions: [], correlationId, nativeTurnId: 'provider-turn' }
  provider.manager.history = async () => history
  const writer = new SingleWriterSessionManager(provider.manager, coordination, 'stream-agent')
  await writer.createSession({ kind: 'operator' } as Parameters<typeof writer.createSession>[0])
  const iterator = writer.startTurnBatches(session, { prompt: 'stream', clientCorrelationId: 'stream-turn' })[Symbol.asyncIterator]()
  try {
    expect((await iterator.next()).value).toEqual([frame])
    expect(writer.capturedLease(session)?.providerId).toBeUndefined()
    if (correlationId === 'stream-turn') {
      expect(await writer.history(session)).toEqual(history)
      expect(writer.capturedLease(session)?.providerId).toBe('provider-turn')
      expect(await coordination.getLane('codex', session.nativeSessionId)).toMatchObject({
        correlationId: 'stream-turn', currentTurnOrMessageId: 'provider-turn',
      })
    } else {
      await expect(writer.history(session)).rejects.toMatchObject({ code: 'NATIVE_TURN_IDENTITY_CONFLICT' })
      expect(writer.capturedLease(session)?.providerId).toBeUndefined()
      expect((await coordination.getLane('codex', session.nativeSessionId))?.currentTurnOrMessageId).toBeUndefined()
    }
  } finally {
    provider.release.resolve()
    await iterator.return?.()
    await provider.detached.promise
  }
})

it('rejects a collected batch when its writer lease is lost during collection', async () => {
  const provider = silentProvider()
  let lost = false
  provider.manager.startTurn = async function* () {
    yield frame
    lost = true
    yield { ...frame, sequence: 1 }
  }
  const coordination = nativeLanes()
  const assertLease = coordination.assertLaneLease.bind(coordination)
  vi.spyOn(coordination, 'assertLaneLease').mockImplementation(async (...args) => {
    if (lost) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The lane changed owners.', 409)
    await assertLease(...args)
  })
  const writer = new SingleWriterSessionManager(provider.manager, coordination, 'stream-agent')
  await writer.createSession({ kind: 'operator' } as Parameters<typeof writer.createSession>[0])
  const iterator = writer.startTurnBatches(session, {
    prompt: 'stream', clientCorrelationId: 'stream-turn',
  })[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(writer.isActive(session)).toBe(false)
})

it.each(['turn', 'initial'] as const)(
  'releases the %s writer after a failed timed publication while the provider read stays silent', async (mode) => {
    const provider = silentProvider()
    const coordination = nativeLanes()
    const writer = new SingleWriterSessionManager(provider.manager, coordination, 'stream-agent')
    const start = { kind: 'operator' } as Parameters<typeof writer.createSession>[0]
    if (mode === 'turn') await writer.createSession(start)
    const events = mode === 'turn'
      ? writer.startTurnBatches(session, { prompt: 'stream', clientCorrelationId: 'stream-turn' })
      : writer.startInitialTurnBatches!(start, {
        prompt: 'stream', clientCorrelationId: 'stream-turn', onSessionObserved: async () => undefined,
      })
    const failure = new Error('Batch publication failed')
    let observed: unknown
    let settled = false
    const consume = (async () => {
      for await (const batch of events) {
        expect(batch).toEqual([frame])
        expect(writer.capturedLease(session)).toBeDefined()
        throw failure
      }
    })().catch((error: unknown) => { observed = error }).finally(() => { settled = true })
    try {
      await provider.reading.promise
      await expect.poll(() => settled, { timeout: 1_000 }).toBe(true)
      await consume
      expect(observed).toBe(failure)
      expect(writer.isActive(session)).toBe(false)
      expect(await coordination.getLane('codex', session.nativeSessionId)).toMatchObject({
        observedStatus: 'uncertain', correlationId: 'stream-turn',
      })
      expect((await coordination.getLane('codex', session.nativeSessionId))?.leaseToken).toBeUndefined()
      expect(provider.signal()?.aborted).toBe(false)
      expect(provider.manager.cancel).not.toHaveBeenCalled()
      expect(provider.manager.close).not.toHaveBeenCalled()
    } finally {
      provider.release.resolve()
      await consume
      await provider.detached.promise
    }
  },
)
