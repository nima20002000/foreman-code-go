import { approvalAttentionFacts } from './attention.js'
import { DurableInteractionSchema, type DurableInteraction, type ReviewJob } from '@graphql/contracts'
import {
  GraphInteractionSchema, GraphReviewSchema, type GraphEffect, type GraphEvidence, type GraphFact,
} from '@graphql/contracts/wave25'
import { graphSourceDigest, type RunGraphPublication, type GraphEffectGuard } from '../../run-graph/publication.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { identity, fail, type ApprovalContext } from './context.js'

export function interactionFact(context: ApprovalContext, interaction: DurableInteraction,
  resumeState: 'not_started' | 'pending' | 'unknown' = interaction.deliveryState === 'delivered' ? 'pending' : 'not_started'): GraphFact {
  return { type: 'interaction.state', interaction: GraphInteractionSchema.parse({
    interactionId: interaction.id, revision: String(interaction.revision), requester: identity(context.requester),
    ...(context.reviewer ? { reviewer: identity(context.reviewer), approvalRelationshipId: context.relationshipId } : {}),
    handler: interaction.approval.handler, status: interaction.status, deliveryState: interaction.deliveryState, resumeState,
    ...(interaction.selectedOptionId ? { selectedOptionId: interaction.selectedOptionId, decision: interaction.selectedSemantic } : {}),
  }) }
}
export function reviewFact(context: ApprovalContext, job: ReviewJob, revision: string, acknowledgementId?: string): GraphFact {
  if (!context.reviewer || !context.relationshipId) return fail('APPROVAL_DIRECT_CONNECTION_REQUIRED')
  return { type: 'review.state', review: GraphReviewSchema.parse({
    reviewJobId: job.id, interactionId: job.interactionId, relationshipId: context.relationshipId,
    requester: identity(context.requester), reviewer: identity(context.reviewer), revision, leaseAttempt: job.attempt, state: job.state,
    nativeCleanup: job.cleanup?.nativeState ?? (job.state === 'completed' ? 'terminal' : job.submittedAt ? 'pending' : 'not_started'),
    // A successful job uses a Run-lifetime reviewer credential, not a per-job token.
    credentialCleanup: job.cleanup?.credentialState ?? 'not_required',
    ...(acknowledgementId ? { acknowledgementId } : {}),
  }) }
}
export function nextInteraction(previous: DurableInteraction, fields: Partial<DurableInteraction>): DurableInteraction {
  if (!Number.isSafeInteger(previous.revision + 1)) return fail('APPROVAL_REVISION_EXHAUSTED')
  return DurableInteractionSchema.parse(JSON.parse(JSON.stringify({ ...previous, ...fields, revision: previous.revision + 1, updatedAt: new Date().toISOString() })))
}
export function decisionDigest(interaction: DurableInteraction, optionId = interaction.selectedOptionId): string {
  const option = interaction.responseOptions.find((item) => item.optionId === optionId)
  if (!option) return fail('INTERACTION_OPTION_INVALID')
  return graphSourceDigest({ interactionId: interaction.id, executionId: interaction.executionId,
    harness: interaction.harness, providerVersion: interaction.providerVersion, nativeSessionId: interaction.nativeSessionId,
    nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType,
    optionId: option.optionId, semantic: option.semantic })
}
export async function writeInteraction(sql: GraphTransactionSql, previous: DurableInteraction, next: DurableInteraction): Promise<void> {
  const result = await sql.query(`update durable_interactions set status=$2,revision=$3,record=$4::jsonb,updated_at=clock_timestamp()
    where id=$1 and revision=$5`, [next.id, next.status, next.revision, JSON.stringify(next), previous.revision])
  if (result.rowCount !== 1) return fail('REVISION_CONFLICT')
}
export async function publishInteraction(publication: RunGraphPublication, context: ApprovalContext,
  previous: DurableInteraction, next: DurableInteraction, options: {
    resumeState?: 'not_started' | 'pending' | 'unknown'; effect?: GraphEffect; guard?: GraphEffectGuard; mutate?: (sql: GraphTransactionSql) => Promise<void>
  } = {}): Promise<void> {
  const source = { evidence: { sourceKind: 'interaction' as const, sourceId: next.id, sourceRevision: String(next.revision) },
    sourceDigest: graphSourceDigest(next), facts: [interactionFact(context, next, options.resumeState), ...await approvalAttentionFacts(publication.sql, context, { interaction: next })] }
  const write = async (sql: GraphTransactionSql) => { await writeInteraction(sql, previous, next); await options.mutate?.(sql) }
  if (options.effect) {
    if (!options.guard) return fail('GRAPH_AUTHORITY_INVALID')
    await publication.effect({ ...source, effect: options.effect }, options.guard, write)
  } else await publication.source(source, write)
}
export function sourceForReview(job: ReviewJob, revision: string, nativeEvidence?: GraphEvidence): GraphEvidence {
  // A4's derived review transition has its own source identity. The actual native
  // observation remains A5-owned and is included in the source digest by the caller.
  return { sourceKind: nativeEvidence ? 'native_event' : job.cleanup ? 'cleanup' : 'review', sourceId: job.id, sourceRevision: revision }
}
