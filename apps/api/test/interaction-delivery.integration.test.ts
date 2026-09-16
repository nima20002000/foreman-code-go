import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES } from '@graphql/contracts'
import pg from 'pg'
import { afterEach, beforeEach, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { PostgresInteractionRecoveryRepository } from '../src/modules/interactions/recovery.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
let admin: pg.Pool
let pool: pg.Pool
let schema: string
let repository: PostgresInteractionRepository
let budgets: PostgresApprovalBudgetRepository

beforeEach(async () => {
  schema = `delivery_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
  await applyApplicationMigrations(pool)
  repository = new PostgresInteractionRepository(pool)
  budgets = new PostgresApprovalBudgetRepository(pool)
})

afterEach(async () => {
  await pool?.end()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.end()
})

async function decision() {
  const interaction = DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES.codex, id: randomUUID(), approval: { handler: 'user' } })
  // Lifecycle auditing requires the real relational owners of the interaction.
  await pool.query("insert into workspaces (id,record) values ($1,'{}') on conflict do nothing", [interaction.workspaceId])
  await pool.query("insert into workflows (id,workspace_id,record) values ($1,$2,'{}') on conflict do nothing", [interaction.workflowId, interaction.workspaceId])
  await pool.query("insert into workflow_versions (id,workspace_id,workflow_id,version,entry_node_id,record) values ('delivery-version',$1,$2,1,'delivery-node','{}') on conflict do nothing", [interaction.workspaceId, interaction.workflowId])
  await pool.query("insert into runs (id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values ($1,$2,$3,'delivery-version','waiting','{}') on conflict do nothing", [interaction.runId, interaction.workspaceId, interaction.workflowId])
  await pool.query("insert into agents (id,workspace_id,record) values ($1,$2,'{}') on conflict do nothing", [interaction.requestingAgentId, interaction.workspaceId])
  await pool.query("insert into harness_executions (id,run_id,workflow_node_id,agent_id,attempt,record) values ($1,$2,'delivery-node',$3,1,'{\"state\":\"waiting\"}') on conflict do nothing", [interaction.executionId, interaction.runId, interaction.requestingAgentId])
  await repository.create(interaction)
  await budgets.ensure(interaction.executionId, interaction.graphThreadId, 60_000)
  await budgets.beginWait(interaction.executionId)
  const option = interaction.responseOptions[0]!
  const decided = await repository.decide({ id: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
    nativeResponse: { optionId: option.optionId, semantic: option.semantic } })
  return decided.interaction
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

it('shares exclusive delivery ownership with the persistence recovery API', async () => {
  const interaction = await decision()
  const recovery = new PostgresInteractionRecoveryRepository(pool)
  const legacy = await recovery.claimDelivery(interaction.id, interaction.revision, 'legacy', 60_000)
  assert.equal(await repository.delivery.claim(interaction.id, 'new-dispatcher'), undefined)
  await recovery.releaseDelivery(interaction.id, legacy.lease)
  const modern = (await repository.delivery.claim(interaction.id, 'new-dispatcher'))!
  const current = (await repository.get(interaction.id))!
  await assert.rejects(recovery.claimDelivery(current.id, current.revision, 'legacy', 60_000), { code: 'DELIVERY_NOT_CLAIMABLE' })
  await pool.query("update durable_interactions set delivery_lease_expires_at=now()-interval '1 second' where id=$1", [interaction.id])
  await recovery.claimDelivery(current.id, current.revision, 'replacement', 60_000)
  let writes = 0
  await assert.rejects(repository.delivery.finish(modern, async () => { writes++; return { state: 'delivered' } }), { code: 'DELIVERY_OWNER_LOST' })
  assert.equal(writes, 0)
})

it('recovers an expired graph resume claimed by the persistence recovery API', async () => {
  const interaction = await decision()
  await repository.bindGraphInterrupt(interaction.id, 'shared-interrupt')
  const claim = (await repository.delivery.claim(interaction.id, 'deliver'))!
  await repository.delivery.finish(claim, async () => ({ state: 'delivered' }))
  const recovery = new PostgresInteractionRecoveryRepository(pool)
  const intent = (await recovery.getGraphResume(interaction.id))!
  const legacy = await recovery.claimGraphResume(interaction.id, intent.revision, 'legacy', 60_000)
  assert.equal(await repository.delivery.claimGraphResume(interaction.id, 'modern'), undefined)
  await pool.query("update interaction_graph_resumes set lease_expires_at=now()-interval '1 second' where interaction_id=$1", [interaction.id])
  assert.ok((await repository.delivery.recoveryCandidates({ limit: 10 })).some((item) => item.id === interaction.id))
  const modern = (await repository.delivery.claimGraphResume(interaction.id, 'modern'))!
  await assert.rejects(recovery.renewGraphResume(interaction.id, legacy.lease!, 60_000), { code: 'GRAPH_RESUME_LEASE_LOST' })
  await repository.delivery.finishGraphResume(modern)
  assert.equal((await recovery.getGraphResume(interaction.id))?.state, 'resumed')
})

it('gives only one of two repositories the durable native submission claim (#11)', async () => {
  const interaction = await decision()
  const other = new PostgresInteractionRepository(pool)
  const claims = await Promise.all([
    repository.delivery.claim(interaction.id, randomUUID()), other.delivery.claim(interaction.id, randomUUID()),
  ])
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal((await pool.query('select * from interaction_delivery_attempts')).rowCount, 1)
  assert.equal(await other.delivery.claim(interaction.id, randomUUID(), true), undefined)
})

it('merges a graph binding revision and atomically persists delivered attempt + resume intent (#7/#8)', async () => {
  const interaction = await decision()
  const claim = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await repository.bindGraphInterrupt(interaction.id, 'bound-after-claim')
  const delivered = await repository.delivery.finish(claim, async () => ({ state: 'delivered' }))
  assert.equal(delivered.graphInterruptId, 'bound-after-claim')
  assert.equal(delivered.deliveryState, 'delivered')
  const row = (await pool.query(`select a.state as delivery,g.state as resume from interaction_delivery_attempts a
    join interaction_graph_resumes g using (interaction_id) where a.interaction_id=$1`, [interaction.id])).rows[0]
  assert.deepEqual(row, { delivery: 'delivered', resume: 'pending' })
  const resume = (await repository.delivery.claimGraphResume(interaction.id, randomUUID()))!
  assert.equal(resume.interaction.graphInterruptId, 'bound-after-claim')
  await repository.delivery.finishGraphResume(resume, 'checkpoint unavailable')
  assert.equal((await repository.get(interaction.id))?.deliveryState, 'delivered')
  assert.equal((await pool.query('select state from interaction_graph_resumes')).rows[0].state, 'pending')
})

it('leaves early delivery recoverable until its interrupt is bound (#8)', async () => {
  const interaction = await decision()
  const claim = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await repository.delivery.finish(claim, async () => ({ state: 'delivered' }))
  assert.equal(await repository.delivery.claimGraphResume(interaction.id, randomUUID()), undefined)
  assert.equal((await repository.delivery.recoveryCandidates({ limit: 10 }))[0]?.id, interaction.id)
  await repository.bindGraphInterrupt(interaction.id, 'late-interrupt')
  assert.equal((await repository.delivery.claimGraphResume(interaction.id, randomUUID()))?.interaction.graphInterruptId, 'late-interrupt')
})

it('never sends from an expired owner and reconciles the same attempt instead (#10/#11)', async () => {
  const interaction = await decision()
  const first = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await pool.query("update interaction_delivery_attempts set lease_expires_at=now()-interval '1 second'")
  await pool.query("update durable_interactions set delivery_lease_expires_at=now()-interval '1 second'")
  const recovered = (await repository.delivery.claim(interaction.id, randomUUID()))!
  assert.equal(recovered.mode, 'reconcile')
  assert.equal(recovered.attempt, first.attempt)
  assert.equal(recovered.correlationId, first.correlationId)
  let sends = 0
  await assert.rejects(repository.delivery.finish(first, async () => { sends++; return { state: 'delivered' } }))
  assert.equal(sends, 0)
  await repository.delivery.finish(recovered, { state: 'uncertain' })
  assert.equal((await pool.query('select state from interaction_delivery_attempts')).rows[0].state, 'uncertain')
})

it('Stop committed during attachment prevents the final native write (#12)', async () => {
  const interaction = await decision()
  const claim = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await budgets.stop(interaction.executionId)
  let sends = 0
  await assert.rejects(repository.delivery.finish(claim, async () => { sends++; return { state: 'delivered' } }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EXECUTION_STOPPED')
  await repository.cancelPendingForRun(interaction.runId)
  assert.equal(sends, 0)
  assert.equal((await repository.get(interaction.id))?.status, 'canceled')
  assert.equal(await repository.delivery.claim(interaction.id, randomUUID()), undefined)
})

it('Stop cannot complete before an already-started guarded native write finishes (#12)', async () => {
  const interaction = await decision()
  const claim = (await repository.delivery.claim(interaction.id, randomUUID()))!
  const entered = deferred()
  const release = deferred()
  const writing = repository.delivery.finish(claim, async () => {
    entered.resolve()
    await release.promise
    return { state: 'delivered' }
  })
  await entered.promise
  let stopped = false
  const stopping = budgets.stop(interaction.executionId).then(() => { stopped = true })
  // The final assertion is the SQL ordering; this pause only lets Stop reach its blocked UPDATE.
  try {
    await new Promise((done) => setTimeout(done, 25))
    assert.equal(stopped, false)
  } finally { release.resolve() }
  await Promise.all([writing, stopping])
  assert.equal(stopped, true)
  assert.equal((await repository.get(interaction.id))?.deliveryState, 'delivered')
})

it('rolls back all delivery bookkeeping on an outbox failure, then recovers without resending (#7)', async () => {
  const interaction = await decision()
  const claim = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await pool.query(`create function reject_resume_intent() returns trigger language plpgsql as $$
    begin raise exception 'injected outbox failure'; end; $$;
    create trigger reject_resume_intent before insert on interaction_graph_resumes
    for each row execute function reject_resume_intent();`)
  let sends = 0
  await assert.rejects(repository.delivery.finish(claim, async () => { sends++; return { state: 'delivered' } }), /outbox failure/)
  assert.equal((await repository.get(interaction.id))?.deliveryState, 'submitted')
  assert.equal((await pool.query('select state from interaction_delivery_attempts')).rows[0].state, 'submitted')
  assert.equal((await pool.query('select * from interaction_graph_resumes')).rowCount, 0)
  await pool.query(`drop trigger reject_resume_intent on interaction_graph_resumes;
    update interaction_delivery_attempts set lease_expires_at=now()-interval '1 second';
    update durable_interactions set delivery_lease_expires_at=now()-interval '1 second';`)
  const recovered = (await repository.delivery.claim(interaction.id, randomUUID()))!
  assert.equal(recovered.mode, 'reconcile')
  await repository.delivery.finish(recovered, { state: 'delivered', evidence: {
    source: 'provider_history', harness: interaction.harness, providerVersion: interaction.providerVersion,
    nativeSessionId: interaction.nativeSessionId, nativeRequestId: interaction.nativeRequestId,
    nativeRequestType: interaction.nativeRequestType, optionId: interaction.selectedOptionId!, semantic: interaction.selectedSemantic!,
  } })
  assert.equal(sends, 1)
  assert.equal((await pool.query('select state from interaction_graph_resumes')).rows[0].state, 'pending')
})

it('recovers the pre-fix split-write window without demoting a delivered attempt (#7)', async () => {
  const interaction = await decision()
  const claim = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await pool.query("update interaction_delivery_attempts set state='delivered',lease_expires_at=null")
  await pool.query("update durable_interactions set delivery_lease_expires_at=null,delivery_token=null,delivery_owner=null")
  assert.equal(await repository.delivery.claim(interaction.id, randomUUID()), undefined)
  assert.equal((await repository.get(interaction.id))?.deliveryState, 'delivered')
  assert.equal((await pool.query('select attempt,state from interaction_delivery_attempts')).rows[0].attempt, claim.attempt)
  assert.equal((await pool.query('select state from interaction_graph_resumes')).rows[0].state, 'pending')
})


it('requires exact response evidence at the durable reconciliation boundary (#10)', async () => {
  const interaction = await decision()
  const claim = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await repository.delivery.finish(claim, async () => ({ state: 'uncertain' }))
  const recovered = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await assert.rejects(repository.delivery.finish(recovered, { state: 'delivered' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'DELIVERY_EVIDENCE_REQUIRED')
  assert.equal((await repository.get(interaction.id))?.deliveryState, 'uncertain')
  assert.equal((await pool.query('select state from interaction_delivery_attempts')).rows[0].state, 'uncertain')
  assert.equal((await pool.query('select * from interaction_graph_resumes')).rowCount, 0)
})

it('renews only the live graph handoff owner and cannot acknowledge an expired owner (#7)', async () => {
  const interaction = await decision()
  const claim = (await repository.delivery.claim(interaction.id, randomUUID()))!
  await repository.bindGraphInterrupt(interaction.id, 'durable-interrupt')
  await repository.delivery.finish(claim, async () => ({ state: 'delivered' }))
  const resume = (await repository.delivery.claimGraphResume(interaction.id, randomUUID()))!
  await repository.delivery.renewGraphResume(resume)
  assert.equal(await repository.delivery.claimGraphResume(interaction.id, randomUUID()), undefined)
  await pool.query("update interaction_graph_resumes set lease_expires_at=now()-interval '1 second'")
  await assert.rejects(repository.delivery.renewGraphResume(resume))
  await assert.rejects(repository.delivery.finishGraphResume(resume))
  const replacement = (await repository.delivery.claimGraphResume(interaction.id, randomUUID()))!
  await assert.rejects(repository.delivery.finishGraphResume(resume))
  await repository.delivery.finishGraphResume(replacement)
  assert.equal((await pool.query('select state from interaction_graph_resumes')).rows[0].state, 'resumed')
})
