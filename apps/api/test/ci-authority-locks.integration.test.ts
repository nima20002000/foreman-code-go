import { readUntil } from './helpers/observableCondition.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import * as credentials from '../src/modules/interactions/wave25/credentialAuthority.js'
import { ciFixture } from './helpers/ciFixture.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('CI polling and credential admission lock order', () => {
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

  it('lets Run-first admission lock its worker binding while ci_get waits for the Run', async () => {
    const writer = await pool.connect()
    let pending: Promise<Awaited<ReturnType<RunCiAuthority['resolve']>>> | undefined
    try {
      await writer.query('begin')
      await writer.query("select id from runs where id='run' for update")
      const writerPid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      pending = new RunCiAuthority(pool).resolve(f.worker, undefined, CI_GET_ACTIONS)
      const settled = Promise.allSettled([pending])
      const waiting = await readUntil(async () => {
        return (await database.pool.query<{ waiting: boolean }>(`select exists(
          select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting`,
        [writerPid])).rows[0]!.waiting
      }, value => value, { timeoutMs: 1000, description: 'the PostgreSQL lock wait' })
      expect(waiting).toBe(true)
      await writer.query('select principal_id from worker_credential_bindings where principal_id=$1 for update',
        [f.worker.id])
      await writer.query('commit')
      expect(await pending).toMatchObject({ workspaceId: f.workspaceId, principal: { id: f.operator.id },
        executionId: 'execution' })
      expect((await settled)[0]!.status).toBe('fulfilled')
    } finally {
      await writer.query('rollback')
      await Promise.allSettled(pending ? [pending] : [])
      writer.release()
    }
  })
})
