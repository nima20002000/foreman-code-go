import { afterEach, describe, expect, it } from 'vitest'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { readContext, transact, identity } from '../src/modules/interactions/wave25/context.js'
import { interactionFact, nextInteraction, writeInteraction } from '../src/modules/interactions/wave25/publication.js'
import { consumeApprovalGraphResume } from '../src/modules/interactions/wave25/resume.js'
import { recordReviewObservation, acknowledgementId } from '../src/modules/interactions/wave25/nativeEvidence.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import type { NativeGraphObservation } from '@graphql/contracts/wave25'
import type { NativeGraphProjectionGuard } from '../src/modules/run-graph/records.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'

type Fixture = Awaited<ReturnType<typeof approvalDatabase>>
const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })
async function setup() { const f = await approvalDatabase(); closes.push(f.close); return f }
const decision = (f: Fixture, optionId = 'approve-once') => f.repository.decide({ id: f.interaction.id, optionId,
  expectedRevision: f.interaction.revision, principal: f.principal,
  nativeResponse: { optionId, semantic: optionId === 'reject' ? 'reject' : 'approve_once' } })

async function nativeEvidence(f: Fixture, terminal = false) {
  const source = { sourceKind: 'native_event' as const, sourceId: terminal ? 'native-terminal' : 'native-ack', sourceRevision: '0' }
  const work = { execution: identity(f.reviewer), workKind: 'review' as const, workId: f.job.id }
  const observation: NativeGraphObservation = { scope: f.scope, work, source, sourceStreamId: 'native-review-stream',
    sourcePosition: terminal ? '2' : '1', connectionGeneration: '0', observedAt: new Date().toISOString(),
    ...(terminal ? { kind: 'terminal' as const, submissionId: 'provider-review-turn', terminal: {
      outcome: 'succeeded' as const, evidenceKind: 'provider_terminal' as const, evidenceId: 'provider-terminal-event', nativeSettled: true } }
      : { kind: 'submission' as const, submissionId: 'provider-review-turn', state: 'acknowledged' as const }) }
  const row = (await f.pool.query<{ fence: string }>('select lease_fence::text as fence from review_jobs where id=$1', [f.job.id])).rows[0]!
  const guard: NativeGraphProjectionGuard = { expected: { scope: f.scope, key: work, ownerId: 'review-owner-token', fence: row.fence, connectionGeneration: '0' },
    readCurrentLocked: async (sql) => {
      const actual = (await sql.query<{ token: string; fence: string; generation: string; held: boolean }>(
        `select j.lease_token as token,j.lease_fence::text as fence,l.record->>'connectionGeneration' as generation,
          j.lease_expires_at>clock_timestamp() as held from review_jobs j join native_session_lanes l
          on l.native_session_id=j.record->>'nativeSessionId' and l.harness=j.record->>'provider'
          where j.id=$1 for update of j,l`, [f.job.id])).rows[0]!
      return { scope: f.scope, key: work, ownerId: actual.token, fence: actual.fence, connectionGeneration: actual.generation,
        ownership: actual.held ? 'held' : 'lost', access: 'project' }
    } }
  // Test producer stands in only for the provider/A5 observation. It uses the
  // real frozen G1 publisher and a real locked database owner; no native work.
  await transact(f.pool, f.run.id, async (publication) => {
    await publication.source({ evidence: source,
      sourceDigest: graphSourceDigest(observation), facts: [{ type: 'node.activity', activity: terminal
        ? { workflowNodeId: f.reviewer.workflowNodeId, status: 'none' }
        : { workflowNodeId: f.reviewer.workflowNodeId, status: 'active', action: 'reviewing', execution: work.execution,
          correlationId: f.job.correlationId, acknowledgementId: acknowledgementId(observation), interactionId: f.interaction.id, reviewJobId: f.job.id } }] }, async () => undefined)
    await recordReviewObservation(publication, observation, guard)
  })
  return observation
}
async function settle(f: Fixture) {
  await nativeEvidence(f)
  await f.repository.coordination.transitionReviewJob(f.job.id, 'review-owner-token', 'acknowledged', {
    writerFence: { id: `lane-${f.reviewer.id}`, token: 'native-writer-token' }, providerTurnOrMessageId: 'provider-review-turn', releaseLease: false })
  await nativeEvidence(f, true)
  await f.repository.coordination.transitionReviewJob(f.job.id, 'review-owner-token', 'completed', {
    writerFence: { id: `lane-${f.reviewer.id}`, token: 'native-writer-token' } })
}

