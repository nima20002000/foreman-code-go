import { GraphAttentionSchema, type GraphActivity, type GraphAttention, type RunGraphScope } from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'

/** Indexed current domain aggregates, never completed interaction/review or raw activity history. */
export async function readCurrentNodeAttention(sql: GraphTransactionSql, scope: RunGraphScope,
  activities: ReadonlyMap<string, GraphActivity>): Promise<Map<string, GraphAttention>> {
  if (activities.size > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const ids = [...activities.keys()]
  const interactions = await sql.query<{ node_id: string; count: string }>(
    `select e.workflow_node_id as node_id,count(*)::text
     from durable_interactions i join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
     where i.run_id=$1 and i.status not in ('delivered','canceled') and e.workflow_node_id=any($2::text[])
     group by e.workflow_node_id`, [scope.runId, ids])
  const reviews = await sql.query<{ node_id: string; count: string; cleanup: boolean }>(
    `select e.workflow_node_id as node_id,count(*)::text,
       bool_or(j.record->'cleanup'->>'completedAt' is null and
         (j.record->'cleanup'->>'nativeState'='pending' or j.record->'cleanup'->>'credentialState'='pending')) as cleanup
     from harness_executions e join review_jobs j on j.execution_id=e.id
     where e.run_id=$1 and e.workflow_node_id=any($2::text[])
       and j.record->>'state'<>'completed'
       and (j.record->>'state'<>'failed' or j.record->'cleanup'->>'completedAt' is null)
     group by e.workflow_node_id`, [scope.runId, ids])
  const pending = new Map(interactions.rows.map((row) => [row.node_id, row.count]))
  const unsettled = new Map(reviews.rows.map((row) => [row.node_id, row]))
  const result = new Map<string, GraphAttention>()
  for (const [id, activity] of activities) {
    const count = pending.get(id) ?? '0', review = unsettled.get(id)
    if (BigInt(count) > 100000n || BigInt(review?.count ?? '0') > 100000n) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
    result.set(id, GraphAttentionSchema.parse({ workflowNodeId: id, pendingInteractionCount: Number(count),
      unsettledReviewCount: Number(review?.count ?? '0'), cleanupPending: review?.cleanup === true,
      telemetry: activity.status === 'stale' ? 'stale' : activity.status === 'unknown' ? 'unknown' : 'current' }))
  }
  return result
}
