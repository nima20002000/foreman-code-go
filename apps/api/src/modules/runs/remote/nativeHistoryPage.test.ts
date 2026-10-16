import { describe, expect, it } from 'vitest'
import { DEVICE_APPLICATION_JSON_BYTES, DEVICE_HISTORY_PAGE_BYTES } from '@foreman-code/contracts/device-application'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { NativeHistory } from '../../harnesses/port.js'
import { pageNativeHistory } from './nativeHistoryPage.js'
import { readJsonContinuation } from './jsonContinuation.js'
import { decodeResultCopies } from './executionResultCodec.js'

function event(sequence: number, text = 'event'): NativeHarnessEvent {
  return { sequence, type: 'native.notification', occurredAt: '2026-10-01T00:00:00.000Z', payload: { text } }
}

describe('byte-bounded native history pages', () => {
  it('identifies the missing range when the requested sequence falls behind retention', () => {
    const reply = pageNativeHistory({ events: [event(50), event(51)], pendingInteractions: [],
      firstRetainedSequence: 50, nextSequence: 52 }, 10)
    expect(reply.history.gap).toEqual({ fromSequence: 11, toSequence: 49, reason: 'retention' })
    expect(reply.history.firstRetainedSequence).toBe(50)
  })

  it('delivers a history larger than the carrier limit once, in chronological UTF-8 bounded pages', () => {
    const events = Array.from({ length: 90 }, (_, sequence) => event(sequence, '漢😀"\\'.repeat(2000)))
    const history: NativeHistory = { events, pendingInteractions: [], firstRetainedSequence: 0, nextSequence: 90 }
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(DEVICE_APPLICATION_JSON_BYTES)
    const delivered: NativeHarnessEvent[] = []
    let cursor = -1
    for (let count = 0; count < events.length; count++) {
      const reply = pageNativeHistory(history, cursor)
      expect(Buffer.byteLength(JSON.stringify(reply.history))).toBeLessThanOrEqual(DEVICE_HISTORY_PAGE_BYTES)
      expect(reply.history.gap).toBeUndefined()
      delivered.push(...reply.history.events)
      expect(reply.page.nextAfterSequence).toBeGreaterThan(cursor)
      cursor = reply.page.nextAfterSequence
      if (!reply.page.hasMore) break
    }
    expect(delivered).toEqual(events)
    expect(pageNativeHistory(history, cursor).history.events).toEqual([])
  })

  it('bounds the recent observation and exposes its retained sequence floor', () => {
    const events = Array.from({ length: 2000 }, (_, sequence) => event(sequence))
    const reply = pageNativeHistory({ events, pendingInteractions: [], firstRetainedSequence: 0, nextSequence: 2000 })
    expect(reply.history.events).toEqual(events.slice(-1024))
    expect(reply.history.firstRetainedSequence).toBe(976)
    expect(reply.history.nextSequence).toBe(2000)
    expect(reply.page).toEqual({ nextAfterSequence: 1999, hasMore: false })
  })

  it('reports one oversized event explicitly and preserves terminal recovery after it', () => {
    const result = { outcome: 'succeeded' as const, output: { text: 'original terminal result' } }
    const history: NativeHistory = {
      events: [event(0, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1)), event(1)],
      pendingInteractions: [], firstRetainedSequence: 0, nextSequence: 2,
      correlationId: 'execution:execution', nativeTurnId: 'native-turn', terminalResult: result,
      terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result },
    }
    const first = pageNativeHistory(history, -1)
    expect(first.history.events).toEqual([])
    expect(first.history.gap).toEqual({ fromSequence: 0, toSequence: 0, reason: 'event_too_large' })
    expect(first.page).toEqual({ nextAfterSequence: 0, hasMore: true })
    const second = pageNativeHistory(history, first.page.nextAfterSequence)
    expect(second.history.events).toEqual([history.events[1]])
    expect(second.history.terminalTurn).toEqual(history.terminalTurn)
    const recovery = pageNativeHistory(history)
    expect(recovery.history.firstRetainedSequence).toBe(1)
    expect(recovery.history.terminalResult).toEqual(result)
    expect(recovery.history.terminalTurn).toEqual(history.terminalTurn)
  })

  it('separates a retained range from an oversized first retained event', () => {
    const history: NativeHistory = {
      events: [event(442, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1)), event(443)],
      pendingInteractions: [], firstRetainedSequence: 442, nextSequence: 444,
    }
    const retained = pageNativeHistory(history, 146)
    expect(retained.history.events).toEqual([])
    expect(retained.history.gap).toEqual({ fromSequence: 147, toSequence: 441, reason: 'retention' })
    expect(retained.page).toEqual({ nextAfterSequence: 441, hasMore: true })

    const oversized = pageNativeHistory(history, retained.page.nextAfterSequence)
    expect(oversized.history.events).toEqual([])
    expect(oversized.history.gap).toEqual({ fromSequence: 442, toSequence: 442, reason: 'event_too_large' })
    expect(oversized.page).toEqual({ nextAfterSequence: 442, hasMore: true })

    const remaining = pageNativeHistory(history, oversized.page.nextAfterSequence)
    expect(remaining.history.events).toEqual([event(443)])
    expect(remaining.history.gap).toBeUndefined()
    expect(remaining.page).toEqual({ nextAfterSequence: 443, hasMore: false })
  })

  it('reports an oversized last event even when the terminal window is otherwise empty', () => {
    const result = { outcome: 'succeeded' as const }
    const reply = pageNativeHistory({ events: [event(0, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES))],
      pendingInteractions: [], terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result } })
    expect(reply.history.events).toEqual([])
    expect(reply.history.gap?.reason).toBe('event_too_large')
    expect(reply.history.terminalTurn?.result).toEqual(result)
  })

  it('recovers terminal metadata through bounded UTF-8 continuations with its original result', async () => {
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀"\\'.repeat(40_000) } }
    const history: NativeHistory = { events: [event(0)], pendingInteractions: [], terminalResult: result,
      terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result },
      gap: { fromSequence: 0, toSequence: 0, reason: 'retention' } }
    const first = pageNativeHistory(history, -1)
    expect(first.page.metadata).toBeDefined()
    expect(first.history.terminalResult).toBeUndefined()
    expect(first.history.gap).toEqual(history.gap)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(DEVICE_HISTORY_PAGE_BYTES)
    const recovered = await readJsonContinuation(first.page.metadata!, async metadata => {
      const next = pageNativeHistory(history, 0, metadata)
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(DEVICE_HISTORY_PAGE_BYTES)
      return next.page.metadata!
    })
    expect(decodeResultCopies(recovered)).toMatchObject({ terminalResult: result, terminalTurn: history.terminalTurn })
    expect(() => pageNativeHistory({ ...history, terminalResult: { outcome: 'failed',
      error: { code: 'failed', message: 'Original result changed', retryable: false } } }, 0,
      { digest: first.page.metadata!.digest, offset: 65_536 })).toThrow('continuation changed')
  })

  it('hydrates both terminal result copies when the original journal payload is near three MiB', async () => {
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(450_000) } }
    const history: NativeHistory = { events: [], pendingInteractions: [], terminalResult: result,
      terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result } }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(3 * 1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(4 * 1024 * 1024)
    const first = pageNativeHistory(history)
    const fields = await readJsonContinuation(first.page.metadata!, async metadata =>
      pageNativeHistory(history, first.page.nextAfterSequence, metadata).page.metadata!)
    expect(decodeResultCopies(fields)).toEqual({ pendingInteractions: [], terminalResult: result,
      terminalTurn: history.terminalTurn })
  })
})
