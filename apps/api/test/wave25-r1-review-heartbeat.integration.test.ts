import { afterEach, describe, expect, it } from 'vitest'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })
async function fixture() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
  const f = await approvalDatabase(); closes.push(f.close); return f
}
async function graph(f: Awaited<ReturnType<typeof fixture>>) {
  return (await graphParity(f.pool, f.scope)).compare()
}

describe.skipIf(!postgresEnabled)('BR1-004: production review heartbeat is not a graph mutation', { timeout: 60000 }, () => {
  it('keeps the full snapshot, public review revision and graph head unchanged', async () => {
    const f = await fixture(), before = await graph(f)
    const stored = (await f.pool.query('select revision::text,lease_fence::text from review_jobs where id=$1', [f.job.id])).rows[0]
    const expiry = await f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 60000)
    expect(Date.parse(expiry)).toBeGreaterThan(Date.now())
    expect(await graph(f)).toEqual(before)
    expect((await f.pool.query('select revision::text,lease_fence::text from review_jobs where id=$1', [f.job.id])).rows[0]).toEqual(stored)
    // The existing record/column synchronization trigger remains in force.
    expect((await f.pool.query(`select lease_expires_at=(record->>'leaseExpiresAt')::timestamptz as aligned
      from review_jobs where id=$1`, [f.job.id])).rows[0].aligned).toBe(true)
  })

  it('does not renew an expired lease or overwrite a successor token', async () => {
    const f = await fixture()
    await f.pool.query(`update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}','"2000-01-01T00:00:00.000Z"'::jsonb)
      where id=$1`, [f.job.id])
    const expired = await graph(f)
    await expect(f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 60000))
      .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
    expect(await graph(f)).toEqual(expired)
    await f.repository.coordination.claimReviewJob(f.job.id, 'successor-owner', 'successor-token', new Date(Date.now() + 60000).toISOString())
    const successor = await graph(f)
    await expect(f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 60000))
      .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
    expect(await graph(f)).toEqual(successor)
    expect((await f.pool.query('select lease_token from review_jobs where id=$1', [f.job.id])).rows[0].lease_token).toBe('successor-token')
  })

  it('does not shorten a live lease when a shorter heartbeat arrives later', async () => {
    const f = await fixture()
    const longer = await f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 120000)
    const before = await graph(f)
    const shorter = await f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 1)
    expect(Date.parse(shorter)).toBeGreaterThanOrEqual(Date.parse(longer))
    expect(await graph(f)).toEqual(before)
  })

  it('rejects invalid durations without changing lease or public state', async () => {
    const f = await fixture(), before = await graph(f)
    const stored = (await f.pool.query('select record,revision::text,lease_fence::text from review_jobs where id=$1', [f.job.id])).rows
    for (const duration of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
      await expect(f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, duration))
        .rejects.toMatchObject({ code: 'LEASE_EXPIRY_INVALID' })
    }
    expect((await f.pool.query('select record,revision::text,lease_fence::text from review_jobs where id=$1', [f.job.id])).rows).toEqual(stored)
    expect(await graph(f)).toEqual(before)
  })

  it('rechecks expiry after waiting behind an independent row writer', async () => {
    const f = await fixture(), before = await graph(f), locker = await f.pool.connect()
    let observed: Promise<{ renewed: boolean; code?: string }> | undefined
    try {
      await locker.query('begin')
      const pid = (await locker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await locker.query('select id from review_jobs where id=$1 for update', [f.job.id])
      // The renewal statement first sees the still-live committed version, then
      // blocks on this row. Committing the expired replacement must defeat it.
      await locker.query(`update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',
        '"2000-01-01T00:00:00.000Z"'::jsonb) where id=$1`, [f.job.id])
      observed = f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 60000)
        .then(() => ({ renewed: true }), (error: { code?: string }) => ({ renewed: false, ...(error.code ? { code: error.code } : {}) }))
      const deadline = Date.now() + 3000
      for (;;) {
        const row = (await f.pool.query<{ waiting: boolean }>(`select exists(select 1 from pg_stat_activity
          where $1=any(pg_blocking_pids(pid)) and query like 'update review_jobs%') as waiting`, [pid])).rows[0]!
        if (row.waiting) break
        if (Date.now() >= deadline) throw new Error('Renewal did not reach the independent row lock')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await locker.query('commit')
      expect(await observed).toEqual({ renewed: false, code: 'REVIEW_JOB_LEASE_LOST' })
      expect(await graph(f)).toEqual(before)
    } finally {
      await locker.query('rollback')
      locker.release()
      await observed
    }
  }, 60000)

})
