import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { assertOrchestratorGraphAuthority } from '../src/modules/interactions/graphAuthority.js'
import { approvalFixture, deliveryFixture } from './helpers/wave25ApprovalFixture.js'

// Deliberately a SQL consumer test with minimal tables, not production-migration,
// authenticated MCP, G1 publication, or atomic decision/recovery qualification.
// Requires an explicitly supplied disposable PostgreSQL database.
const connectionString = process.env.TEST_DATABASE_URL
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function setup() {
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required')
  const schema = `wave25_a4_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 })
  try {
    await admin.query(`create schema "${schema}"`)
  } catch (error) {
    await admin.end()
    throw error
  }
  const scoped = new URL(connectionString)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new pg.Pool({ connectionString: scoped.toString(), max: 4, connectionTimeoutMillis: 5000 })
  cleanup.push(async () => {
    try { await pool.end() } finally {
      try { await admin.query(`drop schema "${schema}" cascade`) } finally { await admin.end() }
    }
  })
  await pool.query(`
    create table workflow_versions (
      id text primary key, workspace_id text not null, workflow_id text not null, record jsonb not null
    );
    create table runs (
      id text primary key, workspace_id text not null, workflow_id text not null,
      workflow_version_id text not null references workflow_versions(id), record jsonb not null
    );
    create table agent_configuration_versions (
      id text primary key, workspace_id text not null, agent_id text not null, record jsonb not null
    );
    create table harness_executions (
      id text primary key, run_id text not null references runs(id),
      agent_id text not null, workflow_node_id text not null, record jsonb not null
    );
    create table worker_credential_bindings (
      principal_id text primary key, execution_id text not null references harness_executions(id),
      run_id text not null references runs(id), agent_id text not null, revoked_at timestamptz
    );
  `)
  const f = approvalFixture()
  await pool.query('insert into workflow_versions values($1,$2,$3,$4::jsonb)',
    [f.version.id, f.version.workspaceId, f.version.workflowId, JSON.stringify(f.version)])
  await pool.query('insert into runs values($1,$2,$3,$4,$5::jsonb)',
    [f.run.id, f.run.workspaceId, f.run.workflowId, f.run.workflowVersionId, JSON.stringify(f.run)])
  for (const configuration of f.configurations) {
    await pool.query('insert into agent_configuration_versions values($1,$2,$3,$4::jsonb)',
      [configuration.id, configuration.workspaceId, configuration.agentId, JSON.stringify(configuration)])
  }
  for (const execution of f.executions) {
    await pool.query('insert into harness_executions values($1,$2,$3,$4,$5::jsonb)',
      [execution.id, execution.runId, execution.agentId, execution.workflowNodeId, JSON.stringify(execution)])
  }
  const reviewer = f.executions[0]!
  await pool.query('insert into worker_credential_bindings values($1,$2,$3,$4,null)',
    ['bound-reviewer-principal', reviewer.id, f.run.id, reviewer.agentId])
  const bound = { executionId: reviewer.id, principalId: 'bound-reviewer-principal', nativeSessionId: reviewer.nativeSessionId! }
  return { ...f, pool, reviewer, bound, interaction: deliveryFixture().interaction }
}

describe.skipIf(!connectionString)('Wave 2.5 approval authority SQL consumer', () => {
  it('reads the persisted exact typed assignment and pins through the real query', async () => {
    const f = await setup()
    await expect(assertOrchestratorGraphAuthority(f.pool, f.interaction, f.bound)).resolves.toMatchObject({
      requestingNodeId: 'node-worker', orchestratorNodeId: 'node-reviewer', relationshipId: 'approval-edge',
    })
    const stored = await f.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])
    expect(stored.rows[0]!.record).toEqual(f.version)
    await expect(assertOrchestratorGraphAuthority(f.pool, f.interaction, { ...f.bound, principalId: 'not-bound' }))
      .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
  })

  it('observes credential revocation committed by an independent connection', async () => {
    const f = await setup()
    const reader = await f.pool.connect()
    try {
      const writer = await f.pool.connect()
      try {
        const readerPid = await reader.query<{ pid: number }>('select pg_backend_pid() as pid')
        const writerPid = await writer.query<{ pid: number }>('select pg_backend_pid() as pid')
        expect(readerPid.rows[0]!.pid).not.toBe(writerPid.rows[0]!.pid)
        await expect(assertOrchestratorGraphAuthority(reader, f.interaction, f.bound)).resolves.toBeDefined()
        await writer.query('begin')
        try {
          await writer.query('update worker_credential_bindings set revoked_at=clock_timestamp() where principal_id=$1', [f.bound.principalId])
          await writer.query('commit')
        } catch (error) {
          await writer.query('rollback')
          throw error
        }
        await expect(assertOrchestratorGraphAuthority(reader, f.interaction, f.bound))
          .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
      } finally { writer.release() }
    } finally { reader.release() }
  })

  it('refuses a previously captured reviewer session after a persisted owner-record change', async () => {
    const f = await setup()
    const changed = { ...f.reviewer, nativeSessionId: 'replacement-session' }
    await f.pool.query('update harness_executions set record=$2::jsonb where id=$1', [f.reviewer.id, JSON.stringify(changed)])
    await expect(assertOrchestratorGraphAuthority(f.pool, f.interaction, f.bound))
      .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
  })

  it('does not promote persisted execution adjacency into an approval assignment', async () => {
    const f = await setup()
    const changed = structuredClone(f.version)
    changed.definition.edges = changed.definition.edges.filter((edge) => edge.kind === 'execution')
    // Deliberately corrupt only this isolated fixture; never migrate an active Run this way.
    await f.pool.query('update workflow_versions set record=$2::jsonb where id=$1', [changed.id, JSON.stringify(changed)])
    await expect(assertOrchestratorGraphAuthority(f.pool, f.interaction, f.bound))
      .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
  })
})
