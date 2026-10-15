import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { faultWorkflowFixture, expectSuccessfulFaultRecovery } from './helpers/faultWorkflowFixture.js'
import { readOperationalFailures } from '../src/modules/diagnostics/operationalFailures.js'
import { deferred } from './helpers/deferred.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('workflow reporting under database contention', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>
  beforeAll(async () => {
    fixture = await faultWorkflowFixture()
    await fixture.launch()
    await fixture.active()
  }, 10_000)
  afterAll(async () => { await fixture?.close() }, 10_000)

  // A six-second Run lock must retry reporting and expose the database delay in operational diagnostics.
  it('finishes while a separate transaction locks its Run during Agent reporting', async () => {
    await fixture.setReportingDeadline(1_000)
    const retriesBefore = readOperationalFailures().find(value => value.operation === 'retry database operation')
      ?.failureCount ?? 0
    const locked = deferred<number>()
    let heldMs = 0
    const hold = withTransaction(fixture.base.db.pool, async sql => {
      await sql.query('select id from runs where id=$1 for update', [fixture.base.f.run.id])
      const started = performance.now()
      const lockerPid = (await sql.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      locked.resolve(lockerPid)
      await readUntil(async () => (await fixture.base.db.pool.query<{ waiting: boolean }>(
        'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting',
        [lockerPid])).rows[0]!.waiting, waiting => waiting && performance.now() - started >= 6_010,
      { timeoutMs: 10_000, description: 'Agent reporting still blocked after six seconds of Run contention' })
      heldMs = performance.now() - started
    })
    const settledLock = Promise.allSettled([hold])
    try {
      const lockerPid = await Promise.race([locked.promise, hold.then(() => {
        throw new Error('The lock transaction finished before signaling acquisition')
      })])
      fixture.release()
      await readUntil(async () => (await fixture.base.db.pool.query<{ waiting: boolean }>(
        'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting',
        [lockerPid])).rows[0]!.waiting, waiting => waiting,
      { timeoutMs: 2_000, description: 'Agent reporting blocked on the Run row' })
      await hold
      expect(heldMs).toBeGreaterThanOrEqual(6_000)
      expectSuccessfulFaultRecovery(await fixture.finished(), fixture)
      const retries = readOperationalFailures().find(value => value.operation === 'retry database operation')
      expect(retries).toMatchObject({ component: 'engine', status: 'degraded' })
      expect(retries!.failureCount).toBeGreaterThan(retriesBefore)
    } finally { await settledLock }
  }, 18_000)
})
