import { DEVICE_HISTORY_PAGE_BYTES, DEVICE_JSON_CONTINUATION_BYTES, type DeviceHistoryPage,
  type DeviceJsonContinuation, type DeviceJsonContinuationRequest } from '@foreman-code/contracts/device-application'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { NativeHistory } from '../../harnesses/port.js'
import { DomainError } from '../../errors.js'
import { HarnessExecutionError } from '../../harnesses/errors.js'
import { deviceRequestTimeoutMs } from '../../devices/deviceRequestRetry.js'
import { isDeepStrictEqual } from 'node:util'
import { DEVICE_JSON_CONTINUATION_LIMIT } from '@foreman-code/contracts/device-application'
import { createJsonContinuationPager } from './jsonContinuation.js'
import { encodeResultCopies, historyResultPaths } from './executionResultCodec.js'

const historySource = Symbol('original native history page')
type HistoryFields = Omit<NativeHistory, 'events' | 'firstRetainedSequence' | 'nextSequence' | 'gap'>
type MetadataTransfer = {
  fields: HistoryFields
  bytes: Buffer
  page: ReturnType<typeof createJsonContinuationPager>
  /** A download Main is still reading; it stays retained until its last page or one Main request timeout. */
  activeUntil: number
}
const metadataTransfers = new Map<string, MetadataTransfer>()
let retainedMetadataBytes = 0

function servePage(transfer: MetadataTransfer, page: DeviceJsonContinuation) {
  transfer.activeUntil = page.offset + DEVICE_JSON_CONTINUATION_BYTES >= page.byteSize ? 0
    : Date.now() + deviceRequestTimeoutMs
  return page
}

function metadataPage(fields: HistoryFields, request?: DeviceJsonContinuationRequest) {
  const retained = request && metadataTransfers.get(request.digest)
  // Live event cursors can advance while the original metadata bytes are still being read.
  if (retained && isDeepStrictEqual(
    { ...retained.fields, nextCursor: undefined },
    { ...fields, nextCursor: undefined },
  )) {
    return servePage(retained, retained.page(request))
  }
  const bytes = Buffer.from(JSON.stringify(encodeResultCopies(fields, historyResultPaths())))
  const pager = createJsonContinuationPager(bytes)
  const page = pager(request)
  const existing = metadataTransfers.get(page.digest)
  if (existing) return servePage(existing, page)
  while (metadataTransfers.size >= 64
    || retainedMetadataBytes + bytes.byteLength > DEVICE_JSON_CONTINUATION_LIMIT * 4) {
    const now = Date.now()
    const idle = [...metadataTransfers].find(([, transfer]) => transfer.activeUntil <= now)
    if (!idle) throw new DomainError('backpressure', 'Native history downloads in progress fill their retention.', 503)
    metadataTransfers.delete(idle[0])
    retainedMetadataBytes -= idle[1].bytes.byteLength
  }
  const transfer = { fields: structuredClone(fields), bytes, page: pager, activeUntil: 0 }
  metadataTransfers.set(page.digest, transfer)
  retainedMetadataBytes += bytes.byteLength
  return servePage(transfer, page)
}
export function readNativeHistoryMetadata(request: DeviceJsonContinuationRequest) {
  const retained = metadataTransfers.get(request.digest)
  if (!retained) throw new DomainError('transfer-expired', 'Native history metadata is no longer retained.', 409)
  return servePage(retained, retained.page(request))
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
  let bytes = metadataRequest ? 0 : Buffer.byteLength(JSON.stringify(value))
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
  if (afterSequence !== undefined) delete value.gap
  if (afterSequence !== undefined && afterSequence + 1 < firstSequence) {
    value.gap = { fromSequence: afterSequence + 1, toSequence: firstSequence - 1, reason: 'retention' }
    cursor = firstSequence - 1
  }
  const candidates = afterSequence === undefined
    ? [...history.events].reverse() : history.events.filter(event => event.sequence > afterSequence)
  for (const event of candidates) {
    const gap = history.gap
    if (afterSequence !== undefined && event.sequence > cursor + 1 && gap
      && gap.fromSequence <= cursor + 1 && gap.toSequence === event.sequence - 1) {
      // A leading retention gap and an internal gap need separate pages.
      if (value.gap) break
      value.gap = { ...gap, fromSequence: cursor + 1 }
      cursor = gap.toSequence
    }
    const eventBytes = Buffer.byteLength(JSON.stringify(event)) + 1
    if (events.length >= 1024 || bytes + eventBytes > limit) {
      // One page can describe only one skipped range; return an existing gap before skipping this event.
      if (events.length === 0 && !value.gap) {
        value.gap = { fromSequence: event.sequence, toSequence: event.sequence, reason: 'event_too_large' }
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
  const trailingGap = history.gap
  if (afterSequence !== undefined && !value.gap && trailingGap
    && trailingGap.fromSequence <= cursor + 1 && trailingGap.toSequence >= cursor + 1
    && !candidates.some(event => event.sequence > cursor)) {
    value.gap = { ...trailingGap, fromSequence: cursor + 1 }
    cursor = trailingGap.toSequence
  }
  if (afterSequence === undefined) value.firstRetainedSequence = events[0]?.sequence ?? nextSequence
  const original: NativeHistory = { ...history, events,
    firstRetainedSequence: value.firstRetainedSequence ?? firstSequence, nextSequence }
  if (value.gap) original.gap = value.gap
  else delete original.gap
  return { history: value, page: { nextAfterSequence: cursor, hasMore: cursor < nextSequence - 1,
    ...(metadata ? { metadata } : {}) }, [historySource]: original }
}
