import { NativeSessionReferenceSchema, type HarnessExecution } from '@graphql/contracts'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import { RemoteOperationReceiptSchema } from '@graphql/contracts/remote-execution'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { remoteReviewerPolicy, assertRemoteReviewerReceipt } from '../placement/remoteReviewerAuthority.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

export async function readRetainedRemoteReviewer(sql: GraphSqlClient, execution: HarnessExecution) {
  const placement = await readExecutionPlacement(sql, execution.id)
  if (placement?.hostRef.kind !== 'device') return undefined
  const row = (await sql.query<{ receipt: unknown }>(`select r.receipt from remote_execution_receipts r
    join execution_dispatch_intents i using(operation_id) where i.execution_id=$1`, [execution.id])).rows[0]
  if (!row) return undefined
  const receipt = RemoteOperationReceiptSchema.parse(row.receipt)
  const policy = await remoteReviewerPolicy(sql, receipt.intent)
  if (!receipt.retainedReviewer || receipt.terminal || receipt.stopFence || !policy
    || !['running', 'waiting'].includes(policy.run.executionState) || policy.run.outcome !== 'pending') return undefined
  const current = await readReconciledDispatchIntent(sql, receipt.intent.operationId)
  await assertRemoteReviewerReceipt(sql, receipt)
  if (!sameWorkflowValue(current, receipt.intent) || placement.bindingHash !== receipt.intent.bindingHash
    || execution.state !== 'completed' || execution.result?.outcome !== 'succeeded'
    || !sameWorkflowValue(execution.result, receipt.retainedReviewer.result)
    || !policy.session || policy.session.nativeSessionId !== execution.nativeSessionId)
    throw new DomainError('REMOTE_REVIEWER_DENIED', 'The retained reviewer result does not match its execution.', 409)
  const lifetime = (await sql.query<{ generation: string; live: boolean; reference: unknown }>(`select c.generation::text,
    c.closed_at is null and c.detached_at is null and clock_timestamp()<$2::timestamptz
      and not exists(select 1 from execution_native_closures p where p.execution_id=c.execution_id
        and p.generation<c.generation and p.closed_at is null and p.detached_at is null) as live,
      s.reference from execution_native_closures c join execution_native_sessions s using(execution_id)
      where c.execution_id=$1 order by c.generation desc limit 1 for share of c,s`,
  [execution.id, receipt.retainedReviewer.expiresAt])).rows[0]
  if (!lifetime?.live || !sameWorkflowValue(NativeSessionReferenceSchema.parse(lifetime.reference), policy.session))
    return undefined
  const terminal = await sql.query(`select 1 from workflow_native_proofs where execution_id=$1 and run_id=$2
    and record#>>'{original,type}'='history' and record#>>'{original,history,terminalTurn,correlationId}'=$3
    and record#>>'{original,history,terminalTurn,providerId}'=$4
    and record#>'{original,history,terminalTurn,result}'=$5::jsonb limit 1`,
  [execution.id, execution.runId, `execution:${execution.id}`, receipt.retainedReviewer.workflowTurnId, JSON.stringify(execution.result)])
  if (terminal.rowCount !== 1) throw new DomainError('REMOTE_REVIEWER_DENIED', 'Original reviewer terminal proof is required.', 409)
  const credentials = (await sql.query<{ principal_id: string }>(`select b.principal_id from worker_credential_bindings b
    join management_principals p on p.id=b.principal_id where b.execution_id=$1 and b.run_id=$2
    and b.agent_id=$3 and b.revoked_at is null and p.revoked_at is null and p.expires_at>clock_timestamp()
    and p.audience='worker' and p.agent_id=b.agent_id order by b.principal_id limit 2`,
  [execution.id, execution.runId, execution.agentId])).rows
  if (credentials.length !== 1) throw new DomainError('REMOTE_REVIEWER_DENIED', 'The original reviewer process lease is required.', 409)
  const principalId = credentials[0]!.principal_id
  const principal = await readLiveManagementPrincipal(sql, principalId)
  const scope = { workspaceId: policy.run.workspaceId, workflowId: policy.run.workflowId, runId: policy.run.id }
  requireAuthorization(principal, 'interactions:read', scope)
  requireAuthorization(principal, 'interactions:respond', scope)
  return { generation: lifetime.generation, principalId, session: policy.session }
}

export async function retainRemoteReviewerCredential(sql: GraphSqlClient, execution: HarnessExecution,
  retained: NonNullable<Awaited<ReturnType<typeof readRetainedRemoteReviewer>>>) {
  const lane = (await sql.query<{ generation: string }>(`select record->>'connectionGeneration' as generation
    from native_session_lanes where harness=$1 and native_session_id=$2 and owner_agent_id=$3 for share`,
  [retained.session.harness, retained.session.nativeSessionId, execution.agentId])).rows[0]
  if (!lane) throw new DomainError('REMOTE_REVIEWER_DENIED', 'The original reviewer writer lane is required.', 409)
  const result = await sql.query(`update worker_credential_bindings set purpose='reviewer',
    approval_native_session_id=$4,approval_connection_generation=$5::bigint
    where principal_id=$1 and execution_id=$2 and agent_id=$3 and revoked_at is null`,
  [retained.principalId, execution.id, execution.agentId, retained.session.nativeSessionId, lane.generation])
  if (result.rowCount !== 1) throw new DomainError('REMOTE_REVIEWER_DENIED', 'The process lease changed during retention.', 409)
}
