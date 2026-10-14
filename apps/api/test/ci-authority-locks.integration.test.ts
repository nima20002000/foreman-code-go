import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import * as credentials from '../src/modules/interactions/wave25/credentialAuthority.js'
import { ciFixture } from './helpers/ciFixture.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('CI authority reads beside credential admission', () => {
  const schema = `ci_locks_${randomUUID().replaceAll('-', '')}`
  const f = ciFixture()
  let database: Awaited<ReturnType<typeof agent3Database>>
  let pool: pg.Pool

  beforeAll(async () => {
    database = await agent3Database()
    await createFixtureSchema(database.pool, schema)
    await database.pool.query(`create table ${schema}.runs(id text primary key,workspace_id text,record jsonb)`)
    await database.pool.query(`create table ${schema}.worker_credential_bindings(principal_id text primary key,
      workspace_id text,workflow_id text,run_id text,execution_id text,agent_id text,purpose text,revoked_at timestamptz)`)
    await database.pool.query(`create table ${schema}.run_authority_principals(run_id text,principal_id text)`)
    await database.pool.query(`create table ${schema}.management_principals(id text primary key,name text,
      audience text,grants jsonb,expires_at timestamptz,revoked_at timestamptz,delegated_from text)`)
    await database.pool.query(`insert into ${schema}.runs values($1,$2,$3::jsonb)`,
      ['run', f.workspaceId, JSON.stringify({ authorizationPrincipalId: f.operator.id })])
    await database.pool.query(`insert into ${schema}.worker_credential_bindings
      values($1,$2,$3,$4,$5,$6,'workflow',null)`,
      [f.worker.id, f.workspaceId, 'workflow', 'run', 'execution', f.worker.agentId])
    await database.pool.query(`insert into ${schema}.run_authority_principals values('run',$1)`, [f.operator.id])
    await database.pool.query(`insert into ${schema}.management_principals
      values($1,$2,'operator',$3::jsonb,$4,null,null)`,
      [f.operator.id, f.operator.name, JSON.stringify(f.operator.grants), f.operator.expiresAt])
    pool = new pg.Pool({ ...database.pool.options, options: `-c search_path=${schema},public -c lock_timeout=3000` })
    // Credential validity is covered by MCP tests; this fixture exercises real PostgreSQL row contention.
    vi.spyOn(credentials, 'assertWave25WorkerBinding').mockResolvedValue(undefined)
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    await pool?.end()
    if (database) {
      try { await dropFixtureSchema(database.pool, schema) }
      finally { await database.close() }
    }
  })

  it('lets credential admission lock the Run and its worker binding while ci_run answers from committed rows', async () => {
    await withTransaction(pool, async writer => {
      await writer.query("select id from runs where id='run' for update")
      await expect(new RunCiAuthority(pool).resolve(f.worker, undefined, CI_RUN_ACTIONS)).resolves.toMatchObject({
        workspaceId: f.workspaceId, principal: { id: f.operator.id }, executionId: 'execution' })
      await writer.query('select principal_id from worker_credential_bindings where principal_id=$1 for update',
        [f.worker.id])
    })
  })

  it('answers ci_get without waiting while another transaction holds the Run and its binding for update', async () => {
    await withTransaction(pool, async writer => {
      await writer.query("select id from runs where id='run' for update")
      await writer.query('select principal_id from worker_credential_bindings where principal_id=$1 for update',
        [f.worker.id])
      await writer.query("select run_id from run_authority_principals where run_id='run' for update")
      const reads = await Promise.all(Array.from({ length: 8 }, () =>
        new RunCiAuthority(pool).resolve(f.worker, undefined, CI_GET_ACTIONS)))
      for (const read of reads) expect(read).toMatchObject({ workspaceId: f.workspaceId,
        principal: { id: f.operator.id }, executionId: 'execution' })
    })
  })

  it('denies ci_get once the worker binding is revoked', async () => {
    await database.pool.query(`update ${schema}.worker_credential_bindings set revoked_at=now() where principal_id=$1`,
      [f.worker.id])
    try {
      await expect(new RunCiAuthority(pool).resolve(f.worker, undefined, CI_GET_ACTIONS))
        .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    } finally {
      await database.pool.query(`update ${schema}.worker_credential_bindings set revoked_at=null where principal_id=$1`,
        [f.worker.id])
    }
  })
})
