import type { HarnessExecution } from '@graphql/contracts'
import { GraphExecutionIdentitySchema, NodeResolutionSchema, RUN_GRAPH_LIMITS, canonicalGraphJson, type GraphFact, type RunGraphCurrentState, type RunGraphScope } from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { assertGraphTransaction } from './connection.js'
import { readCurrentNativeActivities, selectCurrentNodeActivity } from './currentActivity.js'
import type { CurrentNativeActivity } from './nativeActivitySelection.js'
import { publicNodeAttention, readPublicAttentionCounts, type PublicAttentionOverlay } from './currentAttention.js'
import { publicNodeState, publicReviewUnsettled, type PublicExecution } from './publicLifecycle.js'
import { RunGraphError } from './errors.js'

type PublicNode = RunGraphCurrentState['nodes'][number]
export interface PublicProjectionOverlay extends PublicAttentionOverlay {
  executions?: readonly HarnessExecution[]
  /** Guard-qualified proposed candidates from BR1-002, not transport observations. */
  native?: readonly CurrentNativeActivity[]
  closed?: boolean
  /** Proposed Run cleanup intent, not native/resource closure evidence. */
  cleanupPending?: boolean
}

/** One authoritative bounded node projection for both compact snapshots and
 * lifecycle publication. It reads current records only, never event history.
 * Overlays let a producer compute its post-mutation facts without writing before
 * its source/effect guards. No native writes, lease acquisition or external I/O occurs. */
