import { afterAll, beforeAll, expect, it } from 'vitest'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { deferred } from './helpers/deferred.js'
import { withCiTicketLock } from '../src/modules/ci-host/dispatch.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
beforeAll(async () => {
  db = await currentDatabase()
  await db.pool.query('create table dispatch_markers(id text primary key, value text not null)')
  await db.pool.query("insert into dispatch_markers values('ticket','queued')")
}, 60_000)
afterAll(async () => { await db?.close() })

it('commits database work and allows cancellation writes while a ticket waits for its host', async () => {
  const entered = deferred()
  const release = deferred()
  const dispatch = withCiTicketLock(db.pool, 'ticket', async client => {
    await client.query("update dispatch_markers set value='dispatched' where id='ticket'")
    entered.resolve()
    await release.promise
    return 'acknowledged'
  })
  const outcome = Promise.allSettled([dispatch])
  try {
    await entered.promise
    await withTransaction(db.pool, async cancellation => {
      await cancellation.query("set local lock_timeout='500ms'")
      expect((await cancellation.query("select value from dispatch_markers where id='ticket'")).rows)
        .toEqual([{ value: 'dispatched' }])
      await cancellation.query("update dispatch_markers set value='cancellation requested' where id='ticket'")
    })
    expect(await withCiTicketLock(db.pool, 'ticket', async () => 'duplicate')).toBeUndefined()
    expect(await withCiTicketLock(db.pool, 'other-ticket', async () => 'independent')).toBe('independent')
    release.resolve()
    expect(await dispatch).toBe('acknowledged')
    expect((await db.pool.query("select value from dispatch_markers where id='ticket'")).rows)
      .toEqual([{ value: 'cancellation requested' }])
  } finally {
    release.resolve()
    await outcome
  }
})

it('releases ticket exclusion after both a successful callback and a failed callback', async () => {
  await expect(withCiTicketLock(db.pool, 'retry-ticket', async () => {
    throw new Error('Host unavailable')
  })).rejects.toThrow('Host unavailable')
  expect(await withCiTicketLock(db.pool, 'retry-ticket', async () => 'retried')).toBe('retried')
  expect(await withCiTicketLock(db.pool, 'retry-ticket', async () => 'finished')).toBe('finished')
})
