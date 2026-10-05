import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import { deferred } from './helpers/wave25Agent3.js'

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
