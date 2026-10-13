import { afterEach, expect, it, vi } from 'vitest'
import { readUntil } from './observableCondition.js'

afterEach(() => vi.useRealTimers())

it('bounds reconciliation reads when their own writes publish change notifications', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let ready = false
  let changed!: () => void
  const read = vi.fn(async () => {
    if (!ready) setTimeout(changed, 25)
    return ready
  })
  const options = {
    timeoutMs: 3_000,
    description: 'reserved remote review decision',
    minimumReadIntervalMs: 1_000,
    subscribe: (notify: () => void) => {
      changed = notify
      return () => undefined
    },
  }
  const result = readUntil(read, Boolean, options)
  await vi.advanceTimersByTimeAsync(999)
  expect(read).toHaveBeenCalledTimes(1)
  ready = true
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds polling traffic while awaiting native fixture progress', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let ready = false
  const read = vi.fn(async () => ready)
  const result = readUntil(read, Boolean, { timeoutMs: 1_000, description: 'native fixture readiness' })
  await vi.advanceTimersByTimeAsync(100)
  expect(read.mock.calls.length).toBeLessThanOrEqual(5)
  ready = true
  await vi.advanceTimersByTimeAsync(25)
  await expect(result).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the deadline when a polling interval would extend past it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const result = readUntil(async () => false, Boolean, { timeoutMs: 10, description: 'unavailable fixture' })
  const rejected = expect(result).rejects.toThrow('Timed out waiting for unavailable fixture.')
  await vi.advanceTimersByTimeAsync(10)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('observes subscribed changes without waiting for a polling interval', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let changed!: () => void
  let ready = false
  const unsubscribe = vi.fn()
  const read = vi.fn(async () => ready)
  const result = readUntil(read, Boolean, { timeoutMs: 1_000, description: 'published fixture',
    subscribe: notify => { changed = notify; return unsubscribe },
  })
  await vi.advanceTimersByTimeAsync(0)
  ready = true
  changed()
  await expect(result).resolves.toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(unsubscribe).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('rechecks subscribed conditions when progress has no commit notification', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let ready = false
  const unsubscribe = vi.fn()
  const result = readUntil(async () => ready, Boolean, {
    timeoutMs: 1_000, description: 'native retry readiness', subscribe: () => unsubscribe,
  })
  await vi.advanceTimersByTimeAsync(0)
  ready = true
  await vi.advanceTimersByTimeAsync(25)
  await expect(result).resolves.toBe(true)
  expect(unsubscribe).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
