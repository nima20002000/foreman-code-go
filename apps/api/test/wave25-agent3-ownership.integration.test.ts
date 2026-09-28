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
