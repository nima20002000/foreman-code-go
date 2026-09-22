import {
  AgentConfigurationVersionSchema, DurableInteractionSchema, HarnessExecutionSchema,
  HarnessWorkflowCompatibilitySchema, NativeSessionReferenceSchema,
  type DurableInteraction, type HarnessExecution,
} from '@graphql/contracts'
import {
  WorkflowRunV2Schema, WorkflowVersionV2Schema, canonicalGraphJson,
  type GraphExecutionIdentity, type RunGraphScope,
} from '@graphql/contracts/wave25'
import type pg from 'pg'
import { DomainError } from '../../errors.js'
import { resolveImmutableApprovalRoute, usesNativeSelfReview } from '../../workflows/approvalRoutes.js'
import { validateReviewerBootstrap } from '../../workflows/reviewerBootstrap.js'
import { withExclusiveGraphConnection, beforeGraphCommit, type GraphSqlClient, type GraphTransactionSql } from '../../run-graph/connection.js'
import { openRunGraphPublication, type RunGraphPublication } from '../../run-graph/publication.js'

export function fail(code: string, message = 'The approval identity, authority or owner changed.'): never {
  throw new DomainError(code, message, code === 'AUTH_REVOKED' ? 401 : code.endsWith('ACCESS_DENIED') ? 403 : 409)
}
export function identity(e: HarnessExecution): GraphExecutionIdentity {
  return { workflowNodeId: e.workflowNodeId, executionId: e.id, agentId: e.agentId,
    agentConfigurationVersionId: e.agentConfigurationVersionId, attempt: e.attempt }
}
export async function scopeForRun(sql: GraphSqlClient, runId: string): Promise<RunGraphScope> {
  const row = (await sql.query<{ workspace_id: string; workflow_id: string; workflow_version_id: string; execution_semantics_version: 1 | 2 }>(
    `select r.workspace_id,r.workflow_id,r.workflow_version_id,v.execution_semantics_version
     from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1`, [runId])).rows[0]
  if (!row) return fail('APPROVAL_RUN_NOT_FOUND')
  return { runId, workspaceId: row.workspace_id, workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id, executionSemanticsVersion: row.execution_semantics_version }
}
export async function runFor(sql: GraphSqlClient, kind: 'interaction' | 'review' | 'execution', id: string): Promise<string> {
  const text = kind === 'review' ? 'select i.run_id from review_jobs j join durable_interactions i on i.id=j.interaction_id where j.id=$1'
    : kind === 'interaction' ? 'select run_id from durable_interactions where id=$1' : 'select run_id from harness_executions where id=$1'
  const row = (await sql.query<{ run_id: string }>(text, [id])).rows[0]
  if (!row) return fail('APPROVAL_SUBJECT_NOT_FOUND')
  return row.run_id
}
export async function isV2(sql: GraphSqlClient, runId: string): Promise<boolean> {
  return (await scopeForRun(sql, runId)).executionSemanticsVersion === 2
}
export async function transact<T>(pool: pg.Pool, runId: string, work: (publication: RunGraphPublication) => Promise<T>): Promise<T> {
  return withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const scope = await scopeForRun(sql, runId)
    if (scope.executionSemanticsVersion !== 2) return fail('APPROVAL_SEMANTICS_MISMATCH')
    const publication = await openRunGraphPublication(sql, scope)
    // The Run and graph head precede child locks; never upgrade the parent lock.
    await sql.query('select id from harness_executions where run_id=$1 order by id for update', [runId])
    return work(publication)
  }))
}
export async function lockInteraction(sql: GraphTransactionSql, id: string): Promise<DurableInteraction> {
  const row = (await sql.query<{ record: unknown }>('select record from durable_interactions where id=$1 for update', [id])).rows[0]
  if (!row) return fail('INTERACTION_NOT_FOUND')
  return DurableInteractionSchema.parse(row.record)
}
export interface ApprovalContext {
  scope: RunGraphScope
  requester: HarnessExecution
  reviewer?: HarnessExecution
  relationshipId?: string
  stopped: boolean
}

