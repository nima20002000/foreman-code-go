import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { AcceptedNodePlacementSchema, DispatchIntentSchema } from '@graphql/contracts/node-placement'
import { SourceMaterializationRecordSchema, SourceRootRecordSchema } from '@graphql/contracts/source-admission'
import { DomainError } from '../errors.js'
import { readUnboundWorkflowClosure } from '../interactions/workflowClosure.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { sourceBindingHash } from './bindingHash.js'
import type { SourceReservation } from './reservations.js'

export async function loadWorkflowPreparation(sql: GraphSqlClient, workspaceId: string, operationId: string) {
  const row = (await sql.query<{
    intent: unknown; execution: unknown; placement: unknown; principal_id: string;
    execution_state: string; cleanup_pending: boolean; session_bound: boolean;
    reservation: SourceReservation; reservation_state: string; reserved_bytes: string;
    materialization: unknown | null; reconciliation_id: string | null; command_id: string | null;
    status: string | null; owner: unknown | null; closure: unknown | null;
  }>(`select i.record as intent,e.record as execution,p.record as placement,
      r.record->>'authorizationPrincipalId' as principal_id,r.execution_state,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending,
      exists(select 1 from execution_native_sessions n where n.execution_id=e.id) as session_bound,
      s.record as reservation,s.state as reservation_state,s.reserved_bytes,m.record as materialization,
      c.reconciliation_id,c.command_id,c.status,c.owner,c.closure
    from execution_dispatch_intents i join harness_executions e on e.id=i.execution_id
    join runs r on r.id=e.run_id
    join run_node_placements p on p.run_id=r.id and p.node_id=e.workflow_node_id
    join source_storage_reservations s on s.owner_kind='materialization' and s.owner_id=i.operation_id
    left join source_execution_materializations m on m.operation_id=i.operation_id
    left join source_preparation_reconciliations c on c.operation_id=i.operation_id
    where r.workspace_id=$1 and i.operation_id=$2 for share of i,e,r,s`, [workspaceId, operationId])).rows[0]
  if (!row) throw new DomainError('SOURCE_PREPARATION_NOT_FOUND', 'The original source preparation was not found.', 404)
  const intent = DispatchIntentSchema.parse(row.intent)
  const execution = HarnessExecutionSchema.parse(row.execution)
  const placement = AcceptedNodePlacementSchema.parse(row.placement)
  const source = placement.source
  if (!('kind' in source) || source.kind !== 'pending') {
    throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The workflow has no original source preparation.', 409)
  }
  const rootRow = (await sql.query<{ record: unknown }>(
    'select record from source_root_bindings where workspace_id=$1 and root_id=$2 and binding_revision=$3 for share',
    [workspaceId, source.rootId, source.bindingRevision],
  )).rows[0]
  const root = SourceRootRecordSchema.parse(rootRow?.record)
  const binding = root.binding
  const scopeId = `${binding.mainId}:${binding.deviceId ?? 'original-main'}:${binding.workerInstallationId ?? binding.mainId}:${binding.filesystem.device}:${binding.filesystem.mountId}`
  const attempt = {
    executionId: execution.id, attemptId: intent.attemptId,
    keyRevision: root.registration?.keyRevision ?? null,
    authorizationRevision: root.registration?.authorizationRevision ?? null,
    placementHash: '',
  }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  const record = row.materialization === null ? null : SourceMaterializationRecordSchema.parse(row.materialization)
  if (intent.operationId !== operationId || intent.executionId !== execution.id || intent.runId !== execution.runId
    || intent.nodeId !== execution.workflowNodeId || intent.technicalAttempt !== execution.attempt
    || placement.runId !== intent.runId || placement.nodeId !== intent.nodeId || placement.bindingHash !== intent.bindingHash
    || placement.payload.kind !== 'agent' || placement.payload.agentId !== execution.agentId
    || placement.payload.agentConfigurationVersionId !== execution.agentConfigurationVersionId
    || binding.mainId !== intent.mainId || placement.mainId !== intent.mainId || binding.workspaceId !== workspaceId
    || binding.rootId !== source.rootId || binding.bindingRevision !== source.bindingRevision
    || root.selection.rootPolicyId !== placement.destination.rootPolicyId
    || root.selection.rootPolicyRevision !== placement.destination.rootPolicyRevision
    || root.source.approvedSourceId !== source.approvedSourceId || root.source.snapshotId !== source.snapshotId
    || root.source.manifestDigest !== source.manifestDigest || !isDeepStrictEqual(root.selection.hostRef, placement.hostRef)
    || !isDeepStrictEqual(root.registration, placement.registration)
    || row.reservation.ownerKind !== 'materialization' || row.reservation.ownerId !== operationId
    || row.reservation.scopeId !== scopeId
    || record && (record.operationId !== operationId || record.reservationId !== row.reservation.reservationId
      || !isDeepStrictEqual(record.receipt.binding, binding) || record.receipt.executionId !== execution.id
      || record.receipt.attemptId !== intent.attemptId || record.sourceBindingHash !== attempt.placementHash)) {
    throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The original workflow source reservation changed.', 409)
  }
  return { ...row, kind: 'workflow' as const, execution, root, attempt, record, operationId, workspaceId }
}

export async function assertWorkflowPreparationClosed(
  sql: GraphSqlClient,
  state: Awaited<ReturnType<typeof loadWorkflowPreparation>>,
): Promise<void> {
  const execution = state.execution
  if (state.execution_state !== 'completed' || execution.state !== 'completed' || state.cleanup_pending
    || state.session_bound || execution.nativeSessionId || execution.result?.outcome === 'succeeded') {
    throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'Stop the workflow and finish its native cleanup before releasing preparation.', 409)
  }
  const entry = (await sql.query<{ phase: string; reservation: { execution: unknown } }>(
    'select phase,reservation from workflow_native_entries where execution_id=$1 and run_id=$2 for share',
    [execution.id, execution.runId],
  )).rows[0]
  if (!entry || !isDeepStrictEqual(entry.reservation.execution, repeatExecutionIdentity(execution))
    || !['reserved', 'prepared', 'entered'].includes(entry.phase)
    || entry.phase === 'entered' && !await readUnboundWorkflowClosure(sql, execution)) {
    throw new DomainError('SOURCE_EXECUTION_UNCERTAIN', 'The original workflow launch is not closed.', 409)
  }
}
