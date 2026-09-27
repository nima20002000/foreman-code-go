import { HarnessExecutionSchema } from '@graphql/contracts'
import {
  WorkActivationIdentitySchema, WorkHandoffResultSchema, WorkLimitDenialSchema, WorkRequestSchema, WorkReturnSchema,
  canonicalGraphJson, parseWorkHandoffResult, workConnectionForRequest,
  type WorkLimitDenial, type WorkRequest, type WorkReturn, type WorkflowVersionV3,
} from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatLockedHooks } from './repeatPostgres.js'
import { repeatConflict, repeatDigest, repeatId, sameRepeatValue, type RepeatScope } from './repeatResolution.js'

export type WorkRequestAdmission = { kind: 'accepted'; request: WorkRequest; replayed: boolean }
  | { kind: 'limit_reached'; denial: WorkLimitDenial; replayed: boolean }
export interface WorkReturnReceipt { value: WorkReturn; replayed: boolean }

interface AdmissionContext {
  sql: GraphTransactionSql; scope: RepeatScope; version: WorkflowVersionV3
  hooks: RepeatLockedHooks; now: string
  assertActive(): void
}

/** Called only inside RepeatRunRepository's owner-fenced, Run-locked transaction.
 * This is an admission receipt; native launch still uses the original one-use
 * claim, authorization, session and possible-submission boundary. */
