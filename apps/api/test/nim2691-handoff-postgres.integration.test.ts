import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { workHandoffMigration } from '../src/infrastructure/workHandoffMigration.js'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  CurrentWorkflowReadResultSchema, makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { readRepeatGraphExecutionsLocked } from '../src/modules/run-graph/repeatProjectionRows.js'
import { readCurrentActivityContext } from '../src/modules/run-graph/currentActivity.js'
import { readPublicNodeProjection } from '../src/modules/run-graph/publicProjection.js'
import { canonicalRepeatEffect } from '../src/modules/run-graph/repeatPublication.js'
import { RepeatRepositoryFactory } from '../src/modules/runs/repeatRepositoryHost.js'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { writerFixture } from './eng04-writer-fixtures.js'
import { graphFixture, graphHeaders, graphRpcValue, graphUrl } from './eng04-graph-composition-fixture.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { digest, seedRun, text, transaction, type JsonObject } from './eng04-migration-fixtures.js'

const enabled = process.env.NIM2691_POSTGRES === '1'
const postgresDescribe = describe.skipIf(!enabled)

async function taskDatabase<T>(work: (pool: pg.Pool, directory: string) => Promise<T>): Promise<T> {
  assert.equal(process.env.NIM2691_POSTGRES, '1')
  const configured = process.env.NIM2691_ADMIN_DATABASE_URL
  assert.ok(configured, 'NIM2691_ADMIN_DATABASE_URL is required')
  const url = new URL(configured)
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  const name = `nim2691_${randomBytes(12).toString('hex')}`
  const admin = new pg.Client({ connectionString: configured, connectionTimeoutMillis: 10000 })
  let pool: pg.Pool | undefined
  let directory: string | undefined
  let created = false
  try {
    await admin.connect()
    assert.equal((await admin.query<{ server_version_num: string }>('show server_version_num')).rows[0]?.server_version_num.startsWith('17'), true)
    await admin.query(`create database "${name}" template template0 encoding 'UTF8'`)
    created = true
    url.pathname = `/${name}`
    pool = new pg.Pool({ connectionString: url.toString(), max: 5 })
    directory = await mkdtemp(join(tmpdir(), 'nim2691-workspace-'))
    assert.equal((await pool.query<{ name: string }>('select current_database() as name')).rows[0]?.name, name)
    return await work(pool, directory)
  } finally {
    try { if (pool) await pool.end() }
    finally {
      try { if (created) await admin.query(`drop database "${name}"`) }
      finally {
        await admin.end()
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    }
  }
}

function handoffVersion(version: JsonObject) {
  const definition = version.definition as JsonObject
  delete definition.repeat
  definition.handoffs = { contractVersion: 1 }
  definition.edges = [
    { id: 'body-outside', kind: 'execution', source: 'body', target: 'outside', maxWorkHandoffsPerRun: 3 },
    { id: 'body-other', kind: 'execution', source: 'body', target: 'other', maxWorkHandoffsPerRun: 2 },
  ]
}

postgresDescribe('NIM-2691 durable handoff migration', () => {
  it('queues an entry through the production owner, native slot and canonical graph publication', async () => {
    await taskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await graphFixture(db, { form: 'sequential', handoffs: true, qualifiedReads: true })
      const owner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
      assert.ok(owner)
      let recoveredOwner: RunOwnership | undefined
      try {
        const locations = new WorkspaceLocationService(pool, t.commands, directory, 'runner-local', directory)
        const factory = new RepeatRepositoryFactory(locations, directory,
          createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify).services)
        const store = factory.forOwner(owner, t.version)
        const entry = await store.ensureWorkEntry()
        expect(await store.ensureWorkEntry()).toBe(entry)
        const node = t.version.definition.nodes[0]!
        const admitted = await store.admitWorkActivation(entry, () => ({
          id: `nim2691-entry-execution-${randomUUID()}`, runId: t.run.id,
          workflowNodeId: node.id, agentId: node.agentId,
          agentConfigurationVersionId: t.version.agentConfigurationVersionIds[node.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: new Date().toISOString(),
        }))
        expect(admitted.reused).toBe(false)
        expect((await store.admitWorkActivation(entry, () => { throw new Error('replay allocated') })).reused).toBe(true)
        const projected = await owner.oneShotConnection().transaction((sql) =>
          readRepeatGraphExecutionsLocked(sql, t.scope, [admitted.execution.id]), true)
        expect(projected[0]?.workActivationId).toBe(entry)
        const privateEffect = (await pool.query<{ payload_digest: string }>(`select payload_digest
          from run_repeat_effects where run_id=$1 and effect_kind='input.bind' and entity_id=$2`,
        [t.run.id, admitted.execution.id])).rows[0]
        assert.ok(privateEffect)
        const publicId = canonicalRepeatEffect(t.scope, { kind: 'input.bind', entityId: admitted.execution.id,
          digest: privateEffect.payload_digest }).identity.entityId
        expect((await pool.query(`select effect_kind from run_graph_effects
          where run_id=$1 and entity_id=$2 and effect_kind='input.bind'`, [t.run.id, publicId])).rowCount).toBe(1)
        const http = await t.app.inject({ method: 'GET', url: graphUrl(t, 'current'),
          headers: graphHeaders(t.writer.token) })
        expect(http.statusCode, http.body).toBe(200)
        expect(http.json().state.executions).toEqual(expect.arrayContaining([
          expect.objectContaining({ workActivationId: entry }),
        ]))
        const paths = { workingDirectory: t.run.executionLocation.rootPath,
          runtimeDirectory: repeatRuntimeDirectory(directory, t.scope, admitted.execution) }
        const claim = await store.claimLaunch(admitted.execution.id, paths)
        expect(claim?.state).toBe('starting')
        expect(store.consumeLaunchPermit(admitted.execution.id)).toBe(true)
        expect(store.consumeLaunchPermit(admitted.execution.id)).toBe(false)
        await owner.release()
        recoveredOwner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
        assert.ok(recoveredOwner)
        const recovered = factory.forOwner(recoveredOwner, t.version)
        expect(recovered.consumeLaunchPermit(admitted.execution.id)).toBe(false)
        expect(await recovered.claimLaunch(admitted.execution.id, paths)).toBeUndefined()
        expect((await recovered.recoverSession(admitted.execution.id)).state).toBe('starting')
        const forged = { ...claim!, state: 'completed', finishedAt: new Date().toISOString(),
          result: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
            data: { latestDeliverable: { id: 'forged-without-native-receipt' }, remainingFindings: [] } } } }
        await pool.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1',
          [admitted.execution.id, text(forged)])
        // The production G1 read rejects the unreceipted native state before
        // the work-specific accepted-result receipt is even considered.
        await expect(recovered.admitWorkRequest(admitted.execution.id, t.version.definition.edges[0]!.id))
          .rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
        expect((await pool.query('select 1 from run_work_requests where run_id=$1', [t.run.id])).rowCount).toBe(0)
        expect((await pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'",
          [t.run.id])).rowCount).toBe(1)
      } finally { await recoveredOwner?.release(); await owner.release(); await t.app.close() }
    })
  }, 120000)

  it('saves a marked line limit through authenticated HTTP and reads it through Operator MCP', async () => {
    await taskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await writerFixture(db)
      try {
        const input = CurrentWorkflowSaveInputSchema.parse({ ...t.input, graph: {
          ...t.input.graph, handoffs: { contractVersion: 1 },
          edges: t.input.graph.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })),
        } })
        const response = await t.app.inject({ method: 'PUT', url: t.url,
          headers: graphHeaders(t.writer.token), payload: input })
        expect(response.statusCode, response.body).toBe(200)
        const saved = CurrentWorkflowSaveResultSchema.parse(response.json())
        expect(saved.value.version.definition.handoffs).toEqual({ contractVersion: 1 })
        expect(saved.value.version.definition.edges[0]?.maxWorkHandoffsPerRun).toBe(3)
        const read = await t.call(CURRENT_WORKFLOW_TOOLS.saved,
          { workspaceId: input.workspaceId, workflowId: input.workflowId })
        expect(read.result?.isError).not.toBe(true)
        const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue(read.result))
        expect(persisted.version.id).toBe(saved.value.version.id)
        expect(persisted.version.definition.edges[0]?.maxWorkHandoffsPerRun).toBe(3)
        const reader = await t.credential([{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [input.workspaceId] } }])
        const denied = await t.call(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID() }, reader.token)
        expect(denied.result?.isError).toBe(true)
        expect((await pool.query('select count(*)::integer as n from workflow_versions where workflow_id=$1',
          [input.workflowId])).rows[0]?.n).toBe(1)
      } finally { await t.app.close() }
    })
  }, 120000)

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
        const entry = { scope, activationId: 'entry-body', workflowNodeId: 'body', lineageId: run.id,
          cause: { kind: 'entry' } }
        await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,cause_kind,cause_id,state,record)
          values($1,$2,$3,'body','entry',$2,'running',$4::jsonb)`, ['entry-body', run.id, run.versionId, text(entry)])
        for (const [relationshipId, maximum] of [['body-outside', 3], ['body-other', 2]] as const) {
          await sql.query(`insert into run_work_connection_usage(run_id,workflow_version_id,relationship_id,maximum)
            values($1,$2,$3,$4)`, [run.id, run.versionId, relationshipId, maximum])
        }
      })
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        await transaction(pool, async (sql) => {
          const requestId = `request-${ordinal}`, destinationActivationId = `outside-${ordinal}`
          const requesterActivationId = ordinal === 1 ? 'entry-body' : `body-${ordinal}`
          const requesterExecutionId = `fixture-source-execution-${ordinal}`
          if (ordinal > 1) {
            const requesterActivation = { scope, activationId: requesterActivationId, workflowNodeId: 'body', lineageId: run.id,
              cause: { kind: 'dependency', resolutionId: `fixture-resolution-${ordinal}` } }
            await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
              cause_kind,cause_id,state,record) values($1,$2,$3,'body','dependency',$4,'completed',$5::jsonb)`,
            [requesterActivationId, run.id, run.versionId, `fixture-resolution-${ordinal}`, text(requesterActivation)])
          }
          const sourceResult = { outcome: 'succeeded', output: { revision: ordinal } }
          const source = { id: requesterExecutionId, runId: run.id, workflowNodeId: 'body',
            agentId: run.agentIds.body, agentConfigurationVersionId: run.configIds.body,
            attempt: 1, input: {}, state: 'completed', result: sourceResult }
          await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
            values($1,$2,'body',$3,1,true,$4::jsonb,$5)`,
          [source.id, run.id, run.agentIds.body, text(source), requesterActivationId])
          await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,clock_timestamp())`,
          [source.id, run.id, requesterActivationId, text(sourceResult), digest(sourceResult)])
          const activation = { scope, activationId: destinationActivationId, workflowNodeId: 'outside', lineageId: run.id,
            cause: { kind: 'work_request', requestId } }
          await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,cause_kind,cause_id,state,record)
            values($1,$2,$3,'outside','work_request',$4,'queued',$5::jsonb)`, [destinationActivationId, run.id, run.versionId, requestId, text(activation)])
          const updated = await sql.query<{ used: number }>(`update run_work_connection_usage set used=used+1
            where run_id=$1 and workflow_version_id=$2 and relationship_id='body-outside' and used<maximum returning used`,
          [run.id, run.versionId])
          expect(updated.rows[0]?.used).toBe(ordinal)
          const request = { scope, requestId, relationshipId: 'body-outside', ordinal,
            requesterActivationId, requesterExecutionId, destinationActivationId,
            requesterNodeId: 'body', destinationNodeId: 'outside', payloadDigest: digest(sourceResult),
            acceptedAt: '2026-09-27T00:00:00.000Z' }
          await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,ordinal,
            requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,payload_digest,record)
            values($1,$2,$3,'body-outside',$4,$5,$6,$7,'body','outside',$8,$9::jsonb)`,
          [requestId, run.id, run.versionId, ordinal, requesterActivationId, requesterExecutionId,
            destinationActivationId, request.payloadDigest, text(request)])
        })
      }
      const count = await pool.query<{ used: number }>(`select used from run_work_connection_usage
        where run_id=$1 and relationship_id='body-outside'`, [run.id])
      expect(count.rows[0]?.used).toBe(3)
      expect((await pool.query(`update run_work_connection_usage set used=used+1
        where run_id=$1 and relationship_id='body-outside' and used<maximum returning used`, [run.id])).rowCount).toBe(0)
      expect((await pool.query(`select used from run_work_connection_usage
        where run_id=$1 and relationship_id='body-other'`, [run.id])).rows[0]?.used).toBe(0)
      await transaction(pool, async (sql) => {
        const activation = { scope, activationId: 'other-1', workflowNodeId: 'other', lineageId: run.id,
          cause: { kind: 'work_request', requestId: 'other-request-1' } }
        await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
          cause_kind,cause_id,state,record) values('other-1',$1,$2,'other','work_request','other-request-1','queued',$3::jsonb)`,
        [run.id, run.versionId, text(activation)])
        await sql.query(`update run_work_connection_usage set used=used+1
          where run_id=$1 and relationship_id='body-other'`, [run.id])
        const sourceResult = { outcome: 'succeeded', output: { revision: 1 } }
        const request = { scope, requestId: 'other-request-1', relationshipId: 'body-other', ordinal: 1,
          requesterActivationId: 'entry-body', requesterExecutionId: 'fixture-source-execution-1',
          destinationActivationId: 'other-1', requesterNodeId: 'body', destinationNodeId: 'other',
          payloadDigest: digest(sourceResult), acceptedAt: '2026-09-27T00:00:00.000Z' }
        await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,ordinal,
          requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,
          payload_digest,record) values('other-request-1',$1,$2,'body-other',1,'entry-body','fixture-source-execution-1',
            'other-1','body','other',$3,$4::jsonb)`, [run.id, run.versionId, request.payloadDigest, text(request)])
      })
      expect((await pool.query(`select used from run_work_connection_usage
        where run_id=$1 and relationship_id='body-other'`, [run.id])).rows[0]?.used).toBe(1)
      await expect(transaction(pool, (sql) => sql.query(`update run_work_connection_usage set used=4
        where run_id=$1 and relationship_id='body-outside'`, [run.id]))).rejects.toThrow()
      await expect(pool.query(`update run_work_connection_usage set used=2
        where run_id=$1 and relationship_id='body-outside'`, [run.id])).rejects.toThrow()
      await expect(pool.query('delete from run_work_requests where run_id=$1', [run.id])).rejects.toThrow()
      await expect(pool.query(`update run_work_results set result_json='{}' where run_id=$1`, [run.id])).rejects.toThrow()
      expect((await pool.query('delete from runs where id=$1', [run.id])).rowCount).toBe(1)
      expect((await pool.query('select 1 from run_work_requests where run_id=$1', [run.id])).rowCount).toBe(0)
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
        for (let i = 1; i <= 5; i++) {
          const activationId = `activation-requester-${i}`
          const activation = { scope: fixture.scope, activationId, workflowNodeId: requester!.id, lineageId: run.id,
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
          if (i !== 1) await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,clock_timestamp())`,
          [execution.id, run.id, activationId, text(execution.result), digest(execution.result)])
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
          publishLocked: async (_sql, _effect, _facts, mutate) => { await mutate() },
          assertPublicationReceiptLocked: async (sql, effect) => {
            const receipt = (await sql.query<{ payload_digest: string }>(
              `select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3`,
              [run.id, effect.kind, effect.entityId])).rows[0]
            assert.equal(receipt?.payload_digest, effect.digest)
          },
          completeRunLocked: async () => { throw new Error('Unexpected completion') },
        }) }
        const store = new RepeatRunRepository(owner, host, version)
        await expect(store.admitWorkRequest('source-execution-1')).rejects.toMatchObject({ code: 'WORK_RESULT_RECEIPT_MISSING' })
        expect((await pool.query('select used from run_work_connection_usage where run_id=$1', [run.id])).rowCount).toBe(0)
        const firstResult = { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: [] } } }
        await pool.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
          values('source-execution-1',$1,'activation-requester-1',$2,$3,clock_timestamp())`,
        [run.id, text(firstResult), digest(firstResult)])
        const first = await store.admitWorkRequest('source-execution-1')
        expect(first.kind).toBe('accepted')
        assert.equal(first.kind, 'accepted')
        const queued = await store.admitWorkActivation(first.request.destinationActivationId, () => ({
          id: 'review-execution-1', runId: run.id, workflowNodeId: destination!.id,
          agentId: destination!.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[destination!.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        expect(queued.reused).toBe(false)
        expect((queued.execution.input as { work: { request: { requestId: string } } }).work.request.requestId).toBe(first.request.requestId)
        expect((await store.admitWorkActivation(first.request.destinationActivationId, () => { throw new Error('replay allocated') })).reused).toBe(true)
        expect((await store.readExecution(queued.execution.id)).workActivationId).toBe(first.request.destinationActivationId)
        const projected = await owner.oneShotConnection().transaction((sql) =>
          readRepeatGraphExecutionsLocked(sql, fixture.scope, [queued.execution.id]), true)
        expect(projected[0]?.identity.executionId).toBe(queued.execution.id)
        expect(projected[0]?.workActivationId).toBe(first.request.destinationActivationId)
        const review = { ...queued.execution, state: 'completed', result: { outcome: 'succeeded', output: {
            routing: { kind: 'return', requestId: first.request.requestId, outcome: 'needs_changes' },
            data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'finding-1' }] },
          } }, finishedAt: fixture.createdAt }
        await pool.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1', [review.id, text(review)])
        await pool.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
          values($1,$2,$3,$4,$5,clock_timestamp())`,
        [review.id, run.id, first.request.destinationActivationId, text(review.result), digest(review.result)])
        const returned = await store.returnWork(review.id)
        expect(returned.value.outcome).toBe('needs_changes')
        expect(returned.value.requestId).toBe(first.request.requestId)
        expect(returned.value.continuationActivationId).toBeTruthy()
        expect((await store.returnWork(review.id)).replayed).toBe(true)
        expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1', [run.id])).rows[0]?.used).toBe(1)
        const beforeNext = await owner.oneShotConnection().transaction((sql) =>
          readCurrentActivityContext(sql, fixture.scope, destination!.id), true)
        expect(beforeNext.workflowClosed).toBe(true)
        const secondRequest = await store.admitWorkRequest('source-execution-2')
        assert.equal(secondRequest.kind, 'accepted')
        await store.admitWorkActivation(secondRequest.request.destinationActivationId, () => ({
          id: 'review-execution-2', runId: run.id, workflowNodeId: destination!.id,
          agentId: destination!.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[destination!.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const afterNext = await owner.oneShotConnection().transaction((sql) =>
          readCurrentActivityContext(sql, fixture.scope, destination!.id), true)
        expect(afterNext.workflowClosed).toBe(false)
        const current = await owner.oneShotConnection().transaction((sql) =>
          readPublicNodeProjection(sql, fixture.scope, [destination!.id]), true)
        expect(current[0]?.state.lifecycle).toBe('queued')
        expect(current[0]?.state.execution?.executionId).toBe('review-execution-2')
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
        await pool.query('update runs set stop_requested_at=clock_timestamp() where id=$1', [run.id])
        await expect(store.admitWorkRequest('source-execution-5')).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
        expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
          [run.id])).rows[0]?.used).toBe(3)
        await owner.release()
        const recoveredOwner = await RunOwnership.acquire(pool, run.id, () => undefined)
        assert.ok(recoveredOwner)
        try {
          const recovered = new RepeatRunRepository(recoveredOwner, host, version)
          expect((await recovered.admitWorkRequest('source-execution-3')).replayed).toBe(true)
          expect((await recovered.admitWorkRequest('source-execution-4')).replayed).toBe(true)
          expect(recovered.consumeLaunchPermit('review-execution-2')).toBe(false)
          expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
            [run.id])).rows[0]?.used).toBe(3)
        } finally { await recoveredOwner.release() }
      } finally { await owner.release() }
    })
  }, 120000)

  it('admits more than three uncapped exchanges and starts a fresh Run at one', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const fixture = makeCurrentWorkflowFixture('nim2691-unbounded')
      const source = fixture.version.definition.nodes[0]!, edge = fixture.version.definition.edges[0]!
      const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
        ...fixture.version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
        nodes: [{ ...source, choice: { outcomes: [
          { outcome: 'review', target: { kind: 'edge', relationshipId: edge.id } },
        ] } }, fixture.version.definition.nodes[1]],
      } })
      await transaction(pool, async (sql) => {
        await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)',
          [version.workspaceId, text({ id: version.workspaceId })])
        await sql.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
          [version.workflowId, version.workspaceId, text({ id: version.workflowId, workspaceId: version.workspaceId })])
        for (const config of fixture.configurations) {
          await sql.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
            [config.agentId, version.workspaceId, text({ id: config.agentId, workspaceId: version.workspaceId })])
          await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
            values($1,$2,$3,1,$4::jsonb)`, [config.id, version.workspaceId, config.agentId, text(config)])
        }
        await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
          values($1,$2,$3,1,$4,3,$5::jsonb)`,
        [version.id, version.workspaceId, version.workflowId, version.entryNodeId, text(version)])
      })
      const host = (run: typeof fixture.run): RepeatRepositoryHost => ({ openLocked: async () => ({
        run,
        assertAuthorityLocked: async () => undefined,
        assertAdmissionLocked: async () => undefined,
        assertSettlementLocked: async () => undefined,
        allowTechnicalRetryLocked: async () => false,
        publishLocked: async () => { throw new Error('Unexpected native publication') },
        assertPublicationReceiptLocked: async () => { throw new Error('Unexpected native receipt') },
        completeRunLocked: async () => { throw new Error('Unexpected completion') },
      }) })
      const seed = async (runId: string, count: number) => {
        const run = { ...fixture.run, id: runId, executionState: 'running' as const }
        const scope = { ...fixture.scope, runId }
        await transaction(pool, async (sql) => {
          await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
            values($1,$2,$3,$4,'running',$5::jsonb)`,
          [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
          for (let index = 1; index <= count; index++) {
            const activationId = `${run.id}-source-${index}`, executionId = `${run.id}-execution-${index}`
            const cause = index === 1 ? { kind: 'entry' } : { kind: 'dependency', resolutionId: `${run.id}-resolution-${index}` }
            const activation = { scope, activationId, workflowNodeId: source.id, lineageId: run.id, cause }
            await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
              cause_kind,cause_id,state,record) values($1,$2,$3,$4,$5,$6,'completed',$7::jsonb)`,
            [activationId, run.id, version.id, source.id, cause.kind,
              index === 1 ? run.id : `${run.id}-resolution-${index}`, text(activation)])
            const result = { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
              data: { latestDeliverable: { revision: index }, remainingFindings: [] } } }
            const execution = { id: executionId, runId: run.id, workflowNodeId: source.id, agentId: source.agentId,
              agentConfigurationVersionId: version.agentConfigurationVersionIds[source.agentId],
              attempt: 1, input: {}, state: 'completed', result,
              createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
            await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
              values($1,$2,$3,$4,1,true,$5::jsonb,$6)`,
            [executionId, run.id, source.id, source.agentId, text(execution), activationId])
            await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
              values($1,$2,$3,$4,$5,clock_timestamp())`,
            [executionId, run.id, activationId, text(result), digest(result)])
          }
        })
        return run
      }
      const firstRun = await seed('nim2691-uncapped-run', 5)
      const firstOwner = await RunOwnership.acquire(pool, firstRun.id, () => undefined)
      assert.ok(firstOwner)
      try {
        const store = new RepeatRunRepository(firstOwner, host(firstRun), version)
        for (let index = 1; index <= 5; index++) {
          const admitted = await store.admitWorkRequest(`${firstRun.id}-execution-${index}`)
          assert.equal(admitted.kind, 'accepted')
          expect(admitted.request.ordinal).toBe(index)
        }
        expect((await pool.query<{ used: number; maximum: number | null }>(
          'select used,maximum from run_work_connection_usage where run_id=$1', [firstRun.id])).rows[0])
          .toEqual({ used: 5, maximum: null })
      } finally { await firstOwner.release() }
      const freshRun = await seed('nim2691-fresh-run', 1)
      const freshOwner = await RunOwnership.acquire(pool, freshRun.id, () => undefined)
      assert.ok(freshOwner)
      try {
        const admitted = await new RepeatRunRepository(freshOwner, host(freshRun), version)
          .admitWorkRequest(`${freshRun.id}-execution-1`)
        assert.equal(admitted.kind, 'accepted')
        expect(admitted.request.ordinal).toBe(1)
      } finally { await freshOwner.release() }
    })
  }, 120000)

  it('holds an all-required join until both exact branch requests arrive', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const fixture = makeCurrentWorkflowFixture('nim2691-join', 'parallel')
      const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
        ...fixture.version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
        edges: fixture.version.definition.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })),
      } })
      const run = { ...fixture.run, executionState: 'running' as const }
      const [b, c, d] = [version.definition.nodes[1]!, version.definition.nodes[2]!, version.definition.nodes[3]!]
      const incoming = version.definition.edges.filter((edge) => edge.target === d.id)
      expect(incoming).toHaveLength(2)
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
        for (const [index, node] of [b, c].entries()) {
          const activationId = `branch-activation-${index}`, executionId = `branch-execution-${index}`
          const activation = { scope: fixture.scope, activationId, workflowNodeId: node.id,
            lineageId: run.id, cause: { kind: 'dependency', resolutionId: `branch-resolution-${index}` } }
          await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
            cause_kind,cause_id,state,record) values($1,$2,$3,$4,'dependency',$5,'completed',$6::jsonb)`,
          [activationId, run.id, version.id, node.id, `branch-resolution-${index}`, text(activation)])
          const result = { outcome: 'succeeded', output: { routing: { kind: 'finish' },
            data: { latestDeliverable: { branch: index }, remainingFindings: [] } } }
          const execution = { id: executionId, runId: run.id, workflowNodeId: node.id, agentId: node.agentId,
            agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
            attempt: 1, input: {}, state: 'completed', result,
            createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
          await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
            values($1,$2,$3,$4,1,true,$5::jsonb,$6)`,
          [executionId, run.id, node.id, node.agentId, text(execution), activationId])
          await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,clock_timestamp())`,
          [executionId, run.id, activationId, text(result), digest(result)])
        }
      })
      const owner = await RunOwnership.acquire(pool, run.id, () => undefined)
      assert.ok(owner)
      try {
        const host: RepeatRepositoryHost = { openLocked: async () => ({ run,
          assertAuthorityLocked: async () => undefined,
          assertAdmissionLocked: async () => undefined,
          assertSettlementLocked: async () => undefined,
          allowTechnicalRetryLocked: async () => false,
          publishLocked: async (_sql, _effect, _facts, mutate) => { await mutate() },
          assertPublicationReceiptLocked: async (sql, effect) => {
            const row = (await sql.query<{ payload_digest: string }>(
              'select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',
              [run.id, effect.kind, effect.entityId])).rows[0]
            assert.equal(row?.payload_digest, effect.digest)
          },
          completeRunLocked: async () => { throw new Error('Unexpected completion') },
        }) }
        const store = new RepeatRunRepository(owner, host, version)
        const entryId = await store.ensureWorkEntry()
        expect(await store.ensureWorkEntry()).toBe(entryId)
        const first = await store.admitWorkRequest('branch-execution-0', incoming[0]!.id)
        assert.equal(first.kind, 'accepted')
        expect(first.destinationReady).toBe(false)
        await expect(store.completeWorkRun()).rejects.toMatchObject({ code: 'WORK_ACTIVATIONS_UNRESOLVED' })
        await expect(store.admitWorkActivation(first.request.destinationActivationId,
          () => { throw new Error('incomplete join allocated') })).rejects.toMatchObject({ code: 'WORK_JOIN_INCOMPLETE' })
        const second = await store.admitWorkRequest('branch-execution-1', incoming[1]!.id)
        assert.equal(second.kind, 'accepted')
        expect(second.destinationReady).toBe(true)
        expect(second.request.destinationActivationId).toBe(first.request.destinationActivationId)
        const queued = await store.admitWorkActivation(first.request.destinationActivationId, () => ({
          id: 'joined-execution', runId: run.id, workflowNodeId: d.id, agentId: d.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[d.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const input = queued.execution.input as { work: { kind: string; sources: Array<{ request: { relationshipId: string } }> } }
        expect(input.work.kind).toBe('join')
        expect(input.work.sources.map((source) => source.request.relationshipId).sort())
          .toEqual(incoming.map((edge) => edge.id).sort())
        expect((await store.admitWorkActivation(first.request.destinationActivationId,
          () => { throw new Error('join replay allocated') })).reused).toBe(true)
        expect((await pool.query('select count(*)::integer as n from run_work_activations where run_id=$1 and workflow_node_id=$2',
          [run.id, d.id])).rows[0]?.n).toBe(1)
      } finally { await owner.release() }
    })
  }, 120000)
})
