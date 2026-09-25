import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ManagementActionSchema, type ManagementGrant } from '@graphql/contracts/management'
import {
  canonicalGraphJson, makeWave25Fixture, RepeatWorkflowVersionV1Schema, WorkflowVersionV2Schema,
  type RepeatSaveInput, type RepeatWorkflowVersionV1,
} from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { repeatWriterMigration } from '../src/infrastructure/repeatWriterMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { commandInputHash, PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { createRepeatServices } from '../src/modules/repeats/composition.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

export const writerPostgresEnabled = process.env.ENG04_WRITER_POSTGRES === '1'

/** Own random schema in the explicitly configured loopback test database. No
 * native manager, paid provider, browser credential, shared-table cleanup, role
 * change, DATABASE_URL fallback, trigger bypass, or fabricated native evidence.
 */
export async function writerDatabase(beforeWriter = false) {
  assert.equal(process.env.ENG04_WRITER_POSTGRES, '1')
  const url = process.env.WAVE25_TEST_DATABASE_URL
  assert.ok(url, 'WAVE25_TEST_DATABASE_URL is required')
  const parsed = new URL(url)
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    && parsed.pathname.toLowerCase().includes('test'), 'Use the explicitly permitted loopback test database')
  const schema = `eng04_writer_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  let pool: pg.Pool | undefined
  let directory: string | undefined
  let created = false
  try {
    const version = Number((await admin.query<{ server_version_num: string }>('show server_version_num')).rows[0]!.server_version_num)
    assert.ok(version >= 170000 && version < 180000, 'This qualification requires PostgreSQL 17')
    await admin.query(`create schema ${schema}`)
    created = true
    pool = new pg.Pool({ connectionString: url, max: 6,
      options: `-c search_path=${schema},public -c statement_timeout=15000 -c lock_timeout=5000` })
    directory = await mkdtemp(join(tmpdir(), 'eng04-writer-'))
    if (beforeWriter) {
      // Full exact preceding registry, not a miniature substitute schema and
      // never an uninstall/replacement of the already applied old SQL.
      await transaction(pool, async (sql) => {
        await sql.query('select pg_advisory_xact_lock($1)', [810_001])
        const index = migrations.findIndex((migration) => migration.version === repeatWriterMigration.version)
        assert.ok(index > 0)
        for (const migration of migrations.slice(0, index)) {
          await sql.query(migration.sql)
          await sql.query('insert into application_migrations(version) values($1)', [migration.version])
        }
      })
    } else await applyApplicationMigrations(pool)
    const installedPool = pool, installedDirectory = directory
    return { pool: installedPool, directory: installedDirectory, schema, serverVersion: version,
      async close() {
        await installedPool.end()
        try { await admin.query(`drop schema ${schema} cascade`) } finally { await admin.end() }
        await rm(installedDirectory, { recursive: true, force: true })
      } }
  } catch (error) {
    await pool?.end()
    try { if (created) await admin.query(`drop schema ${schema} cascade`) } finally { await admin.end() }
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  }
}
export type WriterDatabase = Awaited<ReturnType<typeof writerDatabase>>

export async function transaction<T>(pool: pg.Pool, work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
  const sql = await pool.connect()
  try {
    await sql.query('begin')
    const result = await work(sql)
    await sql.query('commit')
    return result
  } catch (error) {
    await sql.query('rollback')
    throw error
  } finally { sql.release() }
}

export async function writerFixture(db: WriterDatabase, withRun = false, withReviewer = false) {
  const f = makeWave25Fixture(randomUUID())
  const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
  f.version = WorkflowVersionV2Schema.parse({ ...f.version, definition: { ...f.version.definition,
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 }, nodes: [entry, { ...exit, choice: { outcomes: [
      { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
    ] } }],
  } })
  if (withReviewer) {
    f.configurations[0]!.productRole = 'orchestrator'
    const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: entry.agentId }
    f.version = WorkflowVersionV2Schema.parse({ ...f.version, approval, definition: { ...f.version.definition, approval,
      edges: [...f.version.definition.edges, { id: 'existing-reviewer', kind: 'approval', source: entry.id, target: exit.id }],
    } })
    f.run = { ...f.run, approval }
  }
  await seedAgent3(db.pool, db.directory, f, { run: withRun })
  const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
  const scope = { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] }
  const credential = (grants: ManagementGrant[]) => access.issue({ name: 'Synthetic ENG04 writer test Operator',
    audience: 'operator', expiresAt: new Date(Date.now() + 300000), grants })
  const writer = await credential([{ actions: ['capabilities:read'], scope: {} },
    { actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'), scope }])
  // Only unused management services are absent. Repeat authoring, reads,
  // transport authentication, command coordination, SQL and audit are real.
  const services = { commands, repeats: createRepeatServices(db.pool, commands) } as OperatorServices
  const app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } },
    checkpoints: { ping: async () => undefined } }, operator: { access, services } })
  await app.ready()
  const revision = Number((await db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.scope.workflowId])).rows[0]!.revision)
  const input: RepeatSaveInput = {
    workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, commandId: randomUUID(), expectedRevision: revision,
    expectedWorkflowVersionId: f.version.id, executionSemanticsVersion: 3,
    repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
      exitNodeId: exit.id, maxOccurrences: 2, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] },
  }
  const url = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/repeat`
  return { db, app, f, input, writer, access, credential, scope, url }
}
export type WriterFixture = Awaited<ReturnType<typeof writerFixture>>
export function headers(token: string) {
  return { host: 'localhost', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }
}
const mcpOrigins = new WeakMap<FastifyInstance, Promise<string>>()

