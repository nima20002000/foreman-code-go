import { afterEach, expect, it, vi } from 'vitest'
import { readUntil } from './observableCondition.js'

afterEach(() => vi.useRealTimers())

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
  const read = vi.fn(async () => ready)
  const result = readUntil(read, Boolean, {
    timeoutMs: 2_000, description: 'native retry readiness', subscribe: () => unsubscribe,
  })
  await vi.advanceTimersByTimeAsync(0)
  ready = true
  await vi.advanceTimersByTimeAsync(999)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(2)
  await expect(result).resolves.toBe(true)
  expect(unsubscribe).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
