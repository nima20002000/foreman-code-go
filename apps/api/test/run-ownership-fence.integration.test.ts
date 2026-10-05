import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Run ownership database fence', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const owners = new Set<RunOwnership>()
  beforeAll(async () => { db = await agent3Database() }, 60_000)
  afterEach(async () => {
    for (const owner of owners) await owner.release()
    owners.clear()
  })
  afterAll(async () => { await db?.close() })

  async function acquire() {
    const owner = await RunOwnership.acquire(db.pool, `fence-${randomUUID()}`, () => {})
    expect(owner).toBeDefined()
    owners.add(owner!)
    return owner!
  }

  it('reads the same live session identity on successive owned transactions', async () => {
    const owner = await acquire()
    const first = await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))
    const second = await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))
    expect(first.ownerId).toMatch(/^\d+$/)
    expect(first.fence).toMatch(/^\d+$/)
    expect(second).toEqual(first)
  })

  it('refuses another database connection even while the original owner remains live', async () => {
    const owner = await acquire()
    await expect(withExclusiveGraphConnection(db.pool, connection => connection.transaction(
      sql => owner.readOneShotFence(sql),
    ))).rejects.toMatchObject({ code: 'RUN_OWNERSHIP_LOST' })
    expect(await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))).toBeDefined()
  })

  it('refuses a lost advisory lock instead of reusing an earlier successful fence', async () => {
    const owner = await acquire()
    await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))
    await owner.client.query('select pg_advisory_unlock($1,hashtext($2))', [810_002, owner.runId])
    await expect(owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql)))
      .rejects.toMatchObject({ code: 'RUN_OWNERSHIP_LOST' })
  })
})
