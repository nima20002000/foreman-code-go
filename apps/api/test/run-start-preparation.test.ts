import { describe, expect, it, vi } from 'vitest'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { START_PREPARATION_TIMEOUT_MS } from '../src/modules/runs/startPreparation.js'
import { startSqlFixture } from './eng04-start-fixtures.js'

describe('Start preparation deadline', () => {
  it.each(['http', 'mcp'] as const)('%s cannot resume admission after a timed-out preflight resolves', async (source) => {
    vi.useFakeTimers()
    const f = startSqlFixture()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const preparing = new Promise<void>((resolve) => { entered = resolve })
    let signal: AbortSignal | undefined
    const work = admitRepeatRun(f.pool, f.locations, f.principal, source, f.request, {
      ...f.publication,
      placementAdmission: { prepare: async (_input, _principal, cancellation) => {
        signal = cancellation
        entered()
        await held
        return undefined
      } },
    })
    const rejected = expect(work).rejects.toMatchObject({ code: 'RUN_START_PREPARATION_TIMEOUT' })
    try {
      await preparing
      await vi.advanceTimersByTimeAsync(START_PREPARATION_TIMEOUT_MS)
      await rejected
      expect(signal?.aborted).toBe(true)
      expect(f.state.publications).toBe(0)
      expect(f.state.filesystemCalls).toBe(0)
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.state.publications).toBe(0)
      expect(f.state.filesystemCalls).toBe(0)
    } finally { release(); vi.useRealTimers() }
  })
})
