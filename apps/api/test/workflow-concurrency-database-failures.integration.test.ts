import { expect, it, vi } from 'vitest'
import { workflowConcurrencyFixture } from './helpers/workflowConcurrencyFixture.js'
import { readCurrentExecutions } from './helpers/wave25Agent3.js'

const createRuntime = workflowConcurrencyFixture()

it.each(['before turn', 'session reply', 'lane bind'] as const)(
  'closes a created session after a database failure at %s before offering a turn', async timing => {
    const f = await createRuntime()
    let sessionSaved = false
    const update = f.runs.updateExecution.bind(f.runs)
    const authorize = f.locations.revalidateRunAuthorization.bind(f.locations)
    if (timing === 'lane bind') {
      vi.spyOn(f.repository.coordination, 'bindLaneTurn').mockRejectedValueOnce(
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
    }
    vi.spyOn(f.runs, 'updateExecution').mockImplementation(async (...args) => {
      await update(...args)
      if (args[0].state === 'running') {
        if (timing === 'session reply') {
          throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
        }
        sessionSaved = timing === 'before turn'
      }
    })
    vi.spyOn(f.locations, 'revalidateRunAuthorization').mockImplementation(async (...args) => {
      if (sessionSaved) {
        sessionSaved = false
        throw Object.assign(new Error('database connection was lost before the turn'), { code: '08006' })
      }
      return authorize(...args)
    })
    try {
      await f.engine.start(f.f.run.id)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 0 })
      expect(f.provider.closedSessions.size).toBe(1)
      const errors: unknown[] = []
      await f.engine.reconcile(error => errors.push(error))
      expect(errors).toEqual([])
      expect(f.provider.counts.starts).toBe(0)
    } finally {
      await f.close()
    }
  }, 60_000)

it('retries a database timeout before offering the first turn without creating another session', async () => {
  const f = await createRuntime()
  const update = f.runs.updateExecution.bind(f.runs)
  const authorize = f.locations.revalidateRunAuthorization.bind(f.locations)
  let sessionSaved = false
  let timeouts = 0
  vi.spyOn(f.runs, 'updateExecution').mockImplementation(async (...args) => {
    await update(...args)
    if (args[0].state === 'running') sessionSaved = true
  })
  vi.spyOn(f.locations, 'revalidateRunAuthorization').mockImplementation(async (...args) => {
    if (sessionSaved && timeouts === 0) {
      timeouts++
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    }
    return authorize(...args)
  })
  try {
    await f.engine.start(f.f.run.id)
    expect(timeouts).toBe(1)
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1 })
    expect(f.provider.closedSessions.size).toBe(1)
    const executions = await readCurrentExecutions(f.runs, f.f.run.id)
    expect(executions).toHaveLength(1)
    expect(executions[0]).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
    const errors: unknown[] = []
    await f.engine.reconcile(error => errors.push(error))
    expect(errors).toEqual([])
    expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1 })
  } finally {
    await f.close()
  }
}, 60_000)
