import assert from 'node:assert/strict'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema, type ExecutionResult } from '@graphql/contracts'
import {
  WorkReturnSchema, WorkNoticeSchema, WorkHandoffResultSchema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture,
  canonicalGraphJson, type WorkHandoffResult,
} from '@graphql/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { assertWorkHandoffDeliveryLocked } from '../src/modules/runs/workHandoffDelivery.js'
import { createWorkLimitNotice } from '../src/modules/runs/workHandoffNotice.js'
import { repeatDigest, repeatId } from '../src/modules/runs/repeatResolution.js'
import { nim2691TaskDatabase as taskDatabase } from './helpers/nim2691Database.js'

const text = (value: unknown) => canonicalGraphJson(value, 4 * 1024 * 1024)

// Start at the committed terminal-acceptance boundary. Native settlement and
// publication are fixture ports; return correlation and persistence use real SQL.
async function acceptedReview(pool: pg.Pool, output: WorkHandoffResult,
  options: { reviewAccepted: boolean } = { reviewAccepted: true }) {
  const fixture = makeCurrentWorkflowFixture('review-delivery')
  const [source, reviewer] = fixture.version.definition.nodes
  assert.ok(source && reviewer && source.kind !== 'job' && reviewer.kind !== 'job')
  const edge = fixture.version.definition.edges[0]!
  const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
    ...fixture.version.definition, handoffs: { contractVersion: 1 },
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 10 },
    edges: [{ ...edge, maxWorkHandoffsPerRun: 1 }],
    nodes: [{ ...source, choice: { outcomes: [
      { outcome: 'review', target: { kind: 'edge', relationshipId: edge.id } },
    ] } }, reviewer],
  } })
  const run = { ...fixture.run, executionState: 'running' as const }
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [run.workspaceId, text({ id: run.workspaceId })])
  await pool.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
    [run.workflowId, run.workspaceId, text({ id: run.workflowId, workspaceId: run.workspaceId })])
  for (const config of fixture.configurations) {
    await pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [config.agentId, run.workspaceId, text({ id: config.agentId, workspaceId: run.workspaceId })])
    await pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
      values($1,$2,$3,1,$4::jsonb)`, [config.id, run.workspaceId, config.agentId, text(config)])
  }
  await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
    values($1,$2,$3,1,$4,3,$5::jsonb)`, [version.id, run.workspaceId, run.workflowId, version.entryNodeId, text(version)])
  await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
    values($1,$2,$3,$4,'running',$5::jsonb)`, [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
  const requestId = output.routing.kind === 'return' ? output.routing.requestId : 'review-request'
  const sourceResult: ExecutionResult = { outcome: 'succeeded', output: {
    routing: { kind: 'request', outcome: 'review' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
  } }
  const request = { scope: fixture.scope, requestId, relationshipId: edge.id,
    requesterActivationId: 'requester-activation', requesterExecutionId: 'requester-execution',
    destinationActivationId: 'review-activation', requesterNodeId: source.id, destinationNodeId: reviewer.id,
    payloadDigest: repeatDigest(sourceResult), acceptedAt: fixture.createdAt, ordinal: 1 }
  const executions = []
  for (const [index, node] of [source, reviewer].entries()) {
    const activationId = index ? request.destinationActivationId : request.requesterActivationId
    const executionId = index ? 'review-execution' : request.requesterExecutionId
    const cause = index ? { kind: 'work_request', requestId } : { kind: 'entry' }
    const activation = { scope: fixture.scope, activationId, workflowNodeId: node.id, lineageId: run.id, cause }
    await pool.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
      cause_kind,cause_id,state,record) values($1,$2,$3,$4,$5,$6,'completed',$7::jsonb)`,
      [activationId, run.id, version.id, node.id, cause.kind, index ? requestId : run.id, text(activation)])
    const result: ExecutionResult = index ? { outcome: 'succeeded', output } : sourceResult
    const execution = HarnessExecutionSchema.parse({ id: executionId, runId: run.id, workflowNodeId: node.id,
      agentId: node.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
      attempt: 1, input: {}, state: 'completed', result, createdAt: fixture.createdAt, finishedAt: fixture.createdAt })
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
      values($1,$2,$3,$4,1,$5,$6::jsonb,$7)`,
      [executionId, run.id, node.id, node.agentId, index ? options.reviewAccepted : true, text(execution), activationId])
    if (!index || options.reviewAccepted) await pool.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
      values($1,$2,$3,$4,$5,$6)`, [executionId, run.id, activationId, text(result), repeatDigest(result), fixture.createdAt])
    executions.push(execution)
  }
  await pool.query(`insert into run_work_connection_usage(run_id,workflow_version_id,relationship_id,used,maximum)
    values($1,$2,$3,1,1)`, [run.id, version.id, edge.id])
  await pool.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,
    requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,
    ordinal,payload_digest,record,accepted_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11::jsonb,$12)`, [requestId, run.id, version.id, edge.id,
    request.requesterActivationId, request.requesterExecutionId, request.destinationActivationId,
    source.id, reviewer.id, request.payloadDigest, text(request), fixture.createdAt])

  const host: RepeatRepositoryHost = { openLocked: async () => ({ run,
    assertAuthorityLocked: async () => undefined, assertAdmissionLocked: async () => undefined,
    assertSettlementLocked: async () => undefined, allowTechnicalRetryLocked: async () => false,
    publishLocked: async () => { throw new Error('Unexpected native publication') },
    assertPublicationReceiptLocked: async () => { throw new Error('Unexpected native publication read') },
    completeRunLocked: async () => { throw new Error('Run lifecycle belongs to the settlement fixture') },
  }) }
  return { fixture, version, run, host, request, executions }
}

function returnPreview(t: Awaited<ReturnType<typeof acceptedReview>>, output: WorkHandoffResult) {
  assert.equal(output.routing.kind, 'return')
  if (output.routing.kind !== 'return') throw new Error('Return fixture required')
  const returnId = repeatId('work-return', 'review-execution')
  return { scope: t.fixture.scope, returnId, requestId: t.request.requestId,
    sourceActivationId: t.request.destinationActivationId, sourceExecutionId: 'review-execution',
    requesterActivationId: t.request.requesterActivationId,
    ...(output.routing.outcome === 'needs_changes'
      ? { continuationActivationId: repeatId('work-activation', returnId) } : {}),
    acceptedResultDigest: repeatDigest(t.executions[1]!.result), outcome: output.routing.outcome,
    latestDeliverable: output.data.latestDeliverable, remainingFindings: output.data.remainingFindings,
    returnedAt: t.fixture.createdAt }
}

const postgresDescribe = describe.skipIf(process.env.NIM2691_POSTGRES !== '1')
postgresDescribe('handoff delivery after terminal acceptance', () => {
  it.each([false, true])('preserves accepted review findings without a revision activation (restart=%s)', async (restart) => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const output: WorkHandoffResult = { routing: { kind: 'return', requestId: 'review-request', outcome: 'accepted' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'remaining-finding' }] } }
      const t = await acceptedReview(pool, output)
      let owner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
      assert.ok(owner)
      try {
        if (restart) {
          await owner.release()
          owner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
          assert.ok(owner)
        }
        const store = new RepeatRunRepository(owner, t.host, t.version)
        const returned = await store.returnWork('review-execution')
        expect(returned.value).toMatchObject({ requestId: 'review-request', outcome: 'accepted',
          latestDeliverable: output.data.latestDeliverable, remainingFindings: output.data.remainingFindings })
        expect(returned.value.continuationActivationId).toBeUndefined()
        expect((await store.returnWork('review-execution')).replayed).toBe(true)
        expect((await pool.query('select record from run_work_returns where run_id=$1', [t.run.id])).rows
          .map((row) => WorkReturnSchema.parse(row.record))).toEqual([returned.value])
        expect((await pool.query('select execution_id,result_digest from run_work_unresolved where run_id=$1',
          [t.run.id])).rows).toEqual([{ execution_id: 'review-execution',
          result_digest: repeatDigest(t.executions[1]!.result) }])
        expect((await pool.query('select activation_id from run_work_activations where run_id=$1', [t.run.id])).rowCount).toBe(2)
        expect((await pool.query('select used from run_work_connection_usage where run_id=$1', [t.run.id])).rows[0]?.used).toBe(1)
      } finally { await owner.release() }
    })
  }, 120000)
  it.each([false, true])('delivers a boundary-sized review return and last-handoff notice (restart=%s)', async (restart) => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const output: WorkHandoffResult = { routing: { kind: 'return', requestId: 'review-request', outcome: 'needs_changes' },
        data: { latestDeliverable: '', remainingFindings: [{ id: 'needs-revision' }] } }
      const t = await acceptedReview(pool, output, { reviewAccepted: false })
      const returned = returnPreview(t, output)
      const preview = createWorkLimitNotice({ scope: t.fixture.scope, version: t.version, now: t.fixture.createdAt }, {
        cause: { kind: 'last_return', returnId: returned.returnId },
        requesterActivationId: t.request.requesterActivationId, requesterNodeId: t.request.requesterNodeId,
        continuationActivationId: returned.continuationActivationId!, relationshipId: t.request.relationshipId,
        destinationNodeId: t.request.destinationNodeId, used: 1, maximum: 1,
        latestDeliverable: '', remainingFindings: output.data.remainingFindings,
      }, [])
      const metadataBytes = Buffer.byteLength(canonicalGraphJson({ ...preview,
        delivery: 'delivered', acknowledgementId: 'a'.repeat(200) }), 'utf8')
      output.data.latestDeliverable = 'x'.repeat(65536 - metadataBytes)
      const candidate = HarnessExecutionSchema.parse({ ...t.executions[1], result: { outcome: 'succeeded', output } })
      WorkHandoffResultSchema.parse(output)
      let owner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
      assert.ok(owner)
      try {
        await owner.oneShotConnection().transaction(async (sql) => {
          await assertWorkHandoffDeliveryLocked({ sql, scope: t.fixture.scope, version: t.version,
            now: t.fixture.createdAt }, candidate, t.request.destinationActivationId, output)
          await sql.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1',
            [candidate.id, text(candidate)])
          await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,$6)`, [candidate.id, t.run.id, t.request.destinationActivationId,
            text(candidate.result), repeatDigest(candidate.result), t.fixture.createdAt])
        })
        if (restart) {
          await owner.release()
          owner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
          assert.ok(owner)
        }
        const store = new RepeatRunRepository(owner, t.host, t.version)
        const delivered = await store.returnWork(candidate.id)
        expect(delivered.value.latestDeliverable).toEqual(output.data.latestDeliverable)
        const notices = (await pool.query('select record from run_work_notices where run_id=$1', [t.run.id])).rows
        expect(notices).toHaveLength(1)
        const notice = WorkNoticeSchema.parse(notices[0]!.record)
        expect(notice.latestDeliverable).toEqual(output.data.latestDeliverable)
        expect(notice.remainingFindings).toEqual(output.data.remainingFindings)
        expect(notice.cause).toEqual({ kind: 'last_return', returnId: delivered.value.returnId })
        expect((await store.returnWork(candidate.id)).replayed).toBe(true)
        expect((await pool.query('select record from run_work_notices where run_id=$1', [t.run.id])).rowCount).toBe(1)
        expect((await pool.query('select return_id from run_work_returns where run_id=$1', [t.run.id])).rowCount).toBe(1)
      } finally { await owner.release() }
    })
  }, 120000)

  it.each(['accepted', 'needs_changes'] as const)(
    'rejects a result whose derived %s envelope cannot be delivered before accepting it', async (outcome) => {
      await taskDatabase(async (pool) => {
        await applyApplicationMigrations(pool)
        const output: WorkHandoffResult = { routing: { kind: 'return', requestId: 'review-request', outcome },
          data: { latestDeliverable: 'x'.repeat(65000), remainingFindings: [] } }
        WorkHandoffResultSchema.parse(output)
        const t = await acceptedReview(pool, output, { reviewAccepted: false })
        const execution = t.executions[1]!
        expect(Buffer.byteLength(text(execution.result), 'utf8')).toBeLessThanOrEqual(65536)
        const owner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
        assert.ok(owner)
        try {
          await expect(owner.oneShotConnection().transaction(async (sql) => {
            await assertWorkHandoffDeliveryLocked({ sql, scope: t.fixture.scope, version: t.version,
              now: t.fixture.createdAt }, execution, t.request.destinationActivationId, output)
            await sql.query('update harness_executions set accepted=true where id=$1', [execution.id])
          })).rejects.toMatchObject({ code: 'WORK_HANDOFF_DELIVERY_TOO_LARGE' })
          expect((await pool.query('select accepted from harness_executions where id=$1', [execution.id])).rows[0]?.accepted)
            .toBe(false)
          expect((await pool.query('select 1 from run_work_results where execution_id=$1', [execution.id])).rowCount).toBe(0)
          expect((await pool.query('select 1 from run_work_returns where run_id=$1', [t.run.id])).rowCount).toBe(0)
          expect((await pool.query('select 1 from run_work_notices where run_id=$1', [t.run.id])).rowCount).toBe(0)
        } finally { await owner.release() }
      })
    }, 120000,
  )

})
