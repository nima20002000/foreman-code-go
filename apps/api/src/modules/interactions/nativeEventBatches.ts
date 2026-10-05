import { setTimeout as delay } from 'node:timers/promises'
import type { NativeHarnessEvent } from '@graphql/contracts'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import { selectNativeGraphEvidence } from '../run-graph/nativeEvidence.js'

export const NATIVE_EVENT_BATCH_SIZE = 16
const flushIntervalMs = 25

/** Consume inside the writer lifetime so the last partial batch precedes lease release. */
export async function* nativeEventBatches(events: AsyncIterable<NativeHarnessEvent>): AsyncIterable<NativeHarnessEvent[]> {
  const iterator = events[Symbol.asyncIterator]()
  let pending: Promise<IteratorResult<NativeHarnessEvent>> | undefined
  let batch: NativeHarnessEvent[] = []
  let flushAt = 0
  try {
    for (;;) {
      pending ??= iterator.next()
      const timer = new AbortController()
      let next: IteratorResult<NativeHarnessEvent> | undefined
      try {
        next = batch.length ? await Promise.race([
          pending,
          delay(Math.max(0, flushAt - Date.now()), undefined, { signal: timer.signal }),
        ]) : await pending
      } catch (error) {
        if (batch.length) yield batch
        throw error
      } finally { timer.abort() }
      if (!next) {
        yield batch
        batch = []
        continue
      }
      pending = undefined
      if (next.done) {
        if (batch.length) yield batch
        return
      }
      if (!batch.length) flushAt = Date.now() + flushIntervalMs
      batch.push(next.value)
      const normalized = normalizeNativeProducerEvent(next.value)
      const immediate = normalized.rejected
        || ['transport.disconnected', 'interaction.pending', 'permission.asked'].includes(next.value.type)
        || selectNativeGraphEvidence(normalized.event.type, normalized.event.payload).kind !== 'ignored'
      if (immediate || batch.length === NATIVE_EVENT_BATCH_SIZE || Date.now() >= flushAt) {
        yield batch
        batch = []
      }
    }
  } finally {
    void pending?.catch(() => undefined)
    await iterator.return?.()
  }
}
