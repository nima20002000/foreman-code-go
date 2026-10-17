import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeHistory } from '../../harnesses/port.js'
import { deviceRequestTimeoutMs } from '../../devices/deviceRequestRetry.js'
import { decodeResultCopies } from './executionResultCodec.js'
import { readJsonContinuation } from './jsonContinuation.js'
import { pageNativeHistory, readNativeHistoryMetadata } from './nativeHistoryPage.js'

let now = Date.now()
beforeEach(() => {
  now += deviceRequestTimeoutMs * 3
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
})
afterEach(() => vi.useRealTimers())

function largeHistory(label: string): NativeHistory {
  const result = { outcome: 'succeeded' as const, output: { text: label + 'x'.repeat(3 * 1024 * 1024) } }
  return { events: [], pendingInteractions: [], terminalResult: result,
    terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result } }
}

function download(history: NativeHistory) {
  const first = pageNativeHistory(history).page.metadata!
  return async () => decodeResultCopies(await readJsonContinuation(first,
    async request => readNativeHistoryMetadata(request)))
}

it('keeps shared bytes for a slower reader when another reader completes under cache pressure', async () => {
  const history = largeHistory('shared')
  const fast = download(history)
  const slow = download(history)
  expect(await fast()).toMatchObject({ terminalResult: history.terminalResult })
  for (let index = 0; index < 5; index++) {
    const later = largeHistory(`later-${index}`)
    expect(await download(later)()).toMatchObject({ terminalResult: later.terminalResult })
  }
  expect(await slow()).toMatchObject({ terminalResult: history.terminalResult, terminalTurn: history.terminalTurn })
})

it('releases shared bytes only after the last reader completes', async () => {
  const history = largeHistory('shared-completion')
  const first = download(history)
  const last = download(history)
  const others = Array.from({ length: 4 }, (_, index) => download(largeHistory(`active-${index}`)))
  const waiting = largeHistory('waiting-for-completion')
  await first()
  expect(() => download(waiting)).toThrow(expect.objectContaining({ code: 'backpressure' }))
  await last()
  expect(await download(waiting)()).toMatchObject({ terminalResult: waiting.terminalResult })
  for (const other of others) await other()
})

it('expires an abandoned reader independently while another reader continues the same download', async () => {
  const history = largeHistory('shared-idle')
  const abandoned = download(history)
  vi.setSystemTime(Date.now() + deviceRequestTimeoutMs / 2)
  const active = download(history)
  vi.setSystemTime(Date.now() + deviceRequestTimeoutMs / 2 + 1)
  const finishing = download(history)
  const others = Array.from({ length: 4 }, (_, index) => download(largeHistory(`idle-pressure-${index}`)))
  const waiting = largeHistory('waiting-for-idle-reader')
  expect(() => download(waiting)).toThrow(expect.objectContaining({ code: 'backpressure' }))
  await finishing()
  expect(() => download(waiting)).toThrow(expect.objectContaining({ code: 'backpressure' }))
  expect(await active()).toMatchObject({ terminalResult: history.terminalResult })
  expect(await download(waiting)()).toMatchObject({ terminalResult: waiting.terminalResult })
  await expect(abandoned()).rejects.toMatchObject({ code: 'transfer-expired' })
  for (const other of others) await other()
})
