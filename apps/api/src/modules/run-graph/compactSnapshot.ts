import {
  GraphExecutionIdentitySchema, GraphNodeStateSchema, RunGraphTopologySchema, RunGraphCurrentStateSchema,
  RUN_GRAPH_LIMITS, type RunGraphScope, type RunGraphCurrentState, type RunGraphTopology,
  type GraphExecutionIdentity,
} from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { assertGraphTransaction } from './connection.js'
import { RunGraphError } from './errors.js'
import { readInputBindings, readNodeResolutions } from './records.js'
import { readCurrentNativeActivities, selectCurrentNodeActivity } from './currentActivity.js'
import { readCurrentNodeAttention } from './currentAttention.js'
import type { ReadCurrentRunGraph } from './reader.js'
import { z } from 'zod'

export type CurrentExchanges = Pick<RunGraphCurrentState, 'interactions' | 'reviews'>
/** Agent 4 supplies current domain records through the SAME SQL transaction.
 * No permissive empty default: absent producer coverage is not an empty inbox.
 * Completed history belongs on detail paths. Retirements must be published by its producer.
 */
export type ReadCurrentGraphExchanges = (sql: GraphTransactionSql, scope: RunGraphScope) => Promise<CurrentExchanges>
const ExchangesSchema = z.object({
  interactions: RunGraphCurrentStateSchema.shape.interactions,
  reviews: RunGraphCurrentStateSchema.shape.reviews,
}).strict()
export interface CompactExecution {
  execution: GraphExecutionIdentity
  state: string
}

/** Shared current-state mapping for the execution producer's fixture/qualification pass. */
export function compactNodeState(workflowNodeId: string, current: CompactExecution | undefined,
  resolution: RunGraphCurrentState['nodes'][number]['resolution']) {
  if (resolution) {
    const lifecycle = resolution.resolution === 'excluded' ? 'not_activated' : resolution.resolution
    return GraphNodeStateSchema.parse({ workflowNodeId, lifecycle,
      ...(resolution.execution ? { execution: resolution.execution } : {}) })
  }
  if (!current) return GraphNodeStateSchema.parse({ workflowNodeId, lifecycle: 'not_activated' })
  // Persisted execution lifecycle remains independent from current activity.
  // Agent 3 must qualify every v2 writer: a running row requires native evidence.
  // Missing accepted-result resolution never becomes success from an empty stream.
  const lifecycle = ['queued', 'starting', 'running', 'waiting'].includes(current.state) ? current.state : 'unknown'
  return GraphNodeStateSchema.parse({ workflowNodeId, execution: current.execution, lifecycle })
}

