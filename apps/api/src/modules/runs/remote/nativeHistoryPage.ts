import { DEVICE_HISTORY_PAGE_BYTES, type DeviceHistoryPage } from '@graphql/contracts/device-application'
import type { NativeHarnessEvent } from '@graphql/contracts'
import type { NativeHistory } from '../../harnesses/port.js'
import { HarnessExecutionError } from '../../harnesses/errors.js'

/** No cursor returns a recent window; a cursor returns the next chronological page. */
export function pageNativeHistory(history: NativeHistory, afterSequence?: number): {
  history: NativeHistory
  page: DeviceHistoryPage
} {
  const events: NativeHarnessEvent[] = []
  const nextSequence = history.nextSequence ?? (history.events.at(-1)?.sequence ?? -1) + 1
  const firstSequence = history.firstRetainedSequence ?? history.events[0]?.sequence ?? nextSequence
  const value: NativeHistory = { ...history, events, firstRetainedSequence: firstSequence, nextSequence }
  let bytes = Buffer.byteLength(JSON.stringify(value))
  // Reserve space for the sequence and gap fields before adding any events.
  const limit = DEVICE_HISTORY_PAGE_BYTES - 256
  if (bytes > limit) {
    throw new HarnessExecutionError('NATIVE_HISTORY_TOO_LARGE', 'Native history metadata exceeds the remote page limit.')
  }
  let cursor = afterSequence ?? nextSequence - 1
  if (afterSequence !== undefined && afterSequence + 1 < firstSequence) {
    value.gap = { fromSequence: afterSequence + 1, toSequence: firstSequence - 1, reason: 'retention' }
  }
  const candidates = afterSequence === undefined
    ? [...history.events].reverse() : history.events.filter(event => event.sequence > afterSequence)
  for (const event of candidates) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event)) + 1
    if (events.length >= 1024 || bytes + eventBytes > limit) {
      if (events.length === 0) {
        value.gap ??= { fromSequence: event.sequence, toSequence: event.sequence, reason: 'event_too_large' }
        cursor = event.sequence
      }
      break
    }
    if (afterSequence === undefined) {
      events.unshift(event)
    } else {
      events.push(event)
      cursor = event.sequence
    }
    bytes += eventBytes
  }
  if (afterSequence === undefined) value.firstRetainedSequence = events[0]?.sequence ?? nextSequence
  return { history: value, page: { nextAfterSequence: cursor, hasMore: cursor < nextSequence - 1 } }
}