export async function admitWorkHandoffLocked(context: AdmissionContext, sourceExecutionId: string): Promise<WorkRequestAdmission> {
  const { sql, scope, version, hooks } = context
  if (!version.definition.handoffs || version.definition.repeat) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  await hooks.assertAuthorityLocked(sql)
  const row = (await sql.query<{ record: unknown; accepted: boolean; work_activation_id: string | null }>(
    `select record,accepted,work_activation_id from harness_executions
      where id=$1 and run_id=$2 for share`, [sourceExecutionId, scope.runId])).rows[0]
  if (!row?.accepted || !row.work_activation_id) return repeatConflict('WORK_SOURCE_NOT_ACCEPTED')
  const execution = HarnessExecutionSchema.parse(row.record)
  if (execution.id !== sourceExecutionId || execution.runId !== scope.runId || execution.state !== 'completed'
    || execution.result?.outcome !== 'succeeded' || !execution.finishedAt
    || execution.agentConfigurationVersionId !== version.agentConfigurationVersionIds[execution.agentId]) {
    return repeatConflict('WORK_SOURCE_PIN_CONFLICT')
  }
  const source = (await sql.query<{ record: unknown; workflow_node_id: string }>(
    'select record,workflow_node_id from run_work_activations where activation_id=$1 and run_id=$2 for share',
    [row.work_activation_id, scope.runId])).rows[0]
  if (!source || source.workflow_node_id !== execution.workflowNodeId) return repeatConflict('WORK_SOURCE_ACTIVATION_CONFLICT')
  const activation = WorkActivationIdentitySchema.parse(source.record)
  if (!sameRepeatValue(activation.scope, scope) || activation.activationId !== row.work_activation_id) {
    return repeatConflict('WORK_SOURCE_ACTIVATION_CONFLICT')
  }
  const result = WorkHandoffResultSchema.parse(parseWorkHandoffResult(execution.result))
  const routing = result.routing
  if (routing.kind !== 'request') return repeatConflict('WORK_REQUEST_RESULT_REQUIRED')
  const node = version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
  const target = node?.choice?.outcomes.find((item) => item.outcome === routing.outcome)?.target
  if (!target || target.kind !== 'edge') return repeatConflict('WORK_REQUEST_OUTCOME_UNDECLARED')
  const relationship = version.definition.edges.find((item) => item.id === target.relationshipId)
  const destinationNodeId = relationship?.source === node.id ? relationship.target
    : relationship?.workRequestDirection === 'both' && relationship.target === node.id ? relationship.source : undefined
  if (!relationship || !destinationNodeId || !node
    || workConnectionForRequest(version.definition, node.id, destinationNodeId)?.id !== relationship.id) {
    return repeatConflict('WORK_REQUEST_ROUTE_FORBIDDEN')
  }
  const requestId = repeatId('work-request', scope.runId, sourceExecutionId)
  const payloadDigest = repeatDigest(execution.result, 64 * 1024)
  const prior = (await sql.query<{ record: unknown; payload_digest: string }>(
    'select record,payload_digest from run_work_requests where request_id=$1 and run_id=$2',
    [requestId, scope.runId])).rows[0]
  if (prior) {
    const request = WorkRequestSchema.parse(prior.record)
    if (prior.payload_digest !== payloadDigest || request.requesterExecutionId !== sourceExecutionId
      || request.relationshipId !== relationship.id || !sameRepeatValue(request.scope, scope)) {
      return repeatConflict('WORK_REQUEST_REPLAY_CONFLICT')
    }
    return { kind: 'accepted', request, replayed: true }
  }
  const denied = (await sql.query<{ record: unknown; payload_digest: string }>(
    'select record,payload_digest from run_work_denials where request_id=$1 and run_id=$2',
    [requestId, scope.runId])).rows[0]
  if (denied) {
    const denial = WorkLimitDenialSchema.parse(denied.record)
    if (denied.payload_digest !== payloadDigest || denial.relationshipId !== relationship.id
      || !sameRepeatValue(denial.scope, scope)) return repeatConflict('WORK_REQUEST_REPLAY_CONFLICT')
    return { kind: 'limit_reached', denial, replayed: true }
  }
  context.assertActive()
  await hooks.assertSettlementLocked(sql, [sourceExecutionId])
  const destination = version.definition.nodes.find((item) => item.id === destinationNodeId)!
  const candidate = HarnessExecutionSchema.parse({ id: repeatId('work-candidate', requestId),
    runId: scope.runId, workflowNodeId: destination.id, agentId: destination.agentId,
    agentConfigurationVersionId: version.agentConfigurationVersionIds[destination.agentId],
    attempt: 1, input: {}, state: 'queued', createdAt: context.now })
  await hooks.assertAdmissionLocked(sql, candidate, { nodeId: destination.id, occurrence: null })
  const maximum = relationship.maxWorkHandoffsPerRun ?? null
  await sql.query(`insert into run_work_connection_usage(run_id,workflow_version_id,relationship_id,maximum)
    values($1,$2,$3,$4) on conflict do nothing`, [scope.runId, scope.workflowVersionId, relationship.id, maximum])
  const usage = (await sql.query<{ used: number; maximum: number | null }>(`select used,maximum
    from run_work_connection_usage where run_id=$1 and workflow_version_id=$2 and relationship_id=$3 for update`,
  [scope.runId, scope.workflowVersionId, relationship.id])).rows[0]
  if (!usage || usage.maximum !== maximum) return repeatConflict('WORK_COUNTER_PIN_CONFLICT')
  if (maximum !== null && usage.used >= maximum) {
    const denial = WorkLimitDenialSchema.parse({ scope, denialId: repeatId('work-denial', requestId), requestId,
      relationshipId: relationship.id, requesterActivationId: activation.activationId,
      destinationNodeId, payloadDigest, used: usage.used, maxWorkHandoffsPerRun: maximum, deniedAt: context.now })
    await sql.query(`insert into run_work_denials(denial_id,run_id,request_id,workflow_version_id,relationship_id,
      requester_activation_id,payload_digest,record,denied_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [denial.denialId, scope.runId, requestId, scope.workflowVersionId, relationship.id,
      activation.activationId, payloadDigest, canonicalGraphJson(denial), context.now])
    await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values($1,'backend','work_handoff_denied',$2,$3,$4::jsonb)`, [scope.runId, sourceExecutionId,
      context.now, canonicalGraphJson({ denialId: denial.denialId, relationshipId: relationship.id,
        requesterNodeId: node.id, destinationNodeId, used: usage.used, maximum })])
    return { kind: 'limit_reached', denial, replayed: false }
  }
  const activationCount = (await sql.query<{ total: string }>(
    'select count(*)::text as total from run_work_activations where run_id=$1', [scope.runId])).rows[0]
  if (!activationCount || BigInt(activationCount.total) >= BigInt(version.definition.executionPolicy!.maxNodeExecutions)) {
    return repeatConflict('WORK_RUN_EXECUTION_BUDGET_EXHAUSTED')
  }
  const reserved = (await sql.query<{ used: number }>(`update run_work_connection_usage set used=used+1
    where run_id=$1 and workflow_version_id=$2 and relationship_id=$3
      and (maximum is null or used<maximum) returning used`,
  [scope.runId, scope.workflowVersionId, relationship.id])).rows[0]
  if (!reserved) return repeatConflict('WORK_COUNTER_RACE')
  const activationId = repeatId('work-activation', requestId)
  const next = WorkActivationIdentitySchema.parse({ scope, activationId,
    workflowNodeId: destinationNodeId, cause: { kind: 'work_request', requestId } })
  const request = WorkRequestSchema.parse({ scope, requestId, relationshipId: relationship.id,
    requesterActivationId: activation.activationId, requesterExecutionId: sourceExecutionId,
    destinationActivationId: activationId, requesterNodeId: node.id, destinationNodeId,
    payloadDigest, acceptedAt: context.now, ordinal: reserved.used })
  await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,'work_request',$5,'queued',$6::jsonb)`,
  [activationId, scope.runId, scope.workflowVersionId, destinationNodeId, requestId, canonicalGraphJson(next)])
  await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,ordinal,
    requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,
    payload_digest,record,accepted_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
  [requestId, scope.runId, scope.workflowVersionId, relationship.id, reserved.used, activation.activationId,
    sourceExecutionId, activationId, node.id, destinationNodeId, payloadDigest, canonicalGraphJson(request), context.now])
  await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    values($1,'backend','work_handoff_accepted',$2,$3,$4::jsonb)`, [scope.runId, sourceExecutionId,
    context.now, canonicalGraphJson({ requestId, relationshipId: relationship.id, requesterNodeId: node.id,
      destinationNodeId, used: reserved.used, maximum })])
  return { kind: 'accepted', request, replayed: false }
}

