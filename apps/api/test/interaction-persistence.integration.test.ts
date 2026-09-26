import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { DurableInteractionSchema, ReviewJobSchema, type DurableInteraction } from '@graphql/contracts'
import pg from 'pg'
import { afterEach, beforeEach, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { PostgresInteractionRecoveryRepository } from '../src/modules/interactions/recovery.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
let admin: pg.Pool
let pool: pg.Pool
let schema: string
let repository: PostgresInteractionRepository
let recovery: PostgresInteractionRecoveryRepository

function interaction(id = 'interaction-1'): DurableInteraction {
  return DurableInteractionSchema.parse({
    id, revision: 0, workspaceId: 'workspace-1', workflowId: 'workflow-1', runId: 'run-1',
    executionId: 'execution-1', requestingAgentId: 'agent-1', harness: 'codex', providerVersion: '0.154.0',
    nativeSessionId: 'native-session-1', nativeRequestId: `native-request-${id}`, nativeRequestType: 'approval',
    graphThreadId: 'thread-1', graphInterruptId: `interrupt-${id}`, request: {}, approval: { handler: 'user' },
    responseOptions: [{ optionId: `option-${id}`, semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
  })
}
function decide(current: DurableInteraction) {
  return repository.decide({ id: current.id, optionId: current.responseOptions[0]!.optionId,
    expectedRevision: current.revision, nativeResponse: { optionId: current.responseOptions[0]!.optionId } })
}

beforeEach(async () => {
  schema = `persistence_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  // Minimal relational owners; these tests exercise the persistence boundary,
  // not executable workflow admission or the native harness.
  await pool.query(`
    insert into workspaces (id,record) values ('workspace-1','{}');
    insert into workflows (id,workspace_id,record) values ('workflow-1','workspace-1','{}');
    insert into workflow_versions (id,workspace_id,workflow_id,version,entry_node_id,record)
      values ('version-1','workspace-1','workflow-1',1,'node-1','{}');
    insert into runs (id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values ('run-1','workspace-1','workflow-1','version-1','waiting','{}');
    insert into agents (id,workspace_id,record) values ('agent-1','workspace-1','{}'),('reviewer-1','workspace-1','{}');
    insert into harness_executions (id,run_id,workflow_node_id,agent_id,attempt,record)
      values ('execution-1','run-1','node-1','agent-1',1,'{}'),('review-execution-1','run-1','node-2','reviewer-1',1,'{}');
  `)
  repository = new PostgresInteractionRepository(pool)
  recovery = new PostgresInteractionRecoveryRepository(pool)
})

afterEach(async () => {
  await pool?.end()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.end()
})

async function submittedDelivery() {
  const created = (await repository.create(interaction())).interaction
  const decided = (await decide(created)).interaction
  const claimed = await recovery.claimDelivery(decided.id, decided.revision, 'worker-1', 60_000)
  const submitted = await repository.updateDelivery(claimed.interaction.id, claimed.interaction.revision, 'submitted', { lease: claimed.lease })
  const attempt = await repository.beginDeliveryAttempt(submitted, 'correlation-1', claimed.lease)
  return { submitted, attempt, lease: claimed.lease }
}

it('serializes delivery claims and rejects expired, superseded, and unfenced writers', async () => {
  const created = (await repository.create(interaction())).interaction
  const decided = (await decide(created)).interaction
  const claims = await Promise.allSettled([
    recovery.claimDelivery(decided.id, decided.revision, 'worker-1', 60_000),
    recovery.claimDelivery(decided.id, decided.revision, 'worker-2', 60_000),
  ])
  assert.equal(claims.filter((item) => item.status === 'fulfilled').length, 1)
  const winner = claims.find((item) => item.status === 'fulfilled')!
  assert.equal(winner.status, 'fulfilled')
  if (winner.status !== 'fulfilled') throw new Error('missing claim')
  const submitted = await repository.updateDelivery(decided.id, winner.value.interaction.revision, 'submitted', { lease: winner.value.lease })
  await pool.query("update durable_interactions set delivery_lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [decided.id])
  const replacement = await recovery.claimDelivery(decided.id, submitted.revision, 'recovery-worker', 60_000)
  assert.equal(replacement.requiresReconciliation, true)
  await assert.rejects(repository.updateDelivery(decided.id, replacement.interaction.revision, 'delivered', { lease: winner.value.lease }), { code: 'DELIVERY_LEASE_LOST' })
  await assert.rejects(repository.updateDelivery(decided.id, replacement.interaction.revision, 'delivered'), { code: 'DELIVERY_LEASE_LOST' })
  assert.equal((await repository.get(decided.id))!.deliveryState, 'submitted')
})

it('does not open a second attempt while the previous delivery needs reconciliation', async () => {
  const { submitted, lease } = await submittedDelivery()
  await assert.rejects(repository.beginDeliveryAttempt(submitted, 'different-correlation', lease), { code: 'DELIVERY_ATTEMPT_ACTIVE' })
  assert.equal((await pool.query('select * from interaction_delivery_attempts')).rowCount, 1)
})

it('keeps uncertain delivery evidence and settles attempt, audit, and graph intent atomically', async () => {
  const { submitted, attempt, lease } = await submittedDelivery()
  const error = { code: 'TRANSPORT_LOST', message: 'response write outcome is unknown', phase: 'deliver' as const, certainty: 'uncertain' as const }
  const uncertain = await repository.settleDeliveryAttempt({ interactionId: submitted.id, expectedRevision: submitted.revision, attempt, state: 'uncertain', lease, error })
  const observed = await repository.recordReconciliation(uncertain.id, uncertain.revision, {
    nativeSessionId: uncertain.nativeSessionId, nativeRequestId: uncertain.nativeRequestId, attempt, correlationId: 'correlation-1',
    outcome: 'unknown', source: 'native_history', details: { pendingListWasEmpty: true },
  }, lease)
  assert.equal(observed.deliveryState, 'uncertain', 'absence from a pending list is not delivery proof')
  assert.equal(await recovery.getGraphResume(observed.id), undefined)
  await assert.rejects(repository.recordReconciliation(observed.id, observed.revision, {
    nativeSessionId: 'wrong-session', nativeRequestId: observed.nativeRequestId, outcome: 'delivered', source: 'native_response', details: {},
  }, lease), { code: 'INTERACTION_IDENTITY_CONFLICT' })
  // This is explicit test evidence, not an inference from pending-list absence.
  const proven = await repository.recordReconciliation(observed.id, observed.revision, {
    nativeSessionId: observed.nativeSessionId, nativeRequestId: observed.nativeRequestId, outcome: 'delivered',
    attempt, correlationId: 'correlation-1', source: 'native_response', details: { exactResponseAcknowledged: true },
  }, lease)
  const delivered = await repository.settleDeliveryAttempt({ interactionId: proven.id, expectedRevision: proven.revision, attempt, state: 'delivered', lease })
  const intent = await recovery.getGraphResume(delivered.id)
  assert.ok(intent)
  assert.equal(intent.state, 'pending')
  assert.equal(intent.graphThreadId, delivered.graphThreadId)
  assert.equal(intent.graphInterruptId, delivered.graphInterruptId)
  const stored = await pool.query('select last_delivery_error from durable_interactions where id=$1', [delivered.id])
  assert.deepEqual(stored.rows[0]!.last_delivery_error, error)
  const evidence = await pool.query('select outcome from interaction_reconciliation_evidence order by sequence')
  assert.deepEqual(evidence.rows.map((row) => row.outcome), ['unknown', 'delivered'])
  const attemptRow = await pool.query('select state,error from interaction_delivery_attempts')
  assert.deepEqual(attemptRow.rows[0], { state: 'delivered', error: error.message })
  const activity = await pool.query("select kind,payload from run_activity where kind='interaction_resolved'")
  assert.equal(activity.rowCount, 1)
  assert.equal(activity.rows[0]!.payload.nativeRequestId, delivered.nativeRequestId)
})

it('fences graph resume ownership and refuses another interrupt identity', async () => {
  const { submitted, attempt, lease } = await submittedDelivery()
  const delivered = await repository.settleDeliveryAttempt({ interactionId: submitted.id, expectedRevision: submitted.revision, attempt, state: 'delivered', lease })
  const intent = (await recovery.getGraphResume(delivered.id))!
  const claim = await recovery.claimGraphResume(delivered.id, intent.revision, 'graph-worker', 60_000)
  await assert.rejects(recovery.claimGraphResume(delivered.id, claim.revision, 'other-worker', 60_000))
  await assert.rejects(recovery.finishGraphResume(delivered.id, claim.revision, claim.lease!, {
    state: 'resumed', graphThreadId: delivered.graphThreadId, graphInterruptId: 'another-interrupt', evidence: {},
  }), { code: 'GRAPH_RESUME_IDENTITY_CONFLICT' })
  const completed = await recovery.finishGraphResume(delivered.id, claim.revision, claim.lease!, {
    state: 'resumed', graphThreadId: delivered.graphThreadId, graphInterruptId: delivered.graphInterruptId!, evidence: { checkpointId: 'checkpoint-1' },
  })
  assert.equal(completed.state, 'resumed')
  assert.equal(completed.lease, null)
  assert.equal((await recovery.listGraphResumeRecovery(10)).length, 0)
})

it('Stop invalidates delivery and graph leases without erasing confirmed native delivery', async () => {
  const { submitted, attempt, lease } = await submittedDelivery()
  const delivered = await repository.settleDeliveryAttempt({ interactionId: submitted.id, expectedRevision: submitted.revision, attempt, state: 'delivered', lease })
  const intent = (await recovery.getGraphResume(delivered.id))!
  const claim = await recovery.claimGraphResume(delivered.id, intent.revision, 'graph-worker', 60_000)
  await repository.cancelPendingForRun('run-1')
  const canceled = (await repository.get(delivered.id))!
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.deliveryState, 'delivered')
  assert.equal((await recovery.getGraphResume(delivered.id))!.state, 'canceled')
  await assert.rejects(recovery.finishGraphResume(delivered.id, claim.revision, claim.lease!, {
    state: 'resumed', graphThreadId: delivered.graphThreadId, graphInterruptId: delivered.graphInterruptId!, evidence: {},
  }))
})

it('persists native envelopes once and rolls native insertion back if its activity fails', async () => {
  const event = { executionId: 'execution-1', sequence: 0, type: 'approval.request', occurredAt: '2026-09-16T00:00:00.000Z', payload: { nativeRequestId: 'exact-request' } }
  await appendNativeEvent(pool, event)
  await appendNativeEvent(pool, event)
  assert.equal((await pool.query('select * from harness_native_events')).rowCount, 1)
  assert.equal((await pool.query("select * from run_activity where kind='harness_output'")).rowCount, 1)
  await assert.rejects(appendNativeEvent(pool, { ...event, payload: { nativeRequestId: 'wrong-request' } }), { code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  await pool.query("alter table run_activity add constraint injected_activity_failure check (kind <> 'harness_output') not valid")
  await assert.rejects(appendNativeEvent(pool, { ...event, sequence: 1 }))
  assert.equal((await pool.query('select * from harness_native_events where sequence=1')).rowCount, 0)
})

it('recovers reviewer ownership without replaying or replacing submission identities and audits the transitions', async () => {
  const current = (await repository.create(interaction())).interaction
  const coordination = new PostgresInteractionCoordinationRepository(pool)
  const now = new Date().toISOString()
  let job = (await coordination.ensureReviewJob(ReviewJobSchema.parse({
    id: 'review-1', interactionId: current.id, reviewerAgentId: 'reviewer-1', attempt: 0, state: 'pending',
    provider: 'codex', nativeSessionId: 'review-native-session', correlationId: 'review-correlation-1', createdAt: now, updatedAt: now,
  }), { executionId: 'review-execution-1', workingDirectory: '/accepted/path with spaces', providerVersion: '0.154.0' })).job
  job = await coordination.claimReviewJob(job.id, 'worker-1', 'review-token-1', new Date(Date.now() + 60_000).toISOString())
  job = await coordination.transitionReviewJob(job.id, 'review-token-1', 'submitted', { providerTurnOrMessageId: 'provider-turn-1' })
  await pool.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($2::text)) where id=$1", [job.id, '2000-01-01T00:00:00.000Z'])
  await assert.rejects(coordination.transitionReviewJob(job.id, 'review-token-1', 'completed'), { code: 'REVIEW_JOB_LEASE_LOST' })
  const available = (await recovery.listReviewRecovery('reviewer-1', 10))[0]!
  const claim = await recovery.claimReviewRecovery(job.id, available.revision, 'recovery-worker', 60_000)
  assert.equal(claim.job.state, 'submitted')
  assert.equal(claim.job.attempt, job.attempt)
  assert.equal(claim.job.nativeSessionId, job.nativeSessionId)
  assert.equal(claim.job.correlationId, job.correlationId)
  assert.equal(claim.job.providerTurnOrMessageId, job.providerTurnOrMessageId)
  await assert.rejects(coordination.transitionReviewJob(job.id, 'review-token-1', 'completed'), { code: 'REVIEW_JOB_LEASE_LOST' })
  await recovery.recordReviewRecovery(job.id, claim.revision, claim.lease, {
    nativeSessionId: job.nativeSessionId, correlationId: job.correlationId, providerTurnOrMessageId: job.providerTurnOrMessageId!, details: { observed: 'still_running' },
  })
  await coordination.appendReviewNativeEvent(claim.job, { sequence: 0, type: 'review.started', occurredAt: now, payload: { turnId: 'provider-turn-1' } })
  assert.equal((await pool.query("select * from harness_native_events where execution_id='review-execution-1'")).rowCount, 1)
  const activity = await pool.query("select payload from run_activity where kind='review_job_state' order by sequence")
  assert.ok(activity.rowCount! >= 5)
  assert.equal(activity.rows.at(-1)!.payload.correlationId, job.correlationId)
})

it('applies the additive migration once and preserves the original HAP versions', async () => {
  await applyApplicationMigrations(pool)
  const applied = await pool.query('select version from application_migrations order by version')
  assert.deepEqual(applied.rows.map((row) => row.version), [1, 2, 3, 4, 100, 400, 401, 500, 501, 502, 503, 507, 508, 509, 700, 701, 800, 1701, 1702, 170017, 170018, 170019, 170020, 170021, 170022, 170023, 170024, 170025, 170026, 250001, 250002, 250003, 250005, 264201, 264401])
})
