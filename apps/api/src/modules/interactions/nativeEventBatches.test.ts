import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeEventBatches, NATIVE_EVENT_BATCH_SIZE } from './nativeEventBatches.js'

afterEach(() => vi.useRealTimers())

function event(sequence: number, type = 'native.notification'): NativeHarnessEvent {
  return { sequence, type, occurredAt: '2026-10-05T00:00:00.000Z', payload: { text: `frame-${sequence}` } }
}

async function* stream(events: NativeHarnessEvent[]) {
  yield* events
}

it('groups a burst without dropping, changing or reordering its frames', async () => {
  const events = Array.from({ length: NATIVE_EVENT_BATCH_SIZE * 2 + 3 }, (_, index) => event(index))
  const batches = []
  for await (const batch of nativeEventBatches(stream(events))) batches.push(batch)
  expect(batches.map((batch) => batch.length)).toEqual([16, 16, 3])
  expect(batches.flat()).toEqual(events)
})

it('keeps ready frames together when the process resumes after the partial-batch deadline', async () => {
  vi.useFakeTimers()
  const events = Array.from({ length: NATIVE_EVENT_BATCH_SIZE * 2 + 3 }, (_, index) => event(index))
  async function* provider() {
    for (const frame of events) {
      // Model process suspension: time passes while ready reads and timers cannot run.
      vi.setSystemTime(Date.now() + 30)
      yield frame
    }
  }
  const batches = []
  for await (const batch of nativeEventBatches(provider())) batches.push(batch)
  expect(batches.map((batch) => batch.length)).toEqual([16, 16, 3])
  expect(batches.flat()).toEqual(events)
})

it('flushes reliability and approval frames immediately with preceding transcript frames', async () => {
  const events = [event(0), event(1, 'turn.started'), event(2), event(3, 'interaction.pending'),
    event(4, 'transport.disconnected'), event(5, 'turn.completed')]
  const batches = []
  for await (const batch of nativeEventBatches(stream(events))) batches.push(batch)
  expect(batches).toEqual([events.slice(0, 2), events.slice(2, 4), [events[4]], [events[5]]])
})

it('flushes a partial batch while its provider is silent and retains the pending read', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const silence = new Promise<void>((resolve) => { finish = resolve })
  async function* provider() {
    yield event(0)
    await silence
    yield event(1, 'turn.completed')
  }
  const iterator = nativeEventBatches(provider())[Symbol.asyncIterator]()
  const first = iterator.next()
  await vi.advanceTimersByTimeAsync(25)
  expect(await first).toEqual({ value: [event(0)], done: false })
  finish()
  expect(await iterator.next()).toEqual({ value: [event(1, 'turn.completed')], done: false })
  expect((await iterator.next()).done).toBe(true)
})

it('drains captured frames before surfacing the provider error', async () => {
  const failure = new Error('provider disconnected')
  async function* provider() {
    yield event(0)
    throw failure
  }
  const iterator = nativeEventBatches(provider())[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ value: [event(0)], done: false })
  await expect(iterator.next()).rejects.toBe(failure)
})
