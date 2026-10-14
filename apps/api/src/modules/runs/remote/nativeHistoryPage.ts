import { DEVICE_HISTORY_PAGE_BYTES, type DeviceHistoryPage,
  type DeviceJsonContinuationRequest } from '@foreman-code/contracts/device-application'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { NativeHistory } from '../../harnesses/port.js'
import { HarnessExecutionError } from '../../harnesses/errors.js'
import { isDeepStrictEqual } from 'node:util'
import { DEVICE_JSON_CONTINUATION_LIMIT } from '@foreman-code/contracts/device-application'
import { pageJsonContinuationBytes } from './jsonContinuation.js'
import { encodeResultCopies, historyResultPaths } from './executionResultCodec.js'

const historySource = Symbol('original native history page')
type HistoryFields = Omit<NativeHistory, 'events' | 'firstRetainedSequence' | 'nextSequence' | 'gap'>
const metadataTransfers = new Map<string, { fields: HistoryFields; bytes: Buffer }>()
let retainedMetadataBytes = 0

function metadataPage(fields: HistoryFields, request?: DeviceJsonContinuationRequest) {
  const retained = request && metadataTransfers.get(request.digest)
  if (retained && isDeepStrictEqual(retained.fields, fields)) {
    return pageJsonContinuationBytes(retained.bytes, request)
  }
  const bytes = Buffer.from(JSON.stringify(encodeResultCopies(fields, historyResultPaths())))
  const page = pageJsonContinuationBytes(bytes, request)
  if (!metadataTransfers.has(page.digest)) {
    while (metadataTransfers.size >= 64
      || retainedMetadataBytes + bytes.byteLength > DEVICE_JSON_CONTINUATION_LIMIT * 4) {
      const oldest = metadataTransfers.entries().next().value
      if (!oldest) break
      metadataTransfers.delete(oldest[0])
      retainedMetadataBytes -= oldest[1].bytes.byteLength
    }
    metadataTransfers.set(page.digest, {
      fields: structuredClone(fields), bytes,
    })
    retainedMetadataBytes += bytes.byteLength
  }
  return page
}
export function nativeHistoryPageSource(reply: unknown): NativeHistory | undefined {
  if (!reply || typeof reply !== 'object') return undefined
  return (reply as { [historySource]?: NativeHistory })[historySource]
}

/** No cursor returns a recent window; a cursor returns the next chronological page. */
export function pageNativeHistory(history: NativeHistory, afterSequence?: number,
  metadataRequest?: DeviceJsonContinuationRequest): {
  history: NativeHistory
  page: DeviceHistoryPage
  [historySource]: NativeHistory
} {
  const events: NativeHarnessEvent[] = []
  const nextSequence = history.nextSequence ?? (history.events.at(-1)?.sequence ?? -1) + 1
  const firstSequence = history.firstRetainedSequence ?? history.events[0]?.sequence ?? nextSequence
  let value: NativeHistory = { ...history, events, firstRetainedSequence: firstSequence, nextSequence }
  let bytes = Buffer.byteLength(JSON.stringify(value))
  // Reserve space for the sequence and gap fields before adding any events.
  const limit = DEVICE_HISTORY_PAGE_BYTES - 256
  let metadata: DeviceHistoryPage['metadata']
  if (bytes > limit || metadataRequest) {
    const fields: HistoryFields = { ...history }
    for (const key of ['events', 'firstRetainedSequence', 'nextSequence', 'gap']) Reflect.deleteProperty(fields, key)
    metadata = metadataPage(fields, metadataRequest)
    value = { events, pendingInteractions: [], firstRetainedSequence: firstSequence, nextSequence,
      ...(history.correlationId === undefined ? {} : { correlationId: history.correlationId }),
      ...(history.nativeTurnId === undefined ? {} : { nativeTurnId: history.nativeTurnId }),
      ...(history.gap === undefined ? {} : { gap: history.gap }) }
    bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(JSON.stringify(metadata))
    if (bytes > limit) throw new HarnessExecutionError('NATIVE_HISTORY_TOO_LARGE', 'Native history identifiers exceed the page limit.')
  }
  let cursor = afterSequence ?? nextSequence - 1
  if (afterSequence !== undefined && afterSequence + 1 < firstSequence) {
    value.gap = { fromSequence: afterSequence + 1, toSequence: firstSequence - 1, reason: 'retention' }
    cursor = firstSequence - 1
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
  const original: NativeHistory = { ...history, events,
    firstRetainedSequence: value.firstRetainedSequence ?? firstSequence, nextSequence,
    ...(value.gap === undefined ? {} : { gap: value.gap }) }
  return { history: value, page: { nextAfterSequence: cursor, hasMore: cursor < nextSequence - 1,
    ...(metadata ? { metadata } : {}) }, [historySource]: original }
}