export async function mcp(app: FastifyInstance, token: string, name: string, args: unknown) {
  let origin = mcpOrigins.get(app)
  if (!origin) {
    origin = app.listen({ host: '127.0.0.1', port: 0 })
    mcpOrigins.set(app, origin)
  }
  const response = await fetch(new URL('/mcp/operator', await origin), {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(response.status).toBe(200)
  const body = await response.text()
  const message = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
    : JSON.parse(body)
  return (message as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result
}
export function contentJson(candidate: RepeatWorkflowVersionV1): string {
  const value = canonicalGraphJson({ definition: candidate.definition,
    configurations: candidate.agentConfigurationVersionIds, entryNodeId: candidate.entryNodeId })
  candidate.contentHash = `sha256:${createHash('sha256').update(value).digest('hex')}`
  return value
}
export async function candidateFor(t: WriterFixture, input = t.input) {
  const row = (await t.db.pool.query<{ record: unknown; current: unknown }>(
    `select v.record,w.record as current from workflows w join workflow_versions v on v.id=w.current_version_id where w.id=$1`,
    [input.workflowId])).rows[0]!
  const raw = row.record as { executionSemanticsVersion: number }
  const base = raw.executionSemanticsVersion === 3 ? RepeatWorkflowVersionV1Schema.parse(raw) : WorkflowVersionV2Schema.parse(raw)
  const now = new Date().toISOString()
  const candidate = RepeatWorkflowVersionV1Schema.parse({ ...base, id: `workflow-version-${randomUUID()}`,
    version: base.version + 1, executionSemanticsVersion: 3, createdAt: now,
    definition: { ...(row.current as object), version: base.version + 1, executionSemanticsVersion: 3, repeat: input.repeat, updatedAt: now } })
  contentJson(candidate)
  return candidate
}
export async function insertCandidate(sql: pg.PoolClient, candidate: RepeatWorkflowVersionV1) {
  return sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
    values($1,$2,$3,$4,$5,$6::jsonb,3)`, [candidate.id, candidate.workspaceId, candidate.workflowId,
    candidate.version, candidate.entryNodeId, JSON.stringify(candidate)])
}
export async function publishCandidate(sql: pg.PoolClient, t: WriterFixture, candidate: RepeatWorkflowVersionV1,
  input = t.input, principalId = t.writer.principal.id, witness = contentJson(candidate)) {
  return sql.query('select eng04_publish_repeat_workflow($1,$2,$3::jsonb,$4,$5,$6)::text as revision',
    [principalId, 'http', JSON.stringify(input), commandInputHash(input), candidate.id, witness])
}
export async function snapshot(t: WriterFixture) {
  return {
    workflow: (await t.db.pool.query('select record,current_version_id,revision::text from workflows where id=$1', [t.input.workflowId])).rows,
    versions: (await t.db.pool.query('select id,record,execution_semantics_version,xmin::text,ctid::text from workflow_versions where workflow_id=$1 order by version', [t.input.workflowId])).rows,
    publications: (await t.db.pool.query('select * from repeat_workflow_publications where workflow_id=$1 order by expected_revision', [t.input.workflowId])).rows,
    receipts: (await t.db.pool.query(`select operation,command_id,result from management_command_receipts
      where principal_id=$1 and operation='repeat.save' order by command_id`, [t.writer.principal.id])).rows,
  }
}
export async function rejectSql(t: WriterFixture, work: (sql: pg.PoolClient) => Promise<unknown>, code: string, message: string) {
  const before = await snapshot(t)
  await expect(transaction(t.db.pool, work)).rejects.toMatchObject({ code, message: expect.stringContaining(message) })
  expect(await snapshot(t)).toEqual(before)
}