export function createCompactSnapshotAssembler(readExchanges: ReadCurrentGraphExchanges): ReadCurrentRunGraph {
  if (typeof readExchanges !== 'function') throw new RunGraphError('GRAPH_NOT_INITIALIZED')
  return async (sql, scope) => {
    assertGraphTransaction(sql)
    if (scope.executionSemanticsVersion !== 2) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    const head = (await sql.query<{
      entry_node_id: string; execution_state: RunGraphCurrentState['run']['executionState'];
      outcome: RunGraphCurrentState['run']['outcome']; stopped: boolean; cleanup_pending: boolean
    }>(
      `select v.record->>'entryNodeId' as entry_node_id,r.execution_state,r.record->>'outcome' as outcome,
        r.stop_requested_at is not null as stopped,
        exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
       from runs r join workflow_versions v on v.id=r.workflow_version_id
         and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
       where r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3 and v.id=$4 and v.execution_semantics_version=$5`,
      [scope.runId, scope.workspaceId, scope.workflowId, scope.workflowVersionId, scope.executionSemanticsVersion])).rows[0]
    if (!head) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    const topology = await readPinnedTopology(sql, scope, head.entry_node_id)
    const executionRows = await sql.query<{
      id: string; workflow_node_id: string; agent_id: string; configuration_id: string; attempt: number; state: string
    }>(
      `select e.id,e.workflow_node_id,e.record->>'agentId' as agent_id,
        e.record->>'agentConfigurationVersionId' as configuration_id,e.attempt,e.record->>'state' as state
       from harness_executions e where e.run_id=$1 order by e.workflow_node_id,e.id limit $2`,
      [scope.runId, RUN_GRAPH_LIMITS.nodes + 1])
    if (executionRows.rows.length > RUN_GRAPH_LIMITS.nodes) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
    const executions = new Map<string, CompactExecution>()
    for (const row of executionRows.rows) {
      if (executions.has(row.workflow_node_id) || row.attempt !== 1) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      executions.set(row.workflow_node_id, { state: row.state, execution: GraphExecutionIdentitySchema.parse({
        workflowNodeId: row.workflow_node_id, executionId: row.id, agentId: row.agent_id,
        agentConfigurationVersionId: row.configuration_id, attempt: row.attempt,
      }) })
    }
    // Sequential queries deliberately retain the G1 exclusive transaction object.
    const resolutions = await readNodeResolutions(sql, scope)
    const inputBindings = await readInputBindings(sql, scope)
    const native = head.stopped || ['completed', 'interrupted'].includes(head.execution_state)
      ? [] : await readCurrentNativeActivities(sql, scope)
    const nativeByNode = new Map<string, typeof native>()
    for (const candidate of native) {
      const id = candidate.key.execution.workflowNodeId, values = nativeByNode.get(id) ?? []
      values.push(candidate); nativeByNode.set(id, values)
    }
    const exchanges = ExchangesSchema.parse(await readExchanges(sql, scope))
    const resolutionByNode = new Map(resolutions.map((resolution) => [resolution.workflowNodeId, resolution]))
    const pendingByNode = new Map<string, CurrentExchanges['interactions']>()
    const reviewsByNode = new Map<string, CurrentExchanges['reviews']>()
    for (const interaction of exchanges.interactions) {
      if (['delivered', 'canceled'].includes(interaction.status) && interaction.resumeState !== 'pending') continue
      const key = interaction.requester.workflowNodeId
      const values = pendingByNode.get(key) ?? []; values.push(interaction); pendingByNode.set(key, values)
    }
    for (const review of exchanges.reviews) {
      if (review.state === 'completed' || (review.state === 'failed' && review.nativeCleanup !== 'pending' && review.credentialCleanup !== 'pending')) continue
      const key = review.reviewer.workflowNodeId
      const values = reviewsByNode.get(key) ?? []; values.push(review); reviewsByNode.set(key, values)
    }
    const closed = head.stopped || ['completed', 'interrupted'].includes(head.execution_state)
    const state: RunGraphCurrentState = {
      run: { executionState: head.execution_state, outcome: head.outcome, stopRequested: head.stopped,
        cleanupPending: head.cleanup_pending,
        pendingInteractionCount: [...pendingByNode.values()].reduce((count, items) => count + items.length, 0),
        unsettledReviewCount: [...reviewsByNode.values()].reduce((count, items) => count + items.length, 0) },
      nodes: topology.nodes.map((node) => {
        const id = node.workflowNodeId, current = executions.get(id), resolution = resolutionByNode.get(id)
        const pending = pendingByNode.get(id) ?? [], reviews = reviewsByNode.get(id) ?? []
        const pendingId = pending.filter((item) => item.status === 'pending').map((item) => item.interactionId).sort()[0]
        const activity = selectCurrentNodeActivity(id, nativeByNode.get(id) ?? [], { closed, workflowClosed: current?.state === 'completed',
          ...(pendingId ? { pendingInteractionId: pendingId } : {}),
          deliveryBlocked: pending.some((item) => ['decided', 'delivery_pending', 'delivery_failed'].includes(item.status)) })
        if (resolution?.execution && current?.execution.executionId !== resolution.execution.executionId) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
        return { state: compactNodeState(id, current, resolution), activity,
          attention: { workflowNodeId: id, pendingInteractionCount: pending.length, unsettledReviewCount: reviews.length,
            cleanupPending: reviews.some((review) => review.nativeCleanup === 'pending' || review.credentialCleanup === 'pending'),
            telemetry: activity.status === 'stale' ? 'stale' as const : activity.status === 'unknown' ? 'unknown' as const : 'current' as const },
          ...(resolution ? { resolution } : {}),
          ...(resolution?.acceptedResultDigest ? { acceptedResultDigest: resolution.acceptedResultDigest } : {}) }
      }), inputBindings, ...exchanges,
    }
    const attention = await readCurrentNodeAttention(sql, scope, new Map(state.nodes.map((node) => [node.state.workflowNodeId, node.activity])))
    for (const node of state.nodes) node.attention = attention.get(node.state.workflowNodeId)!
    state.run.pendingInteractionCount = [...attention.values()].reduce((count, item) => count + item.pendingInteractionCount, 0)
    state.run.unsettledReviewCount = [...attention.values()].reduce((count, item) => count + item.unsettledReviewCount, 0)
    const pinnedIds = new Set(topology.nodes.map((node) => node.workflowNodeId))
    if ([...executions.keys(), ...resolutionByNode.keys(), ...pendingByNode.keys(), ...reviewsByNode.keys()].some((id) => !pinnedIds.has(id))) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    return { topology, state: RunGraphCurrentStateSchema.parse(state) }
  }
}

async function readPinnedTopology(sql: GraphTransactionSql, scope: RunGraphScope, entryNodeId: string): Promise<RunGraphTopology> {
  const nodes = await sql.query<{ node: unknown; configuration_exists: boolean }>(
    `select jsonb_strip_nulls(jsonb_build_object('workflowNodeId',n.node->>'id','agentId',n.node->>'agentId',
       'agentConfigurationVersionId',v.record->'agentConfigurationVersionIds'->>(n.node->>'agentId'),
       'productRole',coalesce(c.record->>'productRole','unknown'),
       'position',n.node->'position','width',n.node->'width','height',n.node->'height')) as node,
       c.id is not null as configuration_exists
     from workflow_versions v cross join lateral jsonb_array_elements(v.record->'definition'->'nodes') n(node)
     left join agent_configuration_versions c on c.id=v.record->'agentConfigurationVersionIds'->>(n.node->>'agentId')
       and c.record->>'agentId'=n.node->>'agentId' and c.record->>'workspaceId'=$2
     where v.id=$1 order by n.node->>'id' limit $3`,
    [scope.workflowVersionId, scope.workspaceId, RUN_GRAPH_LIMITS.nodes + 1])
  const edges = await sql.query<{ relationship: unknown }>(
    `select jsonb_build_object('relationshipId',e.edge->>'id','kind',e.edge->>'kind',
       'source',e.edge->>'source','target',e.edge->>'target') as relationship
     from workflow_versions v cross join lateral jsonb_array_elements(v.record->'definition'->'edges') e(edge)
     where v.id=$1 order by e.edge->>'id' limit $2`,
    [scope.workflowVersionId, RUN_GRAPH_LIMITS.relationships + 1])
  if (nodes.rows.length > RUN_GRAPH_LIMITS.nodes || edges.rows.length > RUN_GRAPH_LIMITS.relationships) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  if (nodes.rows.some((row) => !row.configuration_exists)) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  return RunGraphTopologySchema.parse({ entryNodeId, nodes: nodes.rows.map((row) => row.node), relationships: edges.rows.map((row) => row.relationship) })
}