export async function readPublicNodeProjection(sql: GraphTransactionSql, scope: RunGraphScope,
  nodeIds: readonly string[], overlay: PublicProjectionOverlay = {}): Promise<PublicNode[]> {
  assertGraphTransaction(sql)
  if (nodeIds.length > 1000 || new Set(nodeIds).size !== nodeIds.length) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const row = (await sql.query<{ closed: boolean; cleanup_pending: boolean }>(`select r.stop_requested_at is not null
    or r.execution_state in ('completed','interrupted') as closed,
    exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
    from runs r where r.id=$1`, [scope.runId])).rows[0]
  if (!row) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  // Cleanup closes positive work authority even before business settlement. A
  // canceled approval must not uncover an earlier native start as continuation.
  const closed = (overlay.closed ?? row.closed) || (overlay.cleanupPending ?? row.cleanup_pending)
  // Select bounded scalar facts, never result/output/input payloads or native history.
  const stored = await sql.query<{ id: string; workflow_node_id: string; agent_id: string;
    configuration_id: string; attempt: number; state: string; outcome: string | null }>(
    `select distinct on (e.workflow_node_id) e.id,e.workflow_node_id,e.record->>'agentId' as agent_id,
       e.record->>'agentConfigurationVersionId' as configuration_id,e.attempt,
       e.record->>'state' as state,e.record->'result'->>'outcome' as outcome
     from harness_executions e join run_repeat_executions x on x.execution_id=e.id and x.run_id=e.run_id
     left join run_repeat_occurrences o on o.occurrence_id=x.occurrence_id and o.run_id=e.run_id
     where e.run_id=$1 and e.workflow_node_id=any($2::text[])
     order by e.workflow_node_id,coalesce(o.occurrence_index,0) desc,x.technical_attempt desc limit 1001`, [scope.runId, [...nodeIds]])
  if (stored.rows.length > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const executions = new Map<string, PublicExecution>()
  const put = (current: PublicExecution, replace = false) => {
    const identity = GraphExecutionIdentitySchema.parse(current.execution), id = identity.workflowNodeId
    if (!nodeIds.includes(id) || (!replace && executions.has(id))) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    if (replace && executions.has(id) && canonicalGraphJson(executions.get(id)!.execution) !== canonicalGraphJson(identity)) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    executions.set(id, { ...current, execution: identity })
  }
  for (const item of stored.rows) put({ state: item.state, outcome: item.outcome, execution: {
    workflowNodeId: item.workflow_node_id, executionId: item.id, agentId: item.agent_id,
    agentConfigurationVersionId: item.configuration_id, attempt: item.attempt } })
  for (const execution of overlay.executions ?? []) {
    if (execution.runId !== scope.runId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    put({ state: execution.state, outcome: execution.result?.outcome ?? null, execution: {
      workflowNodeId: execution.workflowNodeId, executionId: execution.id, agentId: execution.agentId,
      agentConfigurationVersionId: execution.agentConfigurationVersionId!, attempt: execution.attempt } }, true)
  }
  const resolutionRows = await sql.query<{ record: { value: NonNullable<PublicNode['resolution']> } }>(
    `select d.record from run_repeat_resolutions d where d.run_id=$1 and d.workflow_node_id=any($2::text[])
      and (d.execution_id=any($3::text[]) or d.execution_id is null and d.occurrence_key='')
      order by d.workflow_node_id,(d.occurrence_key='') desc limit 2001`,
    [scope.runId, [...nodeIds], [...executions.values()].map((item) => item.execution.executionId)])
  if (resolutionRows.rows.length > 2000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const resolutions = new Map<string, NonNullable<PublicNode['resolution']>>()
  for (const row of resolutionRows.rows) {
    const value = NodeResolutionSchema.parse(row.record.value)
    if (!resolutions.has(value.workflowNodeId)) resolutions.set(value.workflowNodeId, value)
  }
  // Domain closure suppresses stale retained native rows without treating a
  // projection clear as proof that the native process or credentials are closed.
  let native: readonly CurrentNativeActivity[] = closed ? [] : overlay.native
    ?? await readCurrentNativeActivities(sql, scope, nodeIds, true)
  if (native.length > RUN_GRAPH_LIMITS.nodes + RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const reviewIds = native.filter((item) => item.key.workKind === 'review').map((item) => item.key.workId)
  if (reviewIds.length) {
    const currentReviews = await sql.query<{ id: string }>(`select j.id from review_jobs j
      join harness_executions e on e.id=j.execution_id where e.run_id=$1 and j.id=any($2::text[])
      and j.state<>'completed' and j.record->'cleanup'->>'completedAt' is null`, [scope.runId, reviewIds])
    const active = new Set(currentReviews.rows.map((item) => item.id))
    if (overlay.review) {
      if (publicReviewUnsettled(overlay.review.record)) active.add(overlay.review.record.id)
      else active.delete(overlay.review.record.id)
    }
    native = native.filter((item) => item.key.workKind === 'workflow' || active.has(item.key.workId))
  }
  native = native.filter((item) => item.key.workKind === 'review'
    || executions.get(item.key.execution.workflowNodeId)?.execution.executionId === item.key.execution.executionId)
  const counts = await readPublicAttentionCounts(sql, scope.runId, nodeIds, overlay)
  return nodeIds.map((id) => {
    const execution = executions.get(id), resolution = resolutions.get(id), count = counts.get(id)!
    if (resolution?.execution && (!execution || canonicalGraphJson(resolution.execution) !== canonicalGraphJson(execution.execution))) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    const activity = selectCurrentNodeActivity(id, native, { closed, workflowClosed: execution?.state === 'completed',
      ...(count.pendingInteractionId ? { pendingInteractionId: count.pendingInteractionId } : {}), deliveryBlocked: count.deliveryBlocked })
    // An outstanding approval may not reuse old native work as continuation proof.
    const state = publicNodeState(id, execution, resolution, native, closed, count.pendingInteractionCount > 0)
    return { state, activity, attention: publicNodeAttention(id, activity, count),
      ...(resolution ? { resolution } : {}),
      ...(resolution?.acceptedResultDigest ? { acceptedResultDigest: resolution.acceptedResultDigest } : {}) }
  })
}

export function publicNodeProjectionFacts(nodes: readonly PublicNode[]): GraphFact[] {
  return nodes.flatMap((node): GraphFact[] => [{ type: 'node.state', state: node.state },
    { type: 'node.activity', activity: node.activity }, { type: 'node.attention', attention: node.attention }])
}
/** Native ingestion/refresh must compare before/after so a keepalive, repeated
 * observation or lease-only change cannot allocate a graph-visible cursor. */
export function publicNodeProjectionDelta(before: readonly PublicNode[], after: readonly PublicNode[]): GraphFact[] {
  const prior = new Map(publicNodeProjectionFacts(before).map((fact) => [factKey(fact), canonicalGraphJson(fact)]))
  return publicNodeProjectionFacts(after).filter((fact) => prior.get(factKey(fact)) !== canonicalGraphJson(fact))
}
function factKey(fact: GraphFact): string {
  if (fact.type === 'node.state') return `${fact.type}:${fact.state.workflowNodeId}`
  if (fact.type === 'node.activity') return `${fact.type}:${fact.activity.workflowNodeId}`
  if (fact.type === 'node.attention') return `${fact.type}:${fact.attention.workflowNodeId}`
  throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
}

/** Run-domain Stop/completion/interruption projection. Native row clear/closure
 * remains BR1-002's fenced boundary; this never claims native cleanup succeeded. */
export function publicRunClosedFacts(sql: GraphTransactionSql, scope: RunGraphScope): Promise<GraphFact[]> {
  return publicRunBoundaryFacts(sql, scope, { closed: true })
}

/** Publish the entire node delta with the proposed Run boundary, before its SQL
 * mutation. Clearing cleanup is not a native acknowledgement: the unchanged
 * publication schema still rejects any attempt to restore active native work
 * from a cleanup source. Stop/terminal closure survives a cleared cleanup flag. */
export async function publicRunBoundaryFacts(sql: GraphTransactionSql, scope: RunGraphScope,
  overlay: Pick<PublicProjectionOverlay, 'closed' | 'cleanupPending'>): Promise<GraphFact[]> {
  const ids = (await sql.query<{ id: string }>(`select n.node->>'id' as id from workflow_versions v
    cross join lateral jsonb_array_elements(v.record->'definition'->'nodes') n(node)
    where v.id=$1 order by n.node->>'id' limit 1001`, [scope.workflowVersionId])).rows.map((row) => row.id)
  const before = await readPublicNodeProjection(sql, scope, ids)
  const after = await readPublicNodeProjection(sql, scope, ids, overlay)
  return publicNodeProjectionDelta(before, after)
}
