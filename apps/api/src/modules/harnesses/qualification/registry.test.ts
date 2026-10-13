import { afterEach, expect, it, vi } from 'vitest'
import { HarnessQualificationRegistry } from './registry.js'

afterEach(() => { vi.useRealTimers() })

it('loads saved qualifications after a transient database read timeout', async () => {
  vi.useFakeTimers()
  const list = vi.fn().mockRejectedValueOnce(new Error('Query read timeout')).mockResolvedValue([])
  const registry = new HarnessQualificationRegistry({ list, find: async () => null }, {})
  const loaded = registry.load().catch(error => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await loaded).toBeUndefined()
  expect(list).toHaveBeenCalledTimes(2)
})

it('does not retry saved qualification loading when database authentication fails', async () => {
  const failure = Object.assign(new Error('password authentication failed'), { code: '28P01' })
  const list = vi.fn().mockRejectedValue(failure)
  const registry = new HarnessQualificationRegistry({ list, find: async () => null }, {})
  await expect(registry.load()).rejects.toBe(failure)
  expect(list).toHaveBeenCalledOnce()
})
