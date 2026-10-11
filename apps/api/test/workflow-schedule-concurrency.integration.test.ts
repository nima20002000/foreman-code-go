import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { DomainError } from '../src/modules/errors.js'
import { WorkflowScheduleDispatcher } from '../src/modules/schedules/dispatcher.js'
import { agent3Database, deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11Fixture, sch11DomainState, type Sch11Database, type Sch11Fixture } from './helpers/sch11Fixture.js'
import { sch11Once, sch11Minute } from './helpers/sch11ClockCases.js'

describe.skipIf(!postgresEnabled)('scheduled Start concurrency and cancellation', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => { f = await sch11Fixture(database) }, 60_000)

  it('admits another workspace that becomes due while the first preflight is pending', async () => {
    const healthy = await sch11Fixture(database)
    const slowSchedule = await f.save()
    const healthySchedule = await healthy.save({ ...sch11Once, time: '10:01' })
    f.time.now = slowSchedule.nextOccurrenceAt!
    const entered = deferred()
    const release = deferred()
    const admitted = deferred()
    const errors: unknown[] = []
    const slow = f.dispatcher(async (principal, input, schedule) => {
      await admitRepeatRun(database.pool, f.locations, principal, 'schedule', input, {
        ...repeatStartPublication,
        placementAdmission: { prepare: async (_input, _principal, signal) => {
          entered.resolve()
          await release.promise
          signal?.throwIfAborted()
          return undefined
        } },
      }, { schedule })
    })
    const fast = healthy.dispatcher(async (...args) => {
      await healthy.startUsing()(...args)
      admitted.resolve()
    })
    const loop = new WorkflowScheduleDispatcher({
      listDueSchedules: async ({ throughUtc }) => ({
        items: [slowSchedule, healthySchedule].filter((schedule) => schedule.nextOccurrenceAt! <= throughUtc),
        pageInfo: { nextCursor: null },
      }),
      dispatch: (schedule, signal) => schedule.workflowId === f.scope.workflowId
        ? slow.dispatch(schedule, signal) : fast.dispatch(schedule, signal),
    }, { clock: f.clock, pollIntervalMs: 20, reportError: (error) => { errors.push(error) } })
    loop.start()
    try {
      await entered.promise
      f.time.now = healthySchedule.nextOccurrenceAt!
      healthy.time.now = f.time.now
      await admitted.promise
      expect(await f.countRuns()).toBe(0)
      expect(await healthy.countRuns()).toBe(1)
      expect(errors).toEqual([])
    } finally {
      release.resolve()
      await loop.stop()
    }
  }, 15_000)

  it('reuses fenced preflight when admission latency spans a one-second interval', async () => {
    const saved = await f.save({ ...sch11Minute, unit: 'second' })
    f.time.now = saved.nextOccurrenceAt!
    let preparations = 0
    const dispatcher = f.dispatcher(async (principal, input, schedule) => {
      await admitRepeatRun(database.pool, f.locations, principal, 'schedule', input, {
        ...repeatStartPublication,
        placementAdmission: { prepare: async (_input, _principal, signal) => {
          preparations++
          signal?.throwIfAborted()
          f.time.now = new Date(Date.parse(f.time.now) + 1_200).toISOString()
          return undefined
        } },
      }, { schedule })
    })
    await dispatcher.dispatch(saved)
    expect(preparations).toBe(1)
    expect(await f.countRuns()).toBe(1)
    expect(await f.history()).toEqual([
      expect.objectContaining({ status: 'accepted', dueAt: '2030-01-07T09:00:02.000Z' }),
      expect.objectContaining({ status: 'missed', reason: 'superseded', dueAt: saved.nextOccurrenceAt }),
    ])
    expect((await f.current())?.nextOccurrenceAt).toBe('2030-01-07T09:00:03.000Z')
  }, 15_000)

  it('rolls back a staged Run when the dispatch deadline expires before commit', async () => {
    const saved = await f.save()
    f.time.now = saved.nextOccurrenceAt!
    const before = await sch11DomainState(f)
    const entered = deferred()
    const release = deferred()
    const controller = new AbortController()
    const dispatcher = f.dispatcher(async (principal, input, guard) => {
      await f.startUsing()(principal, input, { ...guard, afterAcceptance: async (sql, run) => {
        await guard.afterAcceptance(sql, run)
        entered.resolve()
        await release.promise
      } })
    })
    const pending = dispatcher.dispatch(saved, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SCHEDULE_PREPARATION_TIMEOUT' })
    try {
      await entered.promise
      controller.abort(new DomainError('SCHEDULE_PREPARATION_TIMEOUT', 'Preparation deadline expired.', 504))
      release.resolve()
      await rejected
      expect(await sch11DomainState(f)).toEqual(before)
      expect(await f.countRuns()).toBe(0)
    } finally { release.resolve(); await pending.catch(() => undefined) }
  }, 15_000)
})
