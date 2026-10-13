import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'

const logging = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('../diagnostics/logger.js', async importOriginal => ({
  ...await importOriginal<typeof import('../diagnostics/logger.js')>(),
  componentLogger: () => ({ info: logging.info, warn: logging.warn }),
}))
import { createWorkerRuntimeDrain } from './installedWorkerDomains.js'

afterEach(() => {
  vi.useRealTimers()
  logging.info.mockClear()
  logging.warn.mockClear()
})

it.each(['dispatches', 'jobs', 'qualifications', 'maintenance', 'quiescence'] as const)(
  'reports a waiting %s stage at warning level every thirty seconds and stops after completion', async stage => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
      active: () => stage === 'dispatches' ? [pending.promise] : [],
      drainJobs: async () => { if (stage === 'jobs') await pending.promise },
      drainQualifications: async () => { if (stage === 'qualifications') await pending.promise },
      drainMaintenance: async () => { if (stage === 'maintenance') await pending.promise },
      quiescent: async () => {
        if (stage === 'quiescence') await pending.promise
        return true
      },
    })
    const running = drain.run()
    try {
      await vi.advanceTimersByTimeAsync(29_999)
      expect(logging.warn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(logging.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stage, elapsedMs: 30_000, waitingOn: [] }), expect.any(String))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logging.warn).toHaveBeenCalledTimes(2)
      pending.resolve()
      await running
      await vi.advanceTimersByTimeAsync(60_000)
      expect(logging.warn).toHaveBeenCalledTimes(2)
      expect(logging.info).not.toHaveBeenCalled()
    } finally {
      pending.resolve()
      await running
    }
  })

it('stops drain diagnostics when a stage rejects', async () => {
  vi.useFakeTimers()
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal, active: () => [],
    drainJobs: async () => { throw new Error('Job drain failed') },
    drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => true,
  })
  await expect(drain.run()).rejects.toThrow('Job drain failed')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(logging.warn).not.toHaveBeenCalled()
  expect(logging.info).not.toHaveBeenCalled()
})
