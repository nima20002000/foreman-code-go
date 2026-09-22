import type { DurableInteraction, ReviewJob } from '@graphql/contracts'
import { WorkflowRunV2Schema, type GraphFact } from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { fail, type ApprovalContext } from './context.js'

/** Counts are domain facts, not transport liveness. Overlay the proposed single
 * mutation while the Run lock is held, so counts and the entity commit together. */
export async function approvalAttentionFacts(sql: GraphTransactionSql, context: ApprovalContext,
  next: { interaction?: DurableInteraction; review?: ReviewJob }): Promise<GraphFact[]> {
  const interactionId = next.interaction?.id ?? null, reviewId = next.review?.id ?? null
  const pending = next.interaction?.status === 'pending' ? 1 : 0
  const unsettled = next.review && next.review.state !== 'completed'
    && !(next.review.state === 'failed' && next.review.cleanup?.completedAt) ? 1 : 0
  const cleanup = next.review?.state === 'failed' && !next.review.cleanup?.completedAt ? 1 : 0
  const counts = async (executionId: string | null) => {
    const row = (await sql.query<{ pending: string; unsettled: string; cleanup: boolean }>(`select
      (select count(*) from durable_interactions i where i.run_id=$1 and i.status='pending'
        and ($2::text is null or i.id<>$2) and ($4::text is null or i.execution_id=$4))::text as pending,
      (select count(*) from review_jobs j join durable_interactions i on i.id=j.interaction_id
        where i.run_id=$1 and ($3::text is null or j.id<>$3)
          and ($4::text is null or i.execution_id=$4 or j.execution_id=$4)
          and j.state<>'completed' and (j.state<>'failed' or j.record->'cleanup'->>'completedAt' is null))::text as unsettled,
      exists(select 1 from review_jobs j join durable_interactions i on i.id=j.interaction_id
        where i.run_id=$1 and ($3::text is null or j.id<>$3)
          and ($4::text is null or i.execution_id=$4 or j.execution_id=$4)
          and j.state='failed' and j.record->'cleanup'->>'completedAt' is null) as cleanup`,
    [context.scope.runId, interactionId, reviewId, executionId])).rows[0]!
    const requester = executionId === null || executionId === context.requester.id
    return { pendingInteractionCount: Number(row.pending) + (requester ? pending : 0),
      unsettledReviewCount: Number(row.unsettled) + unsettled, cleanupPending: row.cleanup || !!cleanup }
  }
  const runRow = (await sql.query<{ record: unknown; execution_state: string; stopped: boolean; cleanup: boolean }>(`select record,execution_state,
    stop_requested_at is not null as stopped,exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup
    from runs r where id=$1`, [context.scope.runId])).rows[0]!
  const run = WorkflowRunV2Schema.parse(runRow.record), total = await counts(null)
  if (run.executionState !== runRow.execution_state) return fail('APPROVAL_RUN_STATE_MISMATCH')
  const facts: GraphFact[] = [{ type: 'run.state', state: { executionState: run.executionState, outcome: run.outcome,
    stopRequested: runRow.stopped, ...total, cleanupPending: total.cleanupPending || runRow.cleanup } }]
  for (const execution of [context.requester, ...(context.reviewer ? [context.reviewer] : [])]) {
    const saved = (await sql.query<{ status: string }>(`select activity->>'status' as status from run_native_activity
      where run_id=$1 and execution_id=$2 order by last_native_sequence desc nulls last,projection_revision desc limit 1`, [context.scope.runId, execution.id])).rows[0]
    const telemetry = saved?.status === 'stale' ? 'stale' : ['active','none'].includes(saved?.status ?? '') ? 'current' : 'unknown'
    facts.push({ type: 'node.attention', attention: { workflowNodeId: execution.workflowNodeId, ...await counts(execution.id), telemetry } })
  }
  return facts
}