describe('A4 actual G1/PostgreSQL approval transactions', () => {
  it('concurrent exact decisions produce one effect, one mutation and one replay', async () => {
    const f = await setup(), before = (await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence
    const results = await Promise.all([decision(f), decision(f)])
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(results.filter((r) => r.replayed)).toHaveLength(1)
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(1)
    expect((await f.pool.query("select * from run_graph_effects where run_id=$1 and effect_kind='approval.decide'", [f.run.id])).rowCount).toBe(1)
    expect(BigInt((await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence)).toBe(BigInt(before) + 1n)
    expect((await f.pool.query("select * from management_audit where action='interaction_respond' and principal_id=$1", [f.principal.id])).rowCount).toBe(2)
  })
  it('concurrent conflicting decisions cannot both settle', async () => {
    const f = await setup(), results = await Promise.allSettled([decision(f), decision(f, 'reject')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(1)
  })
  it('revoked, read-only, wrong epoch and stale revisions are denied without mutation', async () => {
    const f = await setup()
    await expect(f.repository.decide({ id: f.interaction.id, optionId: 'approve-once', expectedRevision: 7,
      principal: f.principal, nativeResponse: { optionId: 'approve-once', semantic: 'approve_once' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await f.pool.query("update management_principals set grants=$2::jsonb where id=$1", [f.principal.id, JSON.stringify([{ actions: ['interactions:read'], scope: { workspaceIds: [f.run.workspaceId], workflowIds: [f.run.workflowId], runIds: [f.run.id] } }])])
    await expect(decision(f)).rejects.toBeDefined()
    await f.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.principal.id])
    await expect(decision(f)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect((await f.repository.get(f.interaction.id))?.status).toBe('pending')
  })
  it('a rollback removes both the domain write and the publication', async () => {
    const f = await setup(), before = (await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence
    await expect(transact(f.pool, f.run.id, async (publication) => {
      const next = nextInteraction(f.interaction, { graphInterruptId: 'fault-injected-interrupt' })
      const context = await readContext(publication.sql, f.interaction)
      await publication.source({ evidence: { sourceKind: 'interaction', sourceId: next.id, sourceRevision: String(next.revision) },
        sourceDigest: graphSourceDigest(next), facts: [interactionFact(context, next)] }, (sql) => writeInteraction(sql, f.interaction, next))
      throw new Error('rollback-fault')
    })).rejects.toThrow('rollback-fault')
    expect((await f.repository.get(f.interaction.id))?.graphInterruptId).toBeUndefined()
    expect((await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence).toBe(before)
  })
  it('raw v2 writers cannot commit without the same-transaction G1 receipt', async () => {
    const f = await setup()
    await expect(f.pool.query(`update durable_interactions set revision=revision+1,
      record=jsonb_set(record,'{revision}',to_jsonb(revision+1)) where id=$1`, [f.interaction.id])).rejects.toMatchObject({ code: 'PGA03' })
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(0)
  })
  it('decision, native review settlement, delivery and native resume remain separate', async () => {
    const f = await setup(); await decision(f)
    expect(await f.repository.delivery.claim(f.interaction.id, 'too-early')).toBeUndefined()
    await settle(f)
    await f.repository.bindGraphInterrupt(f.interaction.id, 'interrupt-approval')
    const claim = (await f.repository.delivery.claim(f.interaction.id, 'delivery-owner'))!
    let nativeWrites = 0
    const delivered = await f.repository.delivery.finish(claim, async () => { nativeWrites++; return { state: 'delivered', evidence: deliveryFixture().proof } })
    expect(delivered.deliveryState).toBe('delivered'); expect(nativeWrites).toBe(1)
    expect(await f.repository.delivery.claim(f.interaction.id, 'duplicate-wake')).toBeUndefined()
    const resume = (await f.repository.delivery.claimAtomicGraphResume(f.interaction.id, 'resume-owner'))!
    let checkpointConsumes = 0
    await f.pool.query('create table a4_checkpoint_consumptions(interaction_id text primary key)')
    const consume = () => transact(f.pool, f.run.id, (publication) => consumeApprovalGraphResume(publication, resume, async (sql, interaction) => {
      checkpointConsumes++; await sql.query('insert into a4_checkpoint_consumptions(interaction_id) values($1)', [interaction.id])
    }))
    await consume() // Crash simulation: do not call finishGraphResume.
    expect(await consume()).toEqual({ replayed: true }); expect(checkpointConsumes).toBe(1)
    expect(await f.repository.delivery.claimAtomicGraphResume(f.interaction.id, 'recovery-owner')).toBeUndefined()
    const outbox = (await f.pool.query('select state,approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [f.interaction.id])).rows[0]
    expect(outbox.state).toBe('resumed'); expect(outbox.approval_native_ack_id).toBeNull()
    // Checkpoint consumption is not a native continuation acknowledgement.
    expect((await f.pool.query("select payload from run_graph_batches where run_id=$1 and payload like '%worker.resumed%'", [f.run.id])).rowCount).toBe(0)
  })
  it('a missing receipt remains uncertain and reconnect only reconciles the same attempt', async () => {
    const f = await setup(); await decision(f); await settle(f)
    const first = (await f.repository.delivery.claim(f.interaction.id, 'delivery-owner'))!
    const result = await f.repository.delivery.finish(first, async () => ({ state: 'delivered' }))
    expect(result.deliveryState).toBe('uncertain')
    const again = (await f.repository.delivery.claim(f.interaction.id, 'reconnect-owner'))!
    expect(again.mode).toBe('reconcile'); expect(again.attempt).toBe(first.attempt)
    await expect(f.repository.delivery.finish(again, async () => ({ state: 'delivered', evidence: deliveryFixture().proof }))).rejects.toBeDefined()
    expect((await f.pool.query("select * from run_graph_effects where run_id=$1 and effect_kind='approval.deliver'", [f.run.id])).rowCount).toBe(1)
  })
  it('a changed generation fences old decisions and native delivery owners', async () => {
    const f = await setup()
    await f.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}','1'::jsonb) where owner_agent_id=$1", [f.reviewer.agentId])
    await expect(decision(f)).rejects.toBeDefined()
    expect((await f.repository.get(f.interaction.id))?.status).toBe('pending')
  })
  it('a real terminal review failure records Stop and cleanup without granting a Worker continuation', async () => {
    const f = await setup()
    const failed = await f.repository.coordination.transitionReviewJob(f.job.id, 'review-owner-token', 'failed', {
      error: { code: 'REVIEW_NO_DECISION', message: 'The native review ended without a decision.' },
      cleanup: { nativeState: 'pending', credentialState: 'pending', interruptState: 'not_sent' },
    })
    expect(failed.state).toBe('failed'); expect(failed.cleanup?.completedAt).toBeUndefined()
    expect((await f.pool.query('select stop_requested_at from runs where id=$1', [f.run.id])).rows[0].stop_requested_at).not.toBeNull()
    expect((await f.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows[0].pending).toBe(true)
    expect(await f.repository.delivery.claim(f.interaction.id, 'forbidden-after-failure')).toBeUndefined()
    await expect(decision(f)).rejects.toBeDefined()
  })
  it('unknown native terminal status never becomes a successful review', async () => {
    const f = await setup(); await decision(f)
    const next = await f.repository.coordination.transitionReviewJob(f.job.id, 'review-owner-token', 'completed', {
      writerFence: { id: `lane-${f.reviewer.id}`, token: 'native-writer-token' }, releaseLease: false })
    expect(next.state).toBe('uncertain'); expect(next.completedAt).toBeUndefined()
    expect(await f.repository.delivery.claim(f.interaction.id, 'not-settled')).toBeUndefined()
  })
  it('uncertain reviewer reclamation does not transfer an old credential to the new ownership epoch', async () => {
    const f = await setup()
    await f.pool.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id=$1", [f.job.id])
    const reclaimed = await f.repository.coordination.claimReviewJob(f.job.id, 'new-owner', 'new-token', new Date(Date.now()+60000).toISOString())
    expect(reclaimed.submittedAt).toBe(f.job.submittedAt)
    expect(reclaimed.state).toBe('submitted')
    await expect(f.access.authenticate(f.credential.environment.variables.GRAPHQL_APP_MCP_TOKEN, 'worker')).rejects.toBeDefined()
    await expect(decision(f)).rejects.toBeDefined()
  })
  it('a generation change rejects a native delivery claimant even if its lease token still matches', async () => {
    const f = await setup(); await decision(f); await settle(f)
    const claim = (await f.repository.delivery.claim(f.interaction.id, 'delivery-owner'))!
    await f.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}','1'::jsonb) where owner_agent_id=$1", [f.requester.agentId])
    let writes = 0
    await expect(f.repository.delivery.finish(claim, async () => { writes++; return { state: 'delivered', evidence: deliveryFixture().proof } })).rejects.toBeDefined()
    expect(writes).toBe(0)
  })

  it('a definite pre-write failure can retry without replaying a started native response', async () => {
    const f = await setup(); await decision(f); await settle(f)
    const first = (await f.repository.delivery.claim(f.interaction.id, 'attach-owner'))!
    const failed = await f.repository.delivery.finish(first, { state: 'failed', error: 'APPROVAL_NATIVE_QUALIFICATION_FAILED' })
    expect(failed.deliveryState).toBe('failed')
    const retry = (await f.repository.delivery.claim(f.interaction.id, 'qualified-owner'))!
    expect(retry.mode).toBe('submit')
    let writes = 0
    const delivered = await f.repository.delivery.finish(retry, async () => {
      writes++; return { state: 'delivered', evidence: deliveryFixture().proof }
    })
    expect(delivered.deliveryState).toBe('delivered'); expect(writes).toBe(1)
    expect((await f.pool.query("select * from run_graph_effects where run_id=$1 and effect_kind='approval.deliver'", [f.run.id])).rowCount).toBe(1)
  })

})
