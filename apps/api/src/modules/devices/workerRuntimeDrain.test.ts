import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'

const logging = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('../diagnostics/logger.js', async importOriginal => ({
  ...await importOriginal<typeof import('../diagnostics/logger.js')>(),
  componentLogger: () => ({ info: logging.info }),
}))
import { createWorkerRuntimeDrain } from './installedWorkerDomains.js'

afterEach(() => {
  vi.useRealTimers()
  logging.info.mockClear()
})

it.each(['dispatches', 'jobs', 'qualifications', 'maintenance', 'quiescence'] as const)(
  'reports a waiting %s stage at info level every thirty seconds and stops after completion', async stage => {
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
      expect(logging.info).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(logging.info).toHaveBeenCalledWith(
        expect.objectContaining({ stage, elapsedMs: 30_000 }), expect.any(String))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logging.info).toHaveBeenCalledTimes(2)
      pending.resolve()
      await running
      await vi.advanceTimersByTimeAsync(60_000)
      expect(logging.info).toHaveBeenCalledTimes(2)
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
  expect(logging.info).not.toHaveBeenCalled()
})
