import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { workHandoffMigration } from '../src/infrastructure/workHandoffMigration.js'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { seedRun, text, transaction, type JsonObject } from './eng04-migration-fixtures.js'

const enabled = process.env.NIM2691_POSTGRES === '1'
const postgresDescribe = describe.skipIf(!enabled)

async function taskDatabase<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  assert.equal(process.env.NIM2691_POSTGRES, '1')
  const configured = process.env.NIM2691_ADMIN_DATABASE_URL
  assert.ok(configured, 'NIM2691_ADMIN_DATABASE_URL is required')
  const url = new URL(configured)
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  const name = `nim2691_${randomBytes(12).toString('hex')}`
  const admin = new pg.Client({ connectionString: configured, connectionTimeoutMillis: 10000 })
  let pool: pg.Pool | undefined
  let created = false
  try {
    await admin.connect()
    assert.equal((await admin.query<{ server_version_num: string }>('show server_version_num')).rows[0]?.server_version_num.startsWith('17'), true)
    await admin.query(`create database "${name}" template template0 encoding 'UTF8'`)
    created = true
    url.pathname = `/${name}`
    pool = new pg.Pool({ connectionString: url.toString(), max: 5 })
    assert.equal((await pool.query<{ name: string }>('select current_database() as name')).rows[0]?.name, name)
    return await work(pool)
  } finally {
    try { if (pool) await pool.end() }
    finally {
      try { if (created) await admin.query(`drop database "${name}"`) }
      finally { await admin.end() }
    }
  }
}

function handoffVersion(version: JsonObject) {
  const definition = version.definition as JsonObject
  delete definition.repeat
  definition.handoffs = { contractVersion: 1 }
  definition.edges = [
    { id: 'body-outside', kind: 'execution', source: 'body', target: 'outside', maxWorkHandoffsPerRun: 3 },
    { id: 'outside-other', kind: 'execution', source: 'outside', target: 'other', maxWorkHandoffsPerRun: 2 },
  ]
}

