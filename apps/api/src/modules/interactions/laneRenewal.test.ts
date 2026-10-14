import type pg from 'pg'
import { expect, it } from 'vitest'
import { PostgresInteractionCoordinationRepository } from './coordination.js'

/** Row-lock model: the repository runs against SQL responses, without a live database. */
function fixture() {
  let locked = true
  let owned = true
  let expiresAt = '2099-01-01T00:00:00.000Z'
  const query = async (text: string, values: unknown[] = []) => {
    if (text.startsWith('select')) return { rows: [{ renewable: owned }], rowCount: 1 }
    if (locked) {
      if (/skip locked/i.test(text)) return { rows: [], rowCount: 0 }
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    }
    if (!owned || values[1] !== 'writer-token') return { rows: [], rowCount: 0 }
    expiresAt = new Date(Date.now() + Number(values[2])).toISOString()
    return { rows: [{ expires_at: expiresAt }], rowCount: 1 }
  }
  const repository = new PostgresInteractionCoordinationRepository({ query } as unknown as pg.Pool)
  return { repository, unlock: () => { locked = false }, revoke: () => { owned = false },
    expiry: () => expiresAt }
}

it('defers a heartbeat immediately while the original lane is locked, then renews the same owner', async () => {
  const f = fixture()
  const ownership = { owner: 'writer', connectionGeneration: 2 }
  await expect(f.repository.renewLane('lane', 'writer-token', 30_000, ownership))
    .rejects.toMatchObject({ code: 'SESSION_LANE_RENEWAL_BUSY' })
  expect(f.expiry()).toBe('2099-01-01T00:00:00.000Z')
  f.unlock()
  const expiry = await f.repository.renewLane('lane', 'writer-token', 30_000, ownership)
  expect(expiry).toBe(f.expiry())
})

it('reports ownership loss even while a successor holds the lane lock', async () => {
  const f = fixture()
  f.revoke()
  await expect(f.repository.renewLane('lane', 'writer-token', 30_000, { owner: 'writer', connectionGeneration: 2 }))
    .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
})
