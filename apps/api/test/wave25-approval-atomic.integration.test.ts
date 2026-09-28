import { br1002Ack, br1002Batches } from './helpers/wave25Br1002Cuts.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { deliverApproval } from '../src/modules/interactions/wave25/service.js'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { readContext, transact } from '../src/modules/interactions/wave25/context.js'
import { interactionFact, nextInteraction, writeInteraction } from '../src/modules/interactions/wave25/publication.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'

type Fixture = Awaited<ReturnType<typeof approvalDatabase>>
const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })
async function setup() { const f = await approvalDatabase(); closes.push(f.close); return f }
const decision = (f: Fixture, optionId = f.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId) => f.repository.decide({ id: f.interaction.id, optionId,
  expectedRevision: f.interaction.revision, principal: f.principal,
  nativeResponse: { optionId, semantic: f.interaction.responseOptions.find((option) => option.optionId === optionId)!.semantic } })

describe.skipIf(!postgresEnabled)('A4 actual G1/PostgreSQL approval transactions', { timeout: 60000 }, () => {
  it('concurrent exact decisions produce one effect, one mutation and one replay', async () => {
    const f = await setup(), before = (await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence
    const results = await Promise.all([decision(f), decision(f)])
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(results.filter((r) => r.replayed)).toHaveLength(1)
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(f.interaction.revision + 1)
    expect((await f.pool.query("select * from run_graph_effects where run_id=$1 and effect_kind='approval.decide'", [f.run.id])).rowCount).toBe(1)
    expect(BigInt((await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence)).toBe(BigInt(before) + 1n)
    expect((await f.pool.query("select * from management_audit where action='interaction_respond' and principal_id=$1", [f.principal.id])).rowCount).toBe(2)
  })
  it('concurrent conflicting decisions cannot both settle', async () => {
    const f = await setup(), results = await Promise.allSettled([decision(f), decision(f, f.interaction.responseOptions.find((option) => option.semantic === 'reject')!.optionId)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(f.interaction.revision + 1)
  })
  it('revoked, read-only and stale revisions are denied without mutation', async () => {
    const f = await setup()
    await expect(f.repository.decide({ id: f.interaction.id, optionId: f.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId, expectedRevision: 7,
      principal: f.principal, nativeResponse: { optionId: f.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId, semantic: 'approve_once' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
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
    expect((await f.repository.get(f.interaction.id))?.graphInterruptId).toBe(f.interaction.graphInterruptId)
    expect((await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence).toBe(before)
  })
  it('raw writers cannot commit without the same-transaction G1 receipt', async () => {
    const f = await setup()
    await expect(f.pool.query(`update durable_interactions set revision=revision+1,
      record=jsonb_set(record,'{revision}',to_jsonb(revision+1)) where id=$1`, [f.interaction.id])).rejects.toMatchObject({ code: 'PGA03' })
    await expect(f.pool.query('update durable_interactions set revision=revision+1 where id=$1',
      [f.interaction.id])).rejects.toMatchObject({ code: 'PGA03' })
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(f.interaction.revision)
  })
  it('decision, native review settlement, delivery and continuation remain separate', async () => {
    const f = await setup()
    const { compare } = await graphParity(f.pool, f.scope)
    await compare(); await decision(f)
    expect(await f.repository.delivery.claim(f.interaction.id, 'too-early')).toBeUndefined()
    expect(f.counts().responses).toBe(0)
    await f.settle(); await compare()
    const delivered = await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, f.interaction.id)
    expect(delivered.deliveryState).toBe('delivered')
    expect(f.counts().responses).toBe(1)
    expect(delivered).toMatchObject({ nativeRequestId: f.interaction.nativeRequestId,
      nativeSessionId: f.interaction.nativeSessionId, request: f.interaction.request })
    expect(await f.receipts()).toHaveLength(0)
    expect((await br1002Ack(f, f.interaction.id))?.approval_native_ack_id ?? null).toBeNull()
    await f.engine.resumeInteraction(delivered)
    expect((await f.runs.get(f.run.id))?.outcome).toBe('succeeded')
    expect(await f.repository.delivery.claim(f.interaction.id, 'duplicate')).toBeUndefined()
    expect(await f.receipts()).toHaveLength(1)
    expect((await br1002Ack(f, f.interaction.id))?.approval_native_ack_id).toMatch(/^native-approval-ack-/)
    expect((await br1002Batches(f)).flatMap((batch) => batch.facts).filter((fact) => fact.type === 'worker.resumed')).toHaveLength(1)
    await compare()
  })

  it('missing native receipt stays uncertain and retains the same reconciliation attempt', async () => {
    const f = await setup()
    await decision(f); await f.settle()
    const first = (await f.repository.delivery.claim(f.interaction.id, 'missing-receipt'))!
    const uncertain = await f.repository.delivery.finish(first, async () => ({ state: 'delivered' }))
    expect(uncertain.deliveryState).toBe('uncertain')
    const retry = (await f.repository.delivery.claim(f.interaction.id, 'reconcile-receipt'))!
    expect(retry).toMatchObject({ mode: 'reconcile', attempt: first.attempt, correlationId: first.correlationId })
    expect(f.counts().responses).toBe(0)
    expect(await f.receipts()).toHaveLength(0)
  })

  it('a changed requester generation fences a delivery owner before native writes', async () => {
    const f = await setup()
    await decision(f); await f.settle()
    const claim = (await f.repository.delivery.claim(f.interaction.id, 'old-generation'))!
    await f.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}',to_jsonb((record->>'connectionGeneration')::integer+1)) where owner_agent_id=$1", [f.requester.agentId])
    let writes = 0
    await expect(f.repository.delivery.finish(claim, async () => { writes++; return { state: 'delivered' } })).rejects.toBeDefined()
    expect(writes).toBe(0)
    expect(f.counts().responses).toBe(0)
  })

  it('Stop blocks decisions and records cleanup without Worker continuation', async () => {
    const f = await setup()
    await f.stop()
    await expect(decision(f)).rejects.toBeDefined()
    expect(await f.repository.delivery.claim(f.interaction.id, 'after-stop')).toBeUndefined()
    expect((await f.pool.query('select stop_requested_at from runs where id=$1', [f.run.id])).rows[0].stop_requested_at).not.toBeNull()
    expect((await f.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows[0].pending).toBe(true)
    expect(f.counts().responses).toBe(0)
  })

  it('changed native generation fences the acknowledged reviewer credential', async () => {
    const f = await setup()
    await f.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}',to_jsonb((record->>'connectionGeneration')::integer+1)) where owner_agent_id=$1", [f.reviewer.agentId])
    await expect(decision(f)).rejects.toBeDefined()
    expect((await f.repository.get(f.interaction.id))?.status).toBe('pending')
  })

  it('expired review ownership cannot decide under its previously issued credential', async () => {
    const f = await setup()
    await f.pool.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)),lease_expires_at='2000-01-01' where id=$1", [f.job.id])
    await expect(decision(f)).rejects.toBeDefined()
    expect(f.counts().responses).toBe(0)
  })
})