/** All records come from immutable Run pins, never a draft, mutable role or cached owner. */
export async function readContext(sql: GraphSqlClient, interaction: DurableInteraction, requireOpen = false, completedReplay = false): Promise<ApprovalContext> {
  const row = (await sql.query<{ run: unknown; version: unknown; stopped: boolean }>(
    `select r.record as run,v.record as version,
       r.stop_requested_at is not null or r.worker_credentials_closed_at is not null as stopped
     from runs r join workflow_versions v on v.id=r.workflow_version_id
     where r.id=$1 and v.execution_semantics_version=2`, [interaction.runId])).rows[0]
  if (!row) return fail('APPROVAL_RUN_NOT_FOUND')
  const r = WorkflowRunV2Schema.parse(row.run), v = WorkflowVersionV2Schema.parse(row.version)
  if (r.id !== interaction.runId || r.workspaceId !== interaction.workspaceId || r.workflowId !== interaction.workflowId
    || r.workflowVersionId !== v.id || r.workspaceId !== v.workspaceId || r.workflowId !== v.workflowId
    || canonicalGraphJson(r.approval) !== canonicalGraphJson(v.approval)
    || canonicalGraphJson(interaction.approval) !== canonicalGraphJson(v.approval)
    || canonicalGraphJson(r.agentConfigurationVersionIds) !== canonicalGraphJson(v.agentConfigurationVersionIds)) return fail('APPROVAL_IDENTITY_MISMATCH')
  const stopped = row.stopped || !['queued', 'running', 'waiting'].includes(r.executionState)
  if (requireOpen && stopped) return fail('EXECUTION_STOPPED')
  const rows = (await sql.query<{ record: unknown; closed: boolean }>(
    `select record,worker_credentials_closed_at is not null as closed from harness_executions
     where run_id=$1 and (id=$2 or agent_id=$3) order by id`,
    [r.id, interaction.executionId, interaction.approval.designatedOrchestratorAgentId ?? null])).rows
  const executions = rows.map((item) => HarnessExecutionSchema.parse(item.record))
  const requester = executions.find((e) => e.id === interaction.executionId)
  if (!requester || requester.runId !== r.id || requester.agentId !== interaction.requestingAgentId || requester.attempt !== 1
    || requester.nativeSessionId !== interaction.nativeSessionId
    || requester.agentConfigurationVersionId !== v.agentConfigurationVersionIds[requester.agentId]
    || !v.definition.nodes.some((n) => n.id === requester.workflowNodeId && n.agentId === requester.agentId)) return fail('APPROVAL_REQUESTER_MISMATCH')
  if (requireOpen && !completedReplay && (requester.state === 'completed' || rows[executions.indexOf(requester)]?.closed)) return fail('EXECUTION_STOPPED')
  const route = interaction.approval.handler === 'orchestrator' ? resolveImmutableApprovalRoute(v, requester.workflowNodeId, requester.agentId) : undefined
  if (interaction.approval.handler === 'orchestrator' && !route?.relationshipId) return fail('APPROVAL_DIRECT_CONNECTION_REQUIRED')
  const reviewers = route ? executions.filter((e) => e.agentId === route.reviewerAgentId) : []
  const reviewer = reviewers[0]
  if (route && (reviewers.length !== 1 || !reviewer || reviewer.workflowNodeId !== route.orchestratorNodeId
    || reviewer.attempt !== 1 || reviewer.agentConfigurationVersionId !== route.reviewerConfigurationVersionId
    || reviewer.state !== 'completed' || reviewer.result?.outcome !== 'succeeded')) return fail('REVIEWER_EXECUTION_NOT_READY')
  const scope: RunGraphScope = { workspaceId: r.workspaceId, workflowId: r.workflowId, runId: r.id,
    workflowVersionId: v.id, executionSemanticsVersion: 2 }
  const saved = (await sql.query<{ approval_relationship_id: string | null; approval_reviewer_execution_id: string | null }>(
    'select approval_relationship_id,approval_reviewer_execution_id from durable_interactions where id=$1', [interaction.id])).rows[0]
  if (saved && (saved.approval_relationship_id !== (route?.relationshipId ?? null)
    || saved.approval_reviewer_execution_id !== (reviewer?.id ?? null))) return fail('APPROVAL_IDENTITY_MISMATCH')
  // Observation and terminal cleanup retain immutable node/configuration pins,
  // but cannot depend on a still-usable native configuration or live credentials.
  // Every new decision/submission calls this boundary with requireOpen=true.
  if (!requireOpen) return { scope, requester, ...(reviewer ? { reviewer, relationshipId: route!.relationshipId! } : {}), stopped }
  const actors = [requester, ...(reviewer ? [reviewer] : [])]
  const configs = (await sql.query<{ record: unknown }>(
    'select record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[]) order by id',
    [r.workspaceId, actors.map((e) => e.agentConfigurationVersionId)])).rows.map((item) => AgentConfigurationVersionSchema.parse(item.record))
  for (const e of actors) {
    const c = configs.find((item) => item.id === e.agentConfigurationVersionId)
    if (!c || c.workspaceId !== r.workspaceId || c.agentId !== e.agentId || !c.productRole) return fail('APPROVAL_CONFIGURATION_MISMATCH')
    HarnessWorkflowCompatibilitySchema.parse({ configuration: c.harness, workflowApprovalHandler: v.approval.handler,
      designatedOrchestrator: e.id === reviewer?.id })
    const native = (await sql.query<{ reference: unknown; finalized: boolean }>(
      'select reference,workflow_finalized_at is not null as finalized from execution_native_sessions where execution_id=$1', [e.id])).rows[0]
    const session = NativeSessionReferenceSchema.safeParse(native?.reference)
    if (!session.success || session.data.harness !== c.harness.harness || session.data.nativeSessionId !== e.nativeSessionId) return fail('APPROVAL_SESSION_MISMATCH')
    if (e.id === requester.id) {
      if (session.data.providerVersion !== interaction.providerVersion || session.data.harness !== interaction.harness
        || usesNativeSelfReview(c.harness)) return fail('APPROVAL_NATIVE_ROUTE_MISMATCH')
    } else {
      if (!native?.finalized || c.productRole !== 'orchestrator') return fail('REVIEWER_EXECUTION_NOT_READY')
      validateReviewerBootstrap(v.definition, v.approval, c.harness, v.entryNodeId)
    }
  }
  return { scope: { workspaceId: r.workspaceId, workflowId: r.workflowId, runId: r.id,
    workflowVersionId: v.id, executionSemanticsVersion: 2 }, requester, stopped,
    ...(reviewer ? { reviewer } : {}), ...(route?.relationshipId ? { relationshipId: route.relationshipId } : {}) }
}

export async function assertBudget(sql: GraphSqlClient, interaction: DurableInteraction): Promise<void> {
  const row = (await sql.query<{ active: boolean; graph_thread_id: string }>(
    `select graph_thread_id,stopped_at is null and active_elapsed_ms+
       coalesce(extract(epoch from(clock_timestamp()-active_started_at))*1000,0)<active_timeout_ms as active
     from approval_execution_state where execution_id=$1`, [interaction.executionId])).rows[0]
  if (!row?.active || row.graph_thread_id !== interaction.graphThreadId) return fail('EXECUTION_ACTIVE_TIMEOUT')
}

/** A SQL effect may release its lease in the mutation, but may not commit after
 * the original locked owner's expiry. The subject lock prevents takeover while
 * this final check runs; expiry is still checked against the database clock. */
export function requireLeaseAtCommit(sql: GraphTransactionSql, expiresAt: string | Date, code: string): void {
  beforeGraphCommit(sql, async () => {
    const live = await sql.query('select 1 where $1::timestamptz>clock_timestamp()', [expiresAt])
    if (live.rowCount !== 1) return fail(code)
  })
}
