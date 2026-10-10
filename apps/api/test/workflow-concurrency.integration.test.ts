import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { checkpointRuntimeFixture, insertProviderRun } from './helpers/wave25Br1003Runtime.js'
import { DomainError } from '../src/modules/errors.js'

it('completes concurrent Runs of the same single Agent without sharing native ownership', async () => {
  const f = await checkpointRuntimeFixture(1, 1, {
    fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
    approvalNodeIds: [],
    workerParallelism: 4,
  })
  const runIds = [f.f.run.id]
  try {
    for (let index = 0; index < 3; index += 1) {
      const run = WorkflowRunV3Schema.parse({ ...f.f.run, id: `run-${randomUUID()}` })
      await insertProviderRun(f.db.pool, { ...f.f, run })
      runIds.push(run.id)
    }
    const results = await Promise.allSettled(runIds.map(id => f.engine.start(id)))
    expect(results.filter(result => result.status === 'rejected')).toEqual([])
    for (const id of runIds) {
      expect(await f.runs.get(id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }
    expect(f.provider.counts).toMatchObject({ sessions: 4, starts: 4 })
    expect(f.provider.closedSessions.size).toBe(4)
  } finally {
    await f.close()
  }
}, 90_000)

it.each(['before turn', 'session reply', 'lane bind'] as const)(
  'closes a created session after a database failure at %s before offering a turn', async timing => {
    const f = await checkpointRuntimeFixture(1, 1, {
      fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
      approvalNodeIds: [],
    })
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
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
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

it('finishes terminal cleanup when a concurrent lifecycle fence wins after completion', async () => {
  const f = await checkpointRuntimeFixture(1, 1, {
    fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
    approvalNodeIds: [],
  })
  const repeat = f.runs.repeat.bind(f.runs)
  vi.spyOn(f.runs, 'repeat').mockImplementation(async (...args) => {
    const store = await repeat(...args)
    const complete = store.completeRun.bind(store)
    store.completeRun = async () => {
      await complete()
      await f.runs.requestCleanup(f.f.run.id, args[0])
      throw new DomainError('GRAPH_STOP_CONFLICT', 'The Run has a cleanup request.', 409)
    }
    return store
  })
  try {
    await expect(f.engine.start(f.f.run.id)).resolves.toBeUndefined()
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1 })
    expect(f.provider.closedSessions.size).toBe(1)
    const snapshot = await f.runs.getRepeatSnapshot(f.f.run.id)
    expect(snapshot.cleanupPending).toBe(false)
  } finally {
    await f.close()
  }
}, 60_000)
