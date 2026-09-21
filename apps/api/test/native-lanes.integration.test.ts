import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { NativeSessionLaneSchema } from '@graphql/contracts'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'

it('round-trips claimed and renewed lane leases through PostgreSQL and the shared contract', async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
  const schema = `lanes_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await applyApplicationMigrations(pool)
    const repository = new PostgresInteractionCoordinationRepository(pool)
    const lane = await repository.ensureLane({ id: 'lane', harness: 'codex', nativeSessionId: 'session', ownerAgentId: 'agent',
      observedStatus: 'idle', revision: 0, connectionGeneration: 0, observedAt: new Date().toISOString() })
    const expiry = new Date(Date.now() + 60_000).toISOString()
    const claimed = await repository.claimLane(lane.id, lane.revision, 'owner', 'token', expiry, 'turn')
    expect(claimed.leaseExpiresAt).toBe(expiry)
    expect(claimed.correlationId).toBeUndefined()
    await repository.renewLane(lane.id, 'token', 60_000)
    const renewed = NativeSessionLaneSchema.parse((await pool.query('select record from native_session_lanes where id=$1', [lane.id])).rows[0].record)
    expect(Date.parse(renewed.leaseExpiresAt!)).toBeGreaterThan(Date.now())
    await repository.bindLaneTurn({ id: lane.id, token: 'token' }, 'workflow-turn')
    const released = await repository.releaseLane(lane.id, 'token', {
      observedStatus: 'idle', currentTurnOrMessageId: 'native-turn',
    })
    expect(released.correlationId).toBe('workflow-turn')
    expect(released.currentTurnOrMessageId).toBe('native-turn')
    await expect(repository.assertLaneLease(lane.id, 'token')).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  } finally {
    await pool.end()
    await admin.query(`drop schema "${schema}" cascade`)
    await admin.end()
  }
})
