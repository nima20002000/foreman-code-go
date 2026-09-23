import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { makeWave25Fixture, type NativeGraphProjectionKey } from '@graphql/contracts/wave25'
import { migrations } from '../../src/infrastructure/migrations.js'
import { nativeProjectionMigration } from '../../src/modules/run-graph/nativeProjectionMigration.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { withRunGraphPublication, graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import type { NativeGraphProjectionGuard } from '../../src/modules/run-graph/records.js'
import { PostgresNativeGraphProjectionWriter } from '../../src/modules/run-graph/nativeWriter.js'

export const postgresEnabled = process.env.RUN_WAVE25_A5_POSTGRES === '1' && Boolean(process.env.WAVE25_A5_TEST_DATABASE_URL)

/** Test-only persisted owner rows exercise the frozen guard; this is NOT a production runtime owner. */
export async function createPostgresFixture() {
  const url = new URL(process.env.WAVE25_A5_TEST_DATABASE_URL ?? '')
  if (!postgresEnabled || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/test$/i.test(url.pathname) || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('A local, explicitly disposable database ending in test is required')
  }
  const schema = `wave25_a5_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: url.toString(), max: 1 })
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}`, max: 8 })
  try {
    const unique = new Map<number, { readonly version: number; readonly sql: string }>(migrations.map((migration) => [migration.version, migration]))
    const registered = unique.get(nativeProjectionMigration.version)
    if (registered && registered.sql !== nativeProjectionMigration.sql) throw new Error('Migration 250005 collision')
    unique.set(nativeProjectionMigration.version, nativeProjectionMigration)
    const client = await pool.connect()
    try {
      await client.query('begin')
      for (const migration of [...unique.values()].sort((a, b) => a.version - b.version)) await client.query(migration.sql)
      await client.query(`create table a5_fixture_owners(
        run_id text primary key,scope jsonb not null,key jsonb not null,owner_id text not null,
        fence bigint not null,generation bigint not null,ownership text not null,access text not null)`)
      await client.query('commit')
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    return { pool, schema, close: async () => { await pool.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end() } }
  } catch (error) {
    await pool.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); throw error
  }
}
export type PostgresFixture = Awaited<ReturnType<typeof createPostgresFixture>>

export async function seedGraph(pool: pg.Pool) {
  const f = makeWave25Fixture(randomUUID().replaceAll('-', '').slice(0, 16))
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [f.scope.workspaceId, JSON.stringify({ id: f.scope.workspaceId, name: 'Synthetic test workspace' })])
  for (const configuration of f.configurations) {
    await pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [configuration.agentId, f.scope.workspaceId, JSON.stringify({ id: configuration.agentId, name: 'Synthetic worker' })])
    await pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
      [configuration.id, f.scope.workspaceId, configuration.agentId, JSON.stringify(configuration)])
  }
  await pool.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
    [f.scope.workflowId, f.scope.workspaceId, JSON.stringify(f.version.definition)])
  await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
    values($1,$2,$3,1,$4,2,$5::jsonb)`, [f.version.id, f.scope.workspaceId, f.scope.workflowId, f.version.entryNodeId, JSON.stringify(f.version)])
  await pool.query('insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values($1,$2,$3,$4,$5,$6::jsonb)',
    [f.run.id, f.scope.workspaceId, f.scope.workflowId, f.version.id, f.run.executionState, JSON.stringify(f.run)])
  for (const execution of f.executions) {
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,1,$5::jsonb)`, [execution.id, f.run.id, execution.workflowNodeId, execution.agentId,
      JSON.stringify({ ...execution, nativeSessionId: `session-${execution.id}` })])
  }
  const key: NativeGraphProjectionKey = { execution: f.identities[0]!, workKind: 'workflow', workId: f.identities[0]!.executionId }
  const expected = { scope: f.scope, key, ownerId: 'fixture-owner', fence: '1', connectionGeneration: '1' }
  await pool.query(`insert into a5_fixture_owners(run_id,scope,key,owner_id,fence,generation,ownership,access)
    values($1,$2::jsonb,$3::jsonb,$4,1,1,'held','project')`, [f.run.id, JSON.stringify(f.scope), JSON.stringify(key), expected.ownerId])
  const guard: NativeGraphProjectionGuard = { expected, readCurrentLocked: async (sql, scope) => {
    const row = (await sql.query<{ scope: typeof f.scope; key: NativeGraphProjectionKey; owner_id: string; fence: string; generation: string;
      ownership: 'held' | 'lost'; access: 'project' | 'observe' }>(
      'select scope,key,owner_id,fence::text,generation::text,ownership,access from a5_fixture_owners where run_id=$1 for update', [scope.runId])).rows[0]
    if (!row) throw new Error('Missing test owner')
    return { scope: row.scope, key: row.key, ownerId: row.owner_id, fence: row.fence, connectionGeneration: row.generation, ownership: row.ownership, access: row.access }
  } }
  const connectionId = `connection-${key.workId}`, nativeSessionId = `session-${key.workId}`, nativeTurnId = `turn-${key.workId}`
  await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, f.scope, async (publication) => {
    await publication.source({ evidence: { sourceKind: 'run', sourceId: f.run.id, sourceRevision: '0' },
      sourceDigest: graphSourceDigest(f.run), facts: [{ type: 'run.state', state: f.snapshot.state.run }] }, async () => {
      await publication.sql.query('select append_harness_native_event($1::jsonb)', [JSON.stringify({
        executionId: key.workId, connectionId, sequence: 0, type: 'thread.started', occurredAt: f.createdAt, payload: { threadId: nativeSessionId },
      })])
      await new PostgresNativeGraphProjectionWriter().persistCorrelation(publication.sql, f.scope, null, {
        key, correlationKey: 'fixture-submission', provider: 'codex', nativeSessionId, connectionId, connectionGeneration: 1,
        nativeTurnId, nativeRequestId: null, interactionId: null, reviewJobId: null, firstNativeSequence: '0', lastNativeSequence: '0',
        terminalNativeSequence: null, metadataRevision: '0',
      }, guard)
    })
  }, { historyCoverage: 'from_admission' }))
  return { ...f, key, guard, connectionId, nativeSessionId, nativeTurnId }
}
export type SeededGraph = Awaited<ReturnType<typeof seedGraph>>
