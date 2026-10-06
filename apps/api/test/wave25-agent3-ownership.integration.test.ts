import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { RunOwnership } from '../src/modules/runs/ownership.js'

// Only a disposable explicitly configured test database. No application tables
// or migrations are created/dropped; each lock has a random test-only identity.
const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl) {
  const url = new URL(databaseUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
}
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 3 }) : undefined

afterAll(async () => { await pool?.end() })

describe.skipIf(!databaseUrl)('Agent 3 dedicated PostgreSQL publication ownership', () => {
  it('joins an already-started release until the original database connection has drained', async () => {
    const owner = (await RunOwnership.acquire(pool!, `release-drain-${randomUUID()}`, () => undefined))!
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const paused = new Promise<void>(resolve => { finish = resolve })
    const work = owner.oneShotConnection().transaction(async () => { entered(); await paused }).catch(error => error)
    await started
    const first = owner.release()
    let duplicateFinished = false
    const duplicate = owner.release().then(() => { duplicateFinished = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(duplicateFinished).toBe(false)
    } finally {
      finish()
      await Promise.all([first, duplicate, work])
    }
  })

  it('keeps the same PostgreSQL owner for a retained native review after the engine releases its use', async () => {
    const runId = `retained-review-${randomUUID()}`
    const owner = (await RunOwnership.acquire(pool!, runId, () => undefined))!
    let releaseReview: (() => Promise<void>) | undefined
    try {
      const first = await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))
      releaseReview = owner.retain(() => undefined)
      await owner.release()
      expect(await RunOwnership.acquire(pool!, runId, () => undefined)).toBeUndefined()
      expect(await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))).toEqual(first)
      await releaseReview()
      expect(() => owner.assertOwned()).toThrow()
      const replacement = (await RunOwnership.acquire(pool!, runId, () => undefined))!
      try {
        await releaseReview()
        expect(await replacement.oneShotConnection().transaction(sql => replacement.readOneShotFence(sql))).toBeDefined()
      } finally { await replacement.release() }
    } finally {
      await releaseReview?.()
      await owner.release()
    }
  })

  it('cancels a retained review when its original PostgreSQL owner connection is lost', async () => {
    const runId = `retained-review-loss-${randomUUID()}`
    const owner = (await RunOwnership.acquire(pool!, runId, () => undefined))!
    let releaseReview: (() => Promise<void>) | undefined
    try {
      let notify!: () => void
      const lost = new Promise<void>(resolve => { notify = resolve })
      releaseReview = owner.retain(notify)
      const fence = await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))
      await owner.release()
      await pool!.query('select pg_terminate_backend($1)', [Number(fence.ownerId)])
      await lost
      expect(() => owner.assertOwned()).toThrow()
      await expect(owner.client.query('select 1')).rejects.toThrow()
    } finally {
      await releaseReview?.()
      await owner.release()
    }
  })

  it('excludes a second independent owner and transfers only after session closure', async () => {
    const runId = `a3-owner-${randomUUID()}`
    const owner = await RunOwnership.acquire(pool!, runId, () => undefined)
    expect(owner).toBeDefined()
    try {
      expect(await RunOwnership.acquire(pool!, runId, () => undefined)).toBeUndefined()
      const connection = owner!.oneShotConnection()
      const first = await connection.transaction((sql) => owner!.readOneShotFence(sql))
      const second = await connection.transaction((sql) => owner!.readOneShotFence(sql))
      expect(second).toEqual(first)
      const independent = await pool!.query<{ pid: string }>('select pg_backend_pid()::text as pid')
      expect(independent.rows[0]!.pid).not.toBe(first.ownerId)
    } finally { await owner?.release() }
    const replacement = await RunOwnership.acquire(pool!, runId, () => undefined)
    expect(replacement).toBeDefined()
    await replacement?.release()
    expect(() => owner!.assertOwned()).toThrow()
  })
  it('serializes a native repository query behind the complete publication transaction', async () => {
    const owner = await RunOwnership.acquire(pool!, `a3-serial-${randomUUID()}`, () => undefined)
    expect(owner).toBeDefined()
    try {
      const connection = owner!.oneShotConnection()
      const order: string[] = []
      let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      const publication = connection.transaction(async (sql) => {
        await sql.query('select 1')
        entered()
        await sql.query('select pg_sleep(0.02)')
        order.push('transaction')
      })
      await started
      const query = owner!.client.query('select 1').then(() => { order.push('outside') })
      await Promise.all([publication, query])
      expect(order).toEqual(['transaction', 'outside'])
    } finally { await owner?.release() }
  })
  it('reads actual PostgreSQL lock ownership rather than echoing an expected fence', async () => {
    const runId = `a3-fence-${randomUUID()}`
    const owner = await RunOwnership.acquire(pool!, runId, () => undefined)
    expect(owner).toBeDefined()
    try {
      const connection = owner!.oneShotConnection()
      await connection.query('select pg_advisory_unlock($1,hashtext($2))', [810002, runId])
      await expect(connection.transaction((sql) => owner!.readOneShotFence(sql))).rejects.toThrow()
    } finally { await owner?.release() }
  })
})
