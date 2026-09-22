import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { AgentSchema, HarnessExecutionSchema, type HarnessExecution } from '@graphql/contracts'
import { makeWave25Fixture, WorkflowRunV2Schema, type WorkflowVersionV2 } from '@graphql/contracts/wave25'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { insertOneShotRun } from '../../src/modules/runs/oneShotAdmission.js'
import { RunOwnership } from '../../src/modules/runs/ownership.js'
import { OneShotRunRepository } from '../../src/modules/runs/oneShotPostgres.js'
import { PostgresInteractionCoordinationRepository } from '../../src/modules/interactions/coordination.js'

export const postgresEnabled = process.env.RUN_WAVE25_POSTGRES_TESTS === '1'
export type Agent3Fixture = ReturnType<typeof makeWave25Fixture>

/** Uses real independent PostgreSQL sessions and an isolated random schema.
 * No DATABASE_URL fallback, public host, destructive shared-table cleanup or
 * paid native model. Every suite must explicitly opt in to a loopback test DB. */
export async function agent3Database() {
  const url = process.env.WAVE25_TEST_DATABASE_URL
  if (!url) throw new Error('WAVE25_TEST_DATABASE_URL is required when RUN_WAVE25_POSTGRES_TESTS=1')
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
  const schema = `wave25_a3_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  await admin.query(`create schema ${schema}`)
  const pool = new pg.Pool({ connectionString: url, max: 10,
    options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=5000` })
  const directory = await mkdtemp(join(tmpdir(), 'wave25-a3-'))
  try { await applyApplicationMigrations(pool) } catch (error) {
    await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end()
    await rm(directory, { recursive: true, force: true }); throw error
  }
  return {
    pool, schema, directory,
    async close() {
      await pool.end()
      try { await admin.query(`drop schema ${schema} cascade`) } finally { await admin.end() }
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export async function seedAgent3(pool: pg.Pool, directory: string, fixture = makeWave25Fixture(randomUUID()), options: { run?: boolean; legacy?: boolean } = {}) {
  const location = { runnerId: 'local', rootPath: directory, locationRevision: 1, identityHash: 'sha256:' + '1'.repeat(64) }
  fixture.run = WorkflowRunV2Schema.parse({ ...fixture.run, executionLocation: location })
  const version: Record<string, unknown> = structuredClone(fixture.version)
  const definition = version.definition as Record<string, unknown>
  if (options.legacy) {
    delete version.executionSemanticsVersion
    delete definition.executionSemanticsVersion
    delete definition.entryNodeId
    definition.edges = fixture.version.definition.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, route: { outcomes: ['succeeded'] } }))
  }
  await pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
    values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [fixture.scope.workspaceId, JSON.stringify({ id: fixture.scope.workspaceId, name: 'Synthetic Agent 3 test' }),
  JSON.stringify({ runnerId: location.runnerId, rootPath: location.rootPath }), JSON.stringify({ synthetic: true })])
  for (const config of fixture.configurations) {
    const agent = AgentSchema.parse({ id: config.agentId, name: 'Synthetic Worker', productRole: config.productRole,
      harness: config.harness.harness, model: config.harness.model, effort: 'low', fastMode: false,
      harnessConfiguration: config.harness, prompt: config.prompt, assignedSkills: config.assignedSkills, configurationVersionId: config.id })
    await pool.query('insert into agents(id,workspace_id,current_configuration_version_id,record) values($1,$2,null,$3::jsonb)',
      [config.agentId, fixture.scope.workspaceId, JSON.stringify(agent)])
    await pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
      [config.id, fixture.scope.workspaceId, config.agentId, JSON.stringify(config)])
    await pool.query('update agents set current_configuration_version_id=$2 where id=$1', [config.agentId, config.id])
  }
  await pool.query('insert into workflows(id,workspace_id,current_version_id,record) values($1,$2,null,$3::jsonb)',
    [fixture.scope.workflowId, fixture.scope.workspaceId, JSON.stringify(definition)])
  await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
    values($1,$2,$3,1,$4,$5::jsonb,$6)`, [fixture.version.id, fixture.scope.workspaceId, fixture.scope.workflowId,
  fixture.version.entryNodeId, JSON.stringify(version), options.legacy ? 1 : 2])
  await pool.query('update workflows set current_version_id=$2 where id=$1', [fixture.scope.workflowId, fixture.version.id])
  if (options.run !== false) {
    if (options.legacy) throw new Error('This helper does not silently upgrade a legacy Run')
    await withExclusiveGraphConnection(pool, (connection) => connection.transaction((sql) => insertOneShotRun(sql, fixture.run)))
  }
  return fixture
}

export async function ownedAgent3(pool: pg.Pool, fixture: Agent3Fixture) {
  const owner = await RunOwnership.acquire(pool, fixture.run.id, () => undefined)
  if (!owner) throw new Error('Synthetic test Run unexpectedly has an owner')
  return { owner, store: new OneShotRunRepository(owner) }
}

export function candidateFor(fixture: Agent3Fixture, nodeId = fixture.version.entryNodeId): HarnessExecution {
  const identity = fixture.identities.find((item) => item.workflowNodeId === nodeId)
  if (!identity) throw new Error('Unknown synthetic node')
  return HarnessExecutionSchema.parse({ id: identity.executionId, runId: fixture.run.id, workflowNodeId: nodeId,
    agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
    attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt })
}

/** Simulates a positively evidenced provider completion; does not test native
 * transport/projection mapping. Those providers are the Agent 5 lane. */
export async function terminalAgent3(pool: pg.Pool, store: OneShotRunRepository, fixture: Agent3Fixture,
  execution: HarnessExecution, output: unknown = { done: true }) {
  const paths = { workingDirectory: fixture.run.executionLocation!.rootPath,
    runtimeDirectory: join(fixture.run.executionLocation!.rootPath, execution.id) }
  const claimed = await store.claimLaunch(execution.id, paths)
  if (!claimed) throw new Error('Expected one first-launch claim in synthetic fixture')
  const session = { harness: 'codex' as const, providerVersion: 'synthetic-no-native-call', nativeSessionId: `native-${execution.id}` }
  await new PostgresInteractionCoordinationRepository(pool).bindWorkflowSession(execution.id, session)
  const completed = HarnessExecutionSchema.parse({ ...claimed, nativeSessionId: session.nativeSessionId,
    state: 'completed', result: { outcome: 'succeeded', output }, finishedAt: new Date().toISOString() })
  await store.updateExecution(completed)
  return completed
}

export async function graphHead(pool: pg.Pool, runId: string): Promise<string> {
  return (await pool.query<{ head: string }>('select head_sequence::text as head from run_graph_heads where run_id=$1', [runId])).rows[0]!.head
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

export function setFixtureVersion(fixture: Agent3Fixture, version: WorkflowVersionV2): Agent3Fixture {
  fixture.version = version
  fixture.run = WorkflowRunV2Schema.parse({ ...fixture.run, workflowVersionId: version.id, agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval: version.approval })
  return fixture
}
