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
    const active: Promise<unknown>[] = []
    if (stage === 'dispatches') {
      active.push(pending.promise.then(() => { void active.splice(0) }))
    }
    const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
      active: () => [...active],
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

it.each(['sources.reclaim-reservation', 'sources.reconcile-preparation', 'sources.release'])(
  'defers new %s retries during an update and resumes them afterwards', async operation => {
    const drain = createWorkerRuntimeDrain({
      signal: new AbortController().signal, active: () => [], drainJobs: async () => {},
      drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => true,
    })
    await drain.run()
    expect(() => drain.assertAdmission('source-operations-v1', { operation }))
      .toThrow(expect.objectContaining({ code: 'WORKER_RUNTIME_DRAINING' }))
    drain.resume()
    expect(() => drain.assertAdmission('source-operations-v1', { operation })).not.toThrow()
  })

it('waits for a control operation admitted after the initial dispatch drain', async () => {
  vi.useFakeTimers()
  const pending = deferred<void>()
  const active: Promise<unknown>[] = []
  const drain = createWorkerRuntimeDrain({
    signal: new AbortController().signal, active: () => [...active], drainJobs: async () => {
      active.push(pending.promise)
      void pending.promise.then(() => active.splice(0))
    },
    drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => true,
  })
  let finished = false
  const running = drain.run().then(() => { finished = true })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).toBe(false)
    pending.resolve()
    await vi.advanceTimersByTimeAsync(100)
    await running
    expect(finished).toBe(true)
  } finally {
    pending.resolve()
    await vi.advanceTimersByTimeAsync(100)
    await running
  }
})

it('keeps source cleanup available until native processes have closed', async () => {
  vi.useFakeTimers()
  let idle = false
  const checking = deferred<void>()
  const drain = createWorkerRuntimeDrain({
    signal: new AbortController().signal, active: () => [], drainJobs: async () => {},
    drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => {
      checking.resolve()
      return idle
    },
  })
  const running = drain.run()
  try {
    await checking.promise
    expect(() => drain.assertAdmission('source-operations-v1', { operation: 'sources.reconcile-preparation' }))
      .not.toThrow()
    idle = true
    await vi.advanceTimersByTimeAsync(100)
    await running
    expect(() => drain.assertAdmission('source-operations-v1', { operation: 'sources.reconcile-preparation' }))
      .toThrow(expect.objectContaining({ code: 'WORKER_RUNTIME_DRAINING' }))
  } finally {
    idle = true
    await vi.advanceTimersByTimeAsync(100)
    await running
  }
})

it('allows reviews and continuation turns to finish existing workflows during an update drain', async () => {
  let finish!: () => void
  const closing = new Promise<void>(resolve => { finish = resolve })
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal, active: () => [],
    drainJobs: async () => { await closing }, drainQualifications: async () => {},
    drainMaintenance: async () => {}, quiescent: async () => true })
  const updating = drain.run()
  try {
    expect(() => drain.assertAdmission('execution-v1', { method: 'prepare-review' })).not.toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'start-turn', review: {} })).not.toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'start-turn' })).not.toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'prepare' })).toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'job-dispatch' })).toThrow()
  } finally {
    finish()
    await updating
  }
})