postgresDescribe('NIM-2691 durable handoff migration', () => {
  it('applies once and keeps old repeat Runs and their attempt indexes intact', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      await applyApplicationMigrations(pool)
      expect((await pool.query('select version from application_migrations where version=$1', [workHandoffMigration.version])).rowCount).toBe(1)
      expect((await pool.query(`select indexname from pg_indexes where tablename='harness_executions'
        and indexname in ('harness_executions_legacy_attempt','harness_executions_repeat_attempt','harness_executions_work_attempt')`)).rows).toHaveLength(3)
      const old = await transaction(pool, (sql) => seedRun(sql, 'nim2691-old'))
      expect((await pool.query('select workflow_version_id from runs where id=$1', [old.id])).rows[0]?.workflow_version_id).toBe(old.versionId)
    })
  }, 120000)

  it('keeps one Run-wide counter per connection and rejects a raw fourth reservation', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const run = await transaction(pool, (sql) => seedRun(sql, 'nim2691-count', 3, { versionPatch: handoffVersion }))
      const scope = { runId: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
        workflowVersionId: run.versionId, executionSemanticsVersion: 3 }
      await transaction(pool, async (sql) => {
        const entry = { scope, activationId: 'entry-body', workflowNodeId: 'body', cause: { kind: 'entry' } }
        await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,cause_kind,cause_id,state,record)
          values($1,$2,$3,'body','entry',$2,'running',$4::jsonb)`, ['entry-body', run.id, run.versionId, text(entry)])
        const source = { id: 'fixture-source-execution', runId: run.id, workflowNodeId: 'body',
          agentId: run.agentIds.body, agentConfigurationVersionId: run.configIds.body,
          attempt: 1, input: {}, state: 'completed', result: { outcome: 'succeeded', output: {} } }
        await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
          values($1,$2,'body',$3,1,true,$4::jsonb,'entry-body')`,
        [source.id, run.id, run.agentIds.body, text(source)])
        for (const [relationshipId, maximum] of [['body-outside', 3], ['outside-other', 2]] as const) {
          await sql.query(`insert into run_work_connection_usage(run_id,workflow_version_id,relationship_id,maximum)
            values($1,$2,$3,$4)`, [run.id, run.versionId, relationshipId, maximum])
        }
      })
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        await transaction(pool, async (sql) => {
          const requestId = `request-${ordinal}`, destinationActivationId = `outside-${ordinal}`
          const activation = { scope, activationId: destinationActivationId, workflowNodeId: 'outside',
            cause: { kind: 'work_request', requestId } }
          await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,cause_kind,cause_id,state,record)
            values($1,$2,$3,'outside','work_request',$4,'queued',$5::jsonb)`, [destinationActivationId, run.id, run.versionId, requestId, text(activation)])
          const updated = await sql.query<{ used: number }>(`update run_work_connection_usage set used=used+1
            where run_id=$1 and workflow_version_id=$2 and relationship_id='body-outside' and used<maximum returning used`,
          [run.id, run.versionId])
          expect(updated.rows[0]?.used).toBe(ordinal)
          const request = { scope, requestId, relationshipId: 'body-outside', ordinal,
            requesterActivationId: 'entry-body', requesterExecutionId: 'fixture-source-execution', destinationActivationId,
            requesterNodeId: 'body', destinationNodeId: 'outside', payloadDigest: `sha256:${'0'.repeat(64)}`,
            acceptedAt: '2026-09-27T00:00:00.000Z' }
          await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,ordinal,
            requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,payload_digest,record)
            values($1,$2,$3,'body-outside',$4,'entry-body','fixture-source-execution',$5,'body','outside',$6,$7::jsonb)`,
          [requestId, run.id, run.versionId, ordinal, destinationActivationId, request.payloadDigest, text(request)])
        })
      }
      const count = await pool.query<{ used: number }>(`select used from run_work_connection_usage
        where run_id=$1 and relationship_id='body-outside'`, [run.id])
      expect(count.rows[0]?.used).toBe(3)
      expect((await pool.query(`update run_work_connection_usage set used=used+1
        where run_id=$1 and relationship_id='body-outside' and used<maximum returning used`, [run.id])).rowCount).toBe(0)
      expect((await pool.query(`select used from run_work_connection_usage
        where run_id=$1 and relationship_id='outside-other'`, [run.id])).rows[0]?.used).toBe(0)
      await expect(transaction(pool, (sql) => sql.query(`update run_work_connection_usage set used=4
        where run_id=$1 and relationship_id='body-outside'`, [run.id]))).rejects.toThrow()
    })
  }, 120000)

  it('admits at most one racer for the last slot through the owner transaction and replays exact receipts', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const fixture = makeCurrentWorkflowFixture('nim2691-owner')
      const base = fixture.version
      const [requester, destination] = base.definition.nodes
      const savedEdge = base.definition.edges[0]!
      const version = WorkflowVersionV3Schema.parse({ ...base, definition: {
        ...base.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
        nodes: [{ ...requester!, choice: { outcomes: [
          { outcome: 'review', target: { kind: 'edge', relationshipId: savedEdge.id } },
        ] } }, destination],
        edges: [{ ...savedEdge, maxWorkHandoffsPerRun: 3 }],
      } })
      const run = { ...fixture.run, executionState: 'running' as const }
      await transaction(pool, async (sql) => {
        await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)', [run.workspaceId, text({ id: run.workspaceId })])
        await sql.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
          [run.workflowId, run.workspaceId, text({ id: run.workflowId, workspaceId: run.workspaceId })])
        for (const config of fixture.configurations) {
          await sql.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
            [config.agentId, run.workspaceId, text({ id: config.agentId, workspaceId: run.workspaceId })])
          await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
            values($1,$2,$3,1,$4::jsonb)`, [config.id, run.workspaceId, config.agentId, text(config)])
        }
        await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
          values($1,$2,$3,1,$4,3,$5::jsonb)`, [version.id, run.workspaceId, run.workflowId, version.entryNodeId, text(version)])
        await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
          values($1,$2,$3,$4,'running',$5::jsonb)`, [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
        for (let i = 1; i <= 4; i++) {
          const activationId = `activation-requester-${i}`
          const activation = { scope: fixture.scope, activationId, workflowNodeId: requester!.id,
            cause: i === 1 ? { kind: 'entry' } : { kind: 'dependency', resolutionId: `fixture-resolution-${i}` } }
          await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
            cause_kind,cause_id,state,record) values($1,$2,$3,$4,$5,$6,'completed',$7::jsonb)`,
          [activationId, run.id, version.id, requester!.id, activation.cause.kind,
            i === 1 ? run.id : `fixture-resolution-${i}`, text(activation)])
          const execution = { id: `source-execution-${i}`, runId: run.id, workflowNodeId: requester!.id,
            agentId: requester!.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[requester!.agentId],
            attempt: 1, input: {}, state: 'completed',
            result: { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
              data: { latestDeliverable: { revision: i }, remainingFindings: [] } } },
            createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
          await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
            values($1,$2,$3,$4,1,true,$5::jsonb,$6)`,
          [execution.id, run.id, requester!.id, requester!.agentId, text(execution), activationId])
        }
      })
      const owner = await RunOwnership.acquire(pool, run.id, () => undefined)
      assert.ok(owner)
      try {
        const host: RepeatRepositoryHost = { openLocked: async () => ({
          run,
          // These hooks isolate the PostgreSQL quota test. Native, grants and
          // publication are qualified separately through production services.
          assertAuthorityLocked: async () => undefined,
          assertAdmissionLocked: async () => undefined,
          assertSettlementLocked: async () => undefined,
          allowTechnicalRetryLocked: async () => false,
          publishLocked: async () => { throw new Error('Unexpected repeat publication') },
          assertPublicationReceiptLocked: async () => { throw new Error('Unexpected repeat receipt') },
          completeRunLocked: async () => { throw new Error('Unexpected completion') },
        }) }
        const store = new RepeatRunRepository(owner, host, version)
        const first = await store.admitWorkRequest('source-execution-1')
        expect(first.kind).toBe('accepted')
        assert.equal(first.kind, 'accepted')
        const review = { id: 'review-execution-1', runId: run.id, workflowNodeId: destination!.id,
          agentId: destination!.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[destination!.agentId],
          attempt: 1, input: {}, state: 'completed', result: { outcome: 'succeeded', output: {
            routing: { kind: 'return', requestId: first.request.requestId, outcome: 'needs_changes' },
            data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'finding-1' }] },
          } }, createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
        await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
          values($1,$2,$3,$4,1,true,$5::jsonb,$6)`,
        [review.id, run.id, destination!.id, destination!.agentId, text(review), first.request.destinationActivationId])
        const returned = await store.returnWork(review.id)
        expect(returned.value.outcome).toBe('needs_changes')
        expect(returned.value.requestId).toBe(first.request.requestId)
        expect(returned.value.continuationActivationId).toBeTruthy()
        expect((await store.returnWork(review.id)).replayed).toBe(true)
        expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1', [run.id])).rows[0]?.used).toBe(1)
        expect((await store.admitWorkRequest('source-execution-2')).kind).toBe('accepted')
        const last = await Promise.all([store.admitWorkRequest('source-execution-3'), store.admitWorkRequest('source-execution-4')])
        expect(last.map((item) => item.kind).sort()).toEqual(['accepted', 'limit_reached'])
        const accepted = last.find((item) => item.kind === 'accepted')!
        const denied = last.find((item) => item.kind === 'limit_reached')!
        expect(accepted.kind === 'accepted' && accepted.request.ordinal).toBe(3)
        expect(denied.kind === 'limit_reached' && denied.denial.used).toBe(3)
        expect((await store.admitWorkRequest('source-execution-3')).replayed).toBe(true)
        expect((await store.admitWorkRequest('source-execution-4')).replayed).toBe(true)
        expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1', [run.id])).rows[0]?.used).toBe(3)
        expect((await pool.query('select request_id from run_work_requests where run_id=$1', [run.id])).rowCount).toBe(3)
        expect((await pool.query('select denial_id from run_work_denials where run_id=$1', [run.id])).rowCount).toBe(1)
      } finally { await owner.release() }
    })
  }, 120000)
})
