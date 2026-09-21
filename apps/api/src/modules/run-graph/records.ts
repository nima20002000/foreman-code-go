import { HarnessExecutionSchema } from '@graphql/contracts'
import {
  InputBindingSchema, NodeResolutionSchema, WorkflowVersionV2Schema, parseChoiceResultEnvelope, RunNodeInputV2Schema, NativeGraphProjectionKeySchema,
  NativeGraphActivityRecordSchema, NativeGraphCorrelationRecordSchema, canonicalGraphJson,
  type InputBinding, type NodeResolution, type NativeGraphProjectionKey,
  type NativeGraphActivityRecord, type NativeGraphCorrelationRecord, type RunGraphScope,
  type NativeGraphProjectionFence, type NativeGraphProjectionAuthority,
} from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { assertGraphTransaction, poisonGraphTransaction } from './connection.js'
import { assertRunGraphPublication, graphSourceDigest } from './publication.js'
import { RunGraphError } from './errors.js'

/** These small records are immutable. They do not schedule native work or choose a route. */
export async function putNodeResolution(sql: GraphTransactionSql, scope: RunGraphScope, input: NodeResolution): Promise<void> {
  assertGraphTransaction(sql)
  assertRunGraphPublication(sql, scope)
  try {
    const resolution = NodeResolutionSchema.parse(input)
    if (scope.executionSemanticsVersion !== 2) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const pinned = await sql.query<{ record: unknown }>(
      `select v.record from runs r join workflow_versions v on v.id=r.workflow_version_id
       where r.id=$1 and v.record->'definition'->'nodes' @> jsonb_build_array(jsonb_build_object('id',$2::text))`,
      [scope.runId, resolution.workflowNodeId],
    )
    if (pinned.rowCount !== 1) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const version = WorkflowVersionV2Schema.parse(pinned.rows[0]!.record)
    const node = version.definition.nodes.find((candidate) => candidate.id === resolution.workflowNodeId)!
    const outgoing = version.definition.edges.filter((edge) => edge.kind === 'execution' && edge.source === node.id).map((edge) => edge.id).sort()
    const resolved = [...resolution.selectedRelationshipIds, ...resolution.unselectedRelationshipIds].sort()
    if (canonicalGraphJson(outgoing) !== canonicalGraphJson(resolved)) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const found = await sql.query<{ record: unknown; accepted: boolean }>(
      'select record,accepted from harness_executions where run_id=$1 and workflow_node_id=$2 order by id for update',
      [scope.runId, resolution.workflowNodeId],
    )
    if (!resolution.execution) {
      if (found.rows.length) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    } else {
      if (found.rows.length !== 1) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      const row = found.rows[0]!
      const execution = HarnessExecutionSchema.parse(row.record)
      const expected = resolution.execution
      if (execution.id !== expected.executionId || execution.attempt !== 1 || execution.attempt !== expected.attempt
        || execution.agentId !== expected.agentId || execution.agentConfigurationVersionId !== expected.agentConfigurationVersionId
        || execution.runId !== scope.runId || execution.workflowNodeId !== resolution.workflowNodeId
        || execution.agentId !== node.agentId || execution.agentConfigurationVersionId !== version.agentConfigurationVersionIds[node.agentId]
        || execution.state !== 'completed' || execution.result?.outcome !== resolution.resolution) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      if (resolution.resolution === 'succeeded') {
        if (!row.accepted || graphSourceDigest(execution.result) !== resolution.acceptedResultDigest) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
        if (node.choice) {
          const envelope = parseChoiceResultEnvelope(execution.result, node.choice)
          const target = node.choice.outcomes.find((choice) => choice.outcome === envelope.routing.outcome)!.target
          const selected = target.kind === 'edge' ? [target.relationshipId] : []
          if (resolution.outcome !== envelope.routing.outcome || resolution.branchEnded !== (target.kind === 'branch_end')
            || canonicalGraphJson([...resolution.selectedRelationshipIds].sort()) !== canonicalGraphJson(selected)) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
        } else if (resolution.outcome !== undefined || resolution.branchEnded || canonicalGraphJson([...resolution.selectedRelationshipIds].sort()) !== canonicalGraphJson(outgoing)) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      }
    }
    const record = canonicalGraphJson(resolution)
    const stored = await sql.query(
      `insert into run_node_resolutions(run_id,workflow_node_id,resolution,execution_id,attempt,record)
       values($1,$2,$3,$4,$5,$6::jsonb) on conflict(run_id,workflow_node_id) do update set record=run_node_resolutions.record
       where run_node_resolutions.record=excluded.record returning run_id`,
      [scope.runId, resolution.workflowNodeId, resolution.resolution, resolution.execution?.executionId ?? null, resolution.execution?.attempt ?? null, record],
    )
    if (stored.rowCount !== 1) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
  } catch (error) { poisonGraphTransaction(sql); throw error }
}
export async function putInputBinding(sql: GraphTransactionSql, scope: RunGraphScope, input: InputBinding): Promise<void> {
  assertGraphTransaction(sql)
  assertRunGraphPublication(sql, scope)
  try {
    const binding = InputBindingSchema.parse(input)
    if (scope.executionSemanticsVersion !== 2) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    // Parent Run/head must already be locked. Lock the exact executions in ID order.
    const rows = await sql.query<{ id: string; accepted: boolean; record: unknown }>(
      'select id,accepted,record from harness_executions where run_id=$1 and id=any($2::text[]) order by id for update',
      [scope.runId, [binding.sender.executionId, binding.recipient.executionId].sort()],
    )
    const senderRow = rows.rows.find((row) => row.id === binding.sender.executionId)
    const recipientRow = rows.rows.find((row) => row.id === binding.recipient.executionId)
    const sender = HarnessExecutionSchema.parse(senderRow?.record)
    const recipient = HarnessExecutionSchema.parse(recipientRow?.record)
    for (const [actual, expected] of [[sender, binding.sender], [recipient, binding.recipient]] as const) {
      if (actual.runId !== scope.runId || actual.workflowNodeId !== expected.workflowNodeId || actual.agentId !== expected.agentId
        || actual.agentConfigurationVersionId !== expected.agentConfigurationVersionId || actual.attempt !== expected.attempt || actual.attempt !== 1) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    if (recipient.state !== 'queued' || recipient.result !== undefined || !senderRow?.accepted || sender.result?.outcome !== 'succeeded'
      || graphSourceDigest(sender.result) !== binding.acceptedResultDigest
      || graphSourceDigest(recipient.input) !== binding.recipientInputDigest) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const receiptInput = RunNodeInputV2Schema.parse(recipient.input).predecessors[binding.inputOrdinal]
    if (!receiptInput || receiptInput.relationshipId !== binding.relationshipId || receiptInput.senderNodeId !== binding.sender.workflowNodeId
      || receiptInput.senderExecutionId !== binding.sender.executionId || graphSourceDigest(receiptInput.acceptedResult) !== binding.acceptedResultDigest) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const selected = await sql.query(
      `select 1 from run_node_resolutions n join runs r on r.id=n.run_id
       join workflow_versions v on v.id=r.workflow_version_id
       where n.run_id=$1 and n.workflow_node_id=$2 and n.execution_id=$3 and n.resolution='succeeded'
         and n.record->>'acceptedResultDigest'=$4 and (n.record->'selectedRelationshipIds') ? $5
         and v.record->'definition'->'edges' @> jsonb_build_array(jsonb_build_object(
           'id',$5::text,'kind','execution','source',$2::text,'target',$6::text))
         and v.record->'definition'->'nodes' @> jsonb_build_array(
           jsonb_build_object('id',$2::text,'agentId',$7::text),jsonb_build_object('id',$6::text,'agentId',$9::text))
         and v.record->'agentConfigurationVersionIds'->>$7=$8
         and v.record->'agentConfigurationVersionIds'->>$9=$10`,
      [scope.runId, binding.sender.workflowNodeId, binding.sender.executionId, binding.acceptedResultDigest, binding.relationshipId, binding.recipient.workflowNodeId,
        binding.sender.agentId, binding.sender.agentConfigurationVersionId, binding.recipient.agentId, binding.recipient.agentConfigurationVersionId],
    )
    if (selected.rowCount !== 1) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const result = await sql.query(
      `insert into run_input_bindings(run_id,binding_id,relationship_id,sender_execution_id,sender_node_id,sender_attempt,
       recipient_execution_id,recipient_node_id,recipient_attempt,accepted_result_digest,recipient_input_digest,input_ordinal,record)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       on conflict(run_id,binding_id) do update set record=run_input_bindings.record
       where run_input_bindings.record=excluded.record returning run_id`,
      [scope.runId, binding.bindingId, binding.relationshipId, binding.sender.executionId, binding.sender.workflowNodeId, binding.sender.attempt,
        binding.recipient.executionId, binding.recipient.workflowNodeId, binding.recipient.attempt,
        binding.acceptedResultDigest, binding.recipientInputDigest, binding.inputOrdinal, canonicalGraphJson(binding)],
    )
    if (result.rowCount !== 1) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
  } catch (error) { poisonGraphTransaction(sql); throw error }
}

export async function readNodeResolutions(sql: GraphTransactionSql, scope: RunGraphScope): Promise<NodeResolution[]> {
  assertGraphTransaction(sql)
  const result = await sql.query<{ record: unknown }>(
    'select record from run_node_resolutions where run_id=$1 order by workflow_node_id limit 1001', [scope.runId],
  )
  if (result.rows.length > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  return result.rows.map((row) => NodeResolutionSchema.parse(row.record))
}
export async function readInputBindings(sql: GraphTransactionSql, scope: RunGraphScope): Promise<InputBinding[]> {
  assertGraphTransaction(sql)
  const result = await sql.query<{ record: unknown }>(
    'select record from run_input_bindings where run_id=$1 order by recipient_execution_id,input_ordinal limit 8001', [scope.runId],
  )
  if (result.rows.length > 8000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  return result.rows.map((row) => InputBindingSchema.parse(row.record))
}

export async function readNativeGraphActivity(
  sql: GraphTransactionSql, scope: RunGraphScope, input: NativeGraphProjectionKey,
): Promise<NativeGraphActivityRecord | undefined> {
  assertGraphTransaction(sql)
  const key = NativeGraphProjectionKeySchema.parse(input)
  await assertNativeProjectionHost(sql, scope, key)
  const result = await sql.query<{
    projection_revision: string; last_native_sequence: string | null; terminal_native_sequence: string | null; activity: unknown
  }>(
    `select projection_revision::text,last_native_sequence::text,terminal_native_sequence::text,activity
     from run_native_activity where run_id=$1 and execution_id=$2 and work_kind=$3 and work_id=$4
       and workflow_node_id=$5 and attempt=$6`,
    [scope.runId, key.execution.executionId, key.workKind, key.workId, key.execution.workflowNodeId, key.execution.attempt],
  )
  const row = result.rows[0]
  return row ? NativeGraphActivityRecordSchema.parse({
    key, projectionRevision: row.projection_revision, lastNativeSequence: row.last_native_sequence,
    terminalNativeSequence: row.terminal_native_sequence, activity: row.activity,
  }) : undefined
}
export async function readNativeGraphCorrelation(
  sql: GraphTransactionSql, scope: RunGraphScope, input: NativeGraphProjectionKey, correlationKey: string,
): Promise<NativeGraphCorrelationRecord | undefined> {
  assertGraphTransaction(sql)
  const key = NativeGraphProjectionKeySchema.parse(input)
  await assertNativeProjectionHost(sql, scope, key)
  const result = await sql.query<{
    provider: string; native_session_id: string; connection_id: string | null; connection_generation: number;
    native_turn_id: string | null; native_request_id: string | null; interaction_id: string | null; review_job_id: string | null;
    first_native_sequence: string; last_native_sequence: string; terminal_native_sequence: string | null; metadata_revision: string
  }>(
    `select provider,native_session_id,connection_id,connection_generation,native_turn_id,native_request_id,
       interaction_id,review_job_id,first_native_sequence::text,last_native_sequence::text,terminal_native_sequence::text,metadata_revision::text
     from run_native_correlations where run_id=$1 and execution_id=$2 and work_kind=$3 and work_id=$4
       and correlation_key=$5 and workflow_node_id=$6 and attempt=$7`,
    [scope.runId, key.execution.executionId, key.workKind, key.workId, correlationKey, key.execution.workflowNodeId, key.execution.attempt],
  )
  const row = result.rows[0]
  return row ? NativeGraphCorrelationRecordSchema.parse({
    key, correlationKey, provider: row.provider, nativeSessionId: row.native_session_id,
    connectionId: row.connection_id, connectionGeneration: row.connection_generation,
    nativeTurnId: row.native_turn_id, nativeRequestId: row.native_request_id,
    interactionId: row.interaction_id, reviewJobId: row.review_job_id,
    firstNativeSequence: row.first_native_sequence, lastNativeSequence: row.last_native_sequence,
    terminalNativeSequence: row.terminal_native_sequence, metadataRevision: row.metadata_revision,
  }) : undefined
}

/** Read actual locked authority in the publication transaction; never return an echo of expected. */
export interface NativeGraphProjectionGuard {
  expected: NativeGraphProjectionFence
  readCurrentLocked(sql: GraphTransactionSql, scope: RunGraphScope, key: NativeGraphProjectionKey): Promise<NativeGraphProjectionAuthority>
}
/** Agent 5 implements mapping/CAS, calls assertNativeGraphProjectionAuthority BEFORE any write,
 * and preserves terminal fences. It does not acquire a second runtime owner here. */
export interface NativeGraphProjectionWriter {
  persistActivity(sql: GraphTransactionSql, scope: RunGraphScope, previousRevision: string | null, next: NativeGraphActivityRecord, guard: NativeGraphProjectionGuard): Promise<void>
  persistCorrelation(sql: GraphTransactionSql, scope: RunGraphScope, previousRevision: string | null, next: NativeGraphCorrelationRecord, guard: NativeGraphProjectionGuard): Promise<void>
}

async function assertNativeProjectionHost(sql: GraphTransactionSql, scope: RunGraphScope, key: NativeGraphProjectionKey): Promise<void> {
  const found = await sql.query(
    `select 1 from harness_executions e join runs r on r.id=e.run_id
     join workflow_versions v on v.id=r.workflow_version_id
     where e.id=$1 and e.run_id=$2 and e.workflow_node_id=$3 and e.attempt=$4
       and e.record->>'agentId'=$5 and e.record->>'agentConfigurationVersionId'=$6
       and r.workspace_id=$7 and r.workflow_id=$8 and r.workflow_version_id=$9
       and v.execution_semantics_version=$10
       and ($11::text='workflow' or exists(select 1 from review_jobs j
         join durable_interactions i on i.id=j.interaction_id
         where j.id=$12 and j.execution_id=e.id and i.run_id=e.run_id))`,
    [key.execution.executionId, scope.runId, key.execution.workflowNodeId, key.execution.attempt,
      key.execution.agentId, key.execution.agentConfigurationVersionId, scope.workspaceId, scope.workflowId,
      scope.workflowVersionId, scope.executionSemanticsVersion, key.workKind, key.workId],
  )
  if (found.rowCount !== 1) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
}
