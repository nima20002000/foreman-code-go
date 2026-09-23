import {
  GraphNodeStateSchema, RunGraphTopologySchema, RunGraphCurrentStateSchema,
  RUN_GRAPH_LIMITS, type RunGraphScope, type RunGraphCurrentState, type RunGraphTopology,
} from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { assertGraphTransaction } from './connection.js'
import { RunGraphError } from './errors.js'
import { readInputBindings } from './records.js'
import type { ReadCurrentRunGraph } from './reader.js'
import { z } from 'zod'
import { publicNodeState, type PublicExecution } from './publicLifecycle.js'
import { readPublicNodeProjection } from './publicProjection.js'
import type { CurrentNativeActivity } from './nativeActivitySelection.js'

export type CurrentExchanges = Pick<RunGraphCurrentState, 'interactions' | 'reviews'>
/** Current exchanges must be read on the SAME coherent SQL cut as lifecycle. */
export type ReadCurrentGraphExchanges = (sql: GraphTransactionSql, scope: RunGraphScope) => Promise<CurrentExchanges>
const ExchangesSchema = z.object({
  interactions: RunGraphCurrentStateSchema.shape.interactions,
  reviews: RunGraphCurrentStateSchema.shape.reviews,
}).strict()
export type CompactExecution = PublicExecution

/** Retained public helper; publishers use the identical authoritative mapper. */
export function compactNodeState(workflowNodeId: string, current: CompactExecution | undefined,
  resolution: RunGraphCurrentState['nodes'][number]['resolution'], native: readonly CurrentNativeActivity[] = [], closed = false) {
  return GraphNodeStateSchema.parse(publicNodeState(workflowNodeId, current, resolution, native, closed))
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
    const ids = topology.nodes.map((node) => node.workflowNodeId)
    // A targeted projection must not silently hide an out-of-pin stored node.
    const invalid = await sql.query(`select 1 from harness_executions where run_id=$1
      and (not (workflow_node_id=any($2::text[])) or attempt<>1)
      union all select 1 from run_node_resolutions where run_id=$1
        and not (workflow_node_id=any($2::text[])) limit 1`, [scope.runId, ids])
    if (invalid.rowCount) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const nodes = await readPublicNodeProjection(sql, scope, ids)
    const inputBindings = await readInputBindings(sql, scope)
    const exchanges = ExchangesSchema.parse(await readExchanges(sql, scope))
    const pinned = new Set(ids)
    if (exchanges.interactions.some((item) => !pinned.has(item.requester.workflowNodeId)
      || item.reviewer && !pinned.has(item.reviewer.workflowNodeId))
      || exchanges.reviews.some((item) => !pinned.has(item.reviewer.workflowNodeId) || !pinned.has(item.requester.workflowNodeId))) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    const state: RunGraphCurrentState = {
      run: { executionState: head.execution_state, outcome: head.outcome, stopRequested: head.stopped,
        cleanupPending: head.cleanup_pending || nodes.some((node) => node.attention.cleanupPending),
        pendingInteractionCount: nodes.reduce((sum, node) => sum + node.attention.pendingInteractionCount, 0),
        unsettledReviewCount: nodes.reduce((sum, node) => sum + node.attention.unsettledReviewCount, 0) },
      nodes, inputBindings, ...exchanges,
    }
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
