import { approvalAttentionFacts } from './attention.js'
import { DurableInteractionSchema, type DurableInteraction } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { canonicalGraphJson, type GraphEffect } from '@graphql/contracts/wave25'
import type { GraphSqlClient } from '../../run-graph/connection.js'
import { beforeGraphCommit } from '../../run-graph/connection.js'
import { graphSourceDigest } from '../../run-graph/publication.js'
import type pg from 'pg'
import { assertBudget, fail, lockInteraction, readContext, transact } from './context.js'
import { lockPrincipal } from './principal.js'
import { decisionDigest, interactionFact, nextInteraction, publishInteraction } from './publication.js'

function requestIdentity(interaction: DurableInteraction): unknown {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt,
    graphInterruptId: _interrupt, ...immutable } = interaction
  void _id; void _revision; void _createdAt; void _updatedAt; void _interrupt
  return immutable
}
export async function createRequest(pool: pg.Pool, input: DurableInteraction) {
  const accepted = DurableInteractionSchema.parse(JSON.parse(JSON.stringify(input)))
  if (accepted.status !== 'pending' || accepted.revision !== 0) return fail('APPROVAL_REQUEST_INVALID')
  return transact(pool, accepted.runId, async (publication) => {
    const sql = publication.sql
    const found = (await sql.query<{ record: unknown }>(`select record from durable_interactions
      where harness=$1 and native_session_id=$2 and native_request_id=$3`,
    [accepted.harness, accepted.nativeSessionId, accepted.nativeRequestId])).rows[0]
    if (found) {
      const existing = DurableInteractionSchema.parse(found.record)
      // Compare immutable request fields even after the winning decision/delivery.
      const original = { ...existing, status: 'pending' as const, deliveryState: 'not_started' as const,
        selectedOptionId: undefined, selectedSemantic: undefined, nativeResponse: undefined,
        decidedAt: undefined, deliveredAt: undefined, auditReference: undefined }
      const strip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown
      if (canonicalGraphJson(strip(requestIdentity(original))) !== canonicalGraphJson(requestIdentity(accepted))) return fail('INTERACTION_IDENTITY_CONFLICT')
      return { interaction: existing, created: false }
    }
    const context = await readContext(sql, accepted, true)
    await assertBudget(sql, accepted)
    await publication.source({ evidence: { sourceKind: 'interaction', sourceId: accepted.id, sourceRevision: '0' },
      // The shared overlay owns activity as well as attention. An unconditional
      // wait can disagree with the snapshot (no native candidate, or an already
      // selected sibling request) without producing a correcting projection delta.
      sourceDigest: graphSourceDigest(accepted), facts: [interactionFact(context, accepted),
        ...await approvalAttentionFacts(sql, context, { interaction: accepted })] }, async (transaction) => {
      await transaction.query(`insert into durable_interactions
        (id,workspace_id,workflow_id,run_id,execution_id,requesting_agent_id,harness,native_session_id,native_request_id,status,revision,record,
         approval_relationship_id,approval_reviewer_execution_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
      [accepted.id, accepted.workspaceId, accepted.workflowId, accepted.runId, accepted.executionId, accepted.requestingAgentId,
        accepted.harness, accepted.nativeSessionId, accepted.nativeRequestId, accepted.status, accepted.revision, JSON.stringify(accepted),
        context.relationshipId ?? null, context.reviewer?.id ?? null])
      await transaction.query(`update approval_execution_state set active_elapsed_ms=active_elapsed_ms+
          coalesce(extract(epoch from(clock_timestamp()-active_started_at))*1000,0)::bigint,
        active_started_at=null,approval_wait_started_at=coalesce(approval_wait_started_at,clock_timestamp()),revision=revision+1
        where execution_id=$1 and stopped_at is null`, [accepted.executionId])
    })
    return { interaction: accepted, created: true }
  })
}

async function audit(sql: GraphSqlClient, principal: ManagementPrincipal, interaction: DurableInteraction, replayed: boolean): Promise<void> {
  await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
    values($1,$2,'interaction_respond',$3,'succeeded',$4::jsonb)`, [principal.id, principal.audience === 'worker' ? 'mcp' : 'http',
    `interaction:${interaction.id}`, JSON.stringify({ replayed, optionId: interaction.selectedOptionId })])
}
export async function decide(pool: pg.Pool, runId: string, input: {
  id: string; optionId: string; expectedRevision: number; principal: ManagementPrincipal; nativeResponse: unknown
}) {
  return transact(pool, runId, async (publication) => {
    const sql = publication.sql
    // Parent/executions precede principals and the interaction. Read, authorize,
    // then lock/re-read; a request identity never changes under the parent lock.
    const initial = (await sql.query<{ record: unknown }>('select record from durable_interactions where id=$1', [input.id])).rows[0]
    const view = DurableInteractionSchema.parse(initial?.record)
    const replay = view.status !== 'pending' && view.status !== 'canceled' && view.selectedOptionId === input.optionId
    const context = await readContext(sql, view, true, replay)
    const principal = await lockPrincipal(sql, input.principal, view, context, replay)
    const current = await lockInteraction(sql, input.id)
    if (current.status === 'canceled') return fail('INTERACTION_CANCELED')
    const option = current.responseOptions.find((item) => item.optionId === input.optionId)
    if (!option) return fail('INTERACTION_OPTION_INVALID')
    const response = { optionId: option.optionId, semantic: option.semantic }
    if (canonicalGraphJson(input.nativeResponse) !== canonicalGraphJson(response)) return fail('INTERACTION_RESPONSE_CONFLICT')
    beforeGraphCommit(sql, async () => {
      const alive = await sql.query('select 1 from management_principals where id=$1 and revoked_at is null and expires_at>clock_timestamp()', [principal.id])
      if (alive.rowCount !== 1) return fail('AUTH_REVOKED')
    })
    if (current.status !== 'pending') {
      if (current.selectedOptionId !== option.optionId || current.selectedSemantic !== option.semantic
        || canonicalGraphJson(current.nativeResponse) !== canonicalGraphJson(response)) return fail('INTERACTION_ALREADY_DECIDED')
      await audit(sql, principal, current, true)
      return { interaction: current, replayed: true }
    }
    if (current.revision !== input.expectedRevision) return fail('REVISION_CONFLICT')
    await assertBudget(sql, current)
    const next = nextInteraction(current, { status: 'delivery_pending', deliveryState: 'pending', selectedOptionId: option.optionId,
      selectedSemantic: option.semantic, nativeResponse: response, auditReference: principal.id, decidedAt: new Date().toISOString() })
    const effect: GraphEffect = { identity: { kind: 'approval.decide', entityId: current.id }, digest: decisionDigest(current, option.optionId) }
    const expected = { scope: context.scope, effect: effect.identity, effectDigest: effect.digest,
      ownerId: principal.id, fence: String(current.revision), connectionGeneration: null }
    await publishInteraction(publication, context, current, next, { effect, guard: { expected,
      readCurrentLocked: async (transaction) => {
        const actual = await lockInteraction(transaction, current.id)
        const actualContext = await readContext(transaction, actual, true)
        const live = await lockPrincipal(transaction, principal, actual, actualContext)
        return { scope: actualContext.scope, effect: { kind: 'approval.decide', entityId: actual.id },
          effectDigest: decisionDigest(actual, option.optionId), ownerId: live.id, fence: String(actual.revision),
          connectionGeneration: null, ownership: 'held', access: 'effect', security: 'valid',
          effectClosed: actual.status !== 'pending', submission: 'not_submitted' }
      } }, mutate: async (transaction) => audit(transaction, principal, next, false) })
    return { interaction: next, replayed: false }
  })
}
