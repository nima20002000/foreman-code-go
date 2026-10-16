import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunOutputSchema } from '@foreman-code/contracts'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createDatabase } from '../src/infrastructure/database.js'
import { withCiDatabasePriority } from '../src/infrastructure/ciDatabasePriority.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits } from '../src/modules/ci-host/service.js'
import { CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it('admits a CI run while dispatch holds every reserved dispatch connection', async () => {
  const db = createDatabase({ connectionString: database.databaseUrl, maxConnections: 10, connectionTimeoutMs: 1000 })
  const workspaceId = randomUUID()
  await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({
    id: workspaceId, name: 'CI workspace',
    repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
  })])
  const commits: CiCommits = {
    capabilities: async () => ({ parts: false, integrationPartitions: false, affected: true }),
    resolve: async (_repository, _branch, commit) => commit ?? 'a'.repeat(40),
  }
  const issued = await new PostgresAccessService(db.pool).issue({ name: 'CI caller', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: CI_RUN_ACTIONS, scope: { workspaceIds: [workspaceId] } }] })
  const ci = new HostCiService(db.pool, new PostgresCommandCoordinator(db.pool), new RunCiAuthority(db.pool), commits, {
    computers: async () => [], request: async () => { throw new Error('No executor is configured') },
  })
  vi.spyOn(ci, 'start').mockImplementation(() => {})
  // A dispatch pass occupies both reserved connections for the whole admission.
  const held: pg.PoolClient[] = await withCiDatabasePriority(async () => [await db.pool.connect(), await db.pool.connect()])
  try {
    const admitted = CiRunOutputSchema.parse(await ci.run(issued.principal,
      { workspaceId, suite: 'install', commandId: randomUUID() }, 'mcp'))
    const saved = await db.pool.query<{ state: string }>('select state from ci_runs where id=$1', [admitted.ticketId])
    expect(saved.rows).toEqual([{ state: 'queued' }])
  } finally {
    for (const client of held) client.release()
    await ci.close()
    await db.close()
  }
}, 30_000)
