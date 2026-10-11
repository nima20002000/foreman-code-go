import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { agent3Database } from './helpers/wave25Agent3.js'

let database: Awaited<ReturnType<typeof agent3Database>> | undefined
afterEach(async () => { await database?.close(); database = undefined })

it('shares a measured host budget across many ordinary Agents and retains it after restart', async () => {
  database = await agent3Database()
  const pool = database.pool
  const scopeId = randomUUID()
  const readCapacity = async () => sourceStorageCapacityFixture({ totalBytes: 64 * 2 ** 30,
    availableBytes: 32 * 2 ** 30, cpuCount: 8, availableMemoryBytes: 16 * 2 ** 30 })
  const reservations = new PostgresSourceReservations(readCapacity)
  const agents = []
  for (let index = 0; index < 14; index++) {
    const capture = await reservations.reserve(pool, { scopeId, ownerKind: 'capture', ownerId: randomUUID(),
      reservedBytes: 32 * 2 ** 20 })
    await reservations.retain(pool, capture, 'retained')
  }
  for (let index = 0; index < 16; index++) {
    const agent = await reservations.reserve(pool, { scopeId, ownerKind: 'materialization', ownerId: randomUUID(),
      reservedBytes: 163 * 2 ** 20 * 3 })
    await reservations.retain(pool, agent, 'owned')
    agents.push(agent)
  }
  const restarted = new PostgresSourceReservations(readCapacity)
  expect(await restarted.reserve(pool, agents[0]!)).toEqual(agents[0])
  await expect(restarted.reserve(pool, { scopeId, ownerKind: 'materialization', ownerId: randomUUID(),
    reservedBytes: 163 * 2 ** 20 * 3 })).rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
  const stored = await pool.query<{ state: string; reserved_bytes: string }>(
    'select state,reserved_bytes from source_storage_reservations where owner_id=any($1::text[])',
    [agents.map(agent => agent.ownerId)])
  expect(stored.rows).toHaveLength(16)
  expect(stored.rows.every(row => row.state === 'owned'
    && Number(row.reserved_bytes) === 163 * 2 ** 20 * 3)).toBe(true)
})

it('serializes competing reservations and counts every outstanding writer against real free space', async () => {
  database = await agent3Database()
  const pool = database.pool
  const scopeId = randomUUID()
  const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
    totalBytes: 64 * 2 ** 30, availableBytes: 2 * 2 ** 30, cpuCount: 4,
  }))
  async function reserve() {
    const sql = await pool.connect()
    try {
      await sql.query('begin')
      const reservation = await reservations.reserve(sql, { scopeId, ownerKind: 'capture', ownerId: randomUUID(),
        reservedBytes: 600 * 2 ** 20 })
      await sql.query('commit')
      return reservation
    } catch (error) {
      await sql.query('rollback')
      throw error
    } finally { sql.release() }
  }
  const results = await Promise.allSettled([reserve(), reserve()])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected')
  expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'SOURCE_CAPACITY' } })
  expect((await pool.query('select reserved_bytes from source_storage_reservations where scope_id=$1', [scopeId]))
    .rows).toEqual([{ reserved_bytes: String(600 * 2 ** 20) }])
})

it('fails closed without a current host measurement and leaves no new reservation', async () => {
  database = await agent3Database()
  const request = { scopeId: randomUUID(), ownerKind: 'capture' as const, ownerId: randomUUID(), reservedBytes: 1 }
  await expect(new PostgresSourceReservations().reserve(database.pool, request))
    .rejects.toMatchObject({ code: 'SOURCE_CAPACITY_UNAVAILABLE' })
  const stale = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
    observedAt: new Date(Date.now() - 60_000).toISOString(),
  }))
  await expect(stale.reserve(database.pool, request)).rejects.toMatchObject({ code: 'SOURCE_CAPACITY_UNAVAILABLE' })
  expect((await database.pool.query('select 1 from source_storage_reservations where owner_id=$1',
    [request.ownerId])).rows).toEqual([])
})
