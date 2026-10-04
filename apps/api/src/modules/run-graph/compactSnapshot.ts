import {
  GraphNodeStateSchema, PublicGraphProjectionSchema, InputBindingSchema, RUN_GRAPH_LIMITS,
  repeatGraphTopologyV3, type PublicGraphProjection, type RunGraphScope, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, type GraphTransactionSql } from './connection.js'
import { readRepeatGraphPinsLocked } from './repeatProjectionRows.js'
import { readCurrentGraphExchanges } from '../interactions/wave25/currentExchanges.js'
import { publicNodeState, type PublicExecution } from './publicLifecycle.js'
import { readPublicNodeProjection } from './publicProjection.js'
import { readPublicRunStateLocked } from './publicRunState.js'
import { readPublicAttentionCounts } from './currentAttention.js'
import { RunGraphError } from './errors.js'
import type { CurrentNativeActivity } from './nativeActivitySelection.js'

export type CurrentExchanges = Pick<PublicGraphProjection, 'interactions' | 'reviews'>
export type ReadCurrentGraphExchanges = (sql: GraphTransactionSql, scope: RunGraphScope) => Promise<CurrentExchanges>
export type CompactExecution = PublicExecution
export function compactNodeState(workflowNodeId: string, current: CompactExecution | undefined,
  resolution: PublicGraphProjection['nodes'][number]['resolution'], native: readonly CurrentNativeActivity[] = [], closed = false) {
  return GraphNodeStateSchema.parse(publicNodeState(workflowNodeId, current, resolution, native, closed))
}

/** The same physical read model feeds G1's final projection delta and snapshots.
 * No native response, elapsed-time or missing-row inference occurs here. */
export async function readPublicProjectionLocked(sql: GraphTransactionSql, scope: RunGraphScope,
  pinnedVersion?: WorkflowVersionV3): Promise<PublicGraphProjection> {
  assertGraphTransaction(sql)
  const version = pinnedVersion ?? (await readRepeatGraphPinsLocked(sql, scope)).version
  const nodeIds = version.definition.nodes.map((node) => node.id)
  const attention = await readPublicAttentionCounts(sql, scope.runId)
  for (const id of nodeIds) if (!attention.has(id)) attention.set(id, { pendingInteractionCount: 0,
    unsettledReviewCount: 0, cleanupPending: false, deliveryBlocked: false })
  const nodes = await readPublicNodeProjection(sql, scope, nodeIds, {}, attention)
  const currentIds = nodes.flatMap((node) => node.state.execution ? [node.state.execution.executionId] : [])
  // Carries remain qualified evidence, never masquerade as a canvas execution edge.
  const rows = await sql.query<{ record: { bindingId: string; recipient: unknown; inputDigest: string;
    source: { relationshipId: string; execution: unknown; acceptedResultDigest: string }; ordinal: number };
    bound_at: Date | string }>(`select b.record,b.bound_at from run_repeat_bindings b
      where b.run_id=$1 and b.recipient_execution_id=any($2::text[]) and b.record->>'kind'<>'carry'
      order by b.binding_id limit $3`, [scope.runId, currentIds, RUN_GRAPH_LIMITS.relationships + 1])
  if (rows.rows.length > RUN_GRAPH_LIMITS.relationships) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const inputBindings = rows.rows.map(({ record, bound_at }) => InputBindingSchema.parse({
    bindingId: record.bindingId, relationshipId: record.source.relationshipId,
    sender: record.source.execution, recipient: record.recipient,
    acceptedResultDigest: record.source.acceptedResultDigest, recipientInputDigest: record.inputDigest,
    inputOrdinal: record.ordinal, boundAt: bound_at instanceof Date ? bound_at.toISOString() : bound_at,
  }))
  return PublicGraphProjectionSchema.parse({ run: await readPublicRunStateLocked(sql, scope, attention), nodes, inputBindings,
    ...await readCurrentGraphExchanges(sql, scope) })
}

/** Public composition retains a single current reader, not a version dispatcher. */
export function createCompactSnapshotAssembler(_readExchanges: ReadCurrentGraphExchanges) {
  void _readExchanges
  return async (sql: GraphTransactionSql, scope: RunGraphScope) => {
    const { version } = await readRepeatGraphPinsLocked(sql, scope)
    return { topology: repeatGraphTopologyV3(version), state: await readPublicProjectionLocked(sql, scope, version) }
  }
}