/** The review returns to its exact request and costs no additional work slot. */
export async function returnWorkHandoffLocked(context: AdmissionContext, sourceExecutionId: string): Promise<WorkReturnReceipt> {
  const { sql, scope, version, hooks } = context
  if (!version.definition.handoffs || version.definition.repeat) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  await hooks.assertAuthorityLocked(sql)
  const row = (await sql.query<{ record: unknown; accepted: boolean; work_activation_id: string | null }>(
    `select record,accepted,work_activation_id from harness_executions
      where id=$1 and run_id=$2 for share`, [sourceExecutionId, scope.runId])).rows[0]
  if (!row?.accepted || !row.work_activation_id) return repeatConflict('WORK_RETURN_SOURCE_NOT_ACCEPTED')
  const execution = HarnessExecutionSchema.parse(row.record)
  if (execution.id !== sourceExecutionId || execution.runId !== scope.runId || execution.state !== 'completed'
    || execution.result?.outcome !== 'succeeded' || !execution.finishedAt
    || execution.agentConfigurationVersionId !== version.agentConfigurationVersionIds[execution.agentId]) {
    return repeatConflict('WORK_RETURN_SOURCE_PIN_CONFLICT')
  }
  const activationRow = (await sql.query<{ record: unknown; cause_kind: string; cause_id: string }>(
    'select record,cause_kind,cause_id from run_work_activations where activation_id=$1 and run_id=$2 for share',
    [row.work_activation_id, scope.runId])).rows[0]
  if (!activationRow || activationRow.cause_kind !== 'work_request') return repeatConflict('WORK_RETURN_REQUEST_MISSING')
  const activation = WorkActivationIdentitySchema.parse(activationRow.record)
  if (!sameRepeatValue(activation.scope, scope) || activation.workflowNodeId !== execution.workflowNodeId) {
    return repeatConflict('WORK_RETURN_SOURCE_PIN_CONFLICT')
  }
  const requestRow = (await sql.query<{ record: unknown }>(
    'select record from run_work_requests where request_id=$1 and run_id=$2 for share',
    [activationRow.cause_id, scope.runId])).rows[0]
  if (!requestRow) return repeatConflict('WORK_RETURN_REQUEST_MISSING')
  const request = WorkRequestSchema.parse(requestRow.record)
  if (!sameRepeatValue(request.scope, scope) || request.destinationActivationId !== activation.activationId
    || request.destinationNodeId !== execution.workflowNodeId) return repeatConflict('WORK_RETURN_ANCESTRY_CONFLICT')
  const result = parseWorkHandoffResult(execution.result)
  const routing = result.routing
  if (routing.kind !== 'return' || routing.requestId !== request.requestId) {
    return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
  }
  const resultDigest = repeatDigest(execution.result, 64 * 1024)
  const prior = (await sql.query<{ record: unknown }>(
    'select record from run_work_returns where run_id=$1 and request_id=$2', [scope.runId, request.requestId])).rows[0]
  if (prior) {
    const value = WorkReturnSchema.parse(prior.record)
    if (value.sourceExecutionId !== sourceExecutionId || value.acceptedResultDigest !== resultDigest
      || !sameRepeatValue(value.scope, scope)) return repeatConflict('WORK_RETURN_REPLAY_CONFLICT')
    return { value, replayed: true }
  }
  context.assertActive()
  await hooks.assertSettlementLocked(sql, [sourceExecutionId])
  const returnId = repeatId('work-return', sourceExecutionId)
  const continuationActivationId = routing.outcome === 'needs_changes'
    ? repeatId('work-activation', returnId) : undefined
  const value = WorkReturnSchema.parse({ scope, returnId, requestId: request.requestId,
    sourceActivationId: activation.activationId, sourceExecutionId,
    requesterActivationId: request.requesterActivationId,
    ...(continuationActivationId ? { continuationActivationId } : {}),
    acceptedResultDigest: resultDigest, outcome: routing.outcome,
    latestDeliverable: result.data.latestDeliverable, remainingFindings: result.data.remainingFindings,
    returnedAt: context.now })
  if (continuationActivationId) {
    const next = WorkActivationIdentitySchema.parse({ scope, activationId: continuationActivationId,
      workflowNodeId: request.requesterNodeId, cause: { kind: 'work_return', returnId } })
    await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
      cause_kind,cause_id,state,record) values($1,$2,$3,$4,'work_return',$5,'queued',$6::jsonb)`,
    [continuationActivationId, scope.runId, scope.workflowVersionId, request.requesterNodeId,
      returnId, canonicalGraphJson(next)])
  }
  await sql.query(`insert into run_work_returns(return_id,run_id,request_id,source_activation_id,source_execution_id,
    requester_continuation_activation_id,result_digest,outcome,record,returned_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
  [returnId, scope.runId, request.requestId, activation.activationId, sourceExecutionId,
    continuationActivationId ?? null, resultDigest, value.outcome, canonicalGraphJson(value), context.now])
  await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    values($1,'backend','work_handoff_returned',$2,$3,$4::jsonb)`, [scope.runId, sourceExecutionId,
    context.now, canonicalGraphJson({ returnId, requestId: request.requestId,
      relationshipId: request.relationshipId, outcome: value.outcome, continuationActivationId: continuationActivationId ?? null })])
  return { value, replayed: false }
}
