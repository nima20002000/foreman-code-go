import { isDeepStrictEqual } from 'node:util'
import {
  DurableInteractionSchema, HarnessExecutionSchema, NativeSessionReferenceSchema, ReviewJobSchema,
  type HarnessExecution, type NativeSessionReference,
} from '@graphql/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { graphSourceDigest } from '../run-graph/publication.js'
import { readWorkflowClosure } from './workflowClosure.js'
import { CANCELED_INTERACTION_RETIRED_SQL, decisionDigest } from './wave25/publication.js'
import { assertRepeatNativeClosure, repeatNativePending } from './repeatNativeEvidence.js'

interface SessionRow { reference: unknown; finalized: boolean }
interface ClosedExecution { execution: HarnessExecution; session: NativeSessionReference; generation: string; finalized: boolean }

/** SQL-only boundary, on the SAME Run/head/owner transaction as repeat routing.
 * It neither closes a process nor acknowledges an approval. Those operations
 * must already have committed their exact receipts. In particular no Run-wide
 * finishRun, Stop, timeout, process absence or in-memory Set can satisfy it.
 *
 * Positive repeat routing calls this from RepeatRunRepository after its Run/head
 * lock and exact occurrence/slot/input receipt checks. Terminal Run cleanup calls
 * it from finalizeStoppedWorkflowSessions after strict Run/version validation;
 * that path grants no routing authority. Private workflow-finalization updates
 * roll back with the enclosing owner transaction in either case.
 */
export async function settleRepeatNativeExecutionLocked(sql: GraphTransactionSql, runId: string,
  supplied: HarnessExecution): Promise<void> {
  const parent = await sql.query<{ semantics: string; id: string; workspace_id: string; workflow_id: string; pins_match: boolean; negative_cleanup: boolean }>(
    `select id,record->>'executionSemanticsVersion' as semantics,workspace_id,workflow_id,
      (record->>'id'=id and record->>'workspaceId'=workspace_id and record->>'workflowId'=workflow_id) as pins_match,
      (execution_state='completed' and record->>'executionState'=execution_state
        and record->>'outcome' in ('failed','canceled')
        and record#>>'{result,outcome}'=record->>'outcome' and record->>'finishedAt' is not null) as negative_cleanup
      from runs where id=$1 for update`, [runId])
  if (parent.rows[0]?.id !== runId || parent.rows[0].semantics !== '3' || parent.rows[0].pins_match !== true || supplied.runId !== runId) {
    return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
  }
  const current = await readExecution(sql, runId, supplied.id)
  if (!isDeepStrictEqual(current, supplied)) return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
  const executions = new Map<string, HarnessExecution>([[current.id, current]])
  // Include jobs requested BY this execution and jobs USING it as reviewer. A
  // shared reviewer still active for a sibling must settle before it can be
  // declared cleaned; never revoke a live sibling merely to advance a repeat.
  const reviewers = await readSettledReviewers(sql, runId, current)
  for (const execution of reviewers) executions.set(execution.id, execution)
  const ordered = [...executions.values()].sort((left, right) => left.id.localeCompare(right.id))
  const closed: ClosedExecution[] = []
  for (const execution of ordered) {
    await assertExecutionResourcesSettled(sql, runId, execution.id)
    const native = (await sql.query<SessionRow>(
      `select reference,workflow_finalized_at is not null as finalized
       from execution_native_sessions where execution_id=$1 for update`, [execution.id])).rows[0]
    const session = native ? NativeSessionReferenceSchema.parse(native.reference) : null
    await assertInteractionsSettled(sql, runId, execution, session, parent.rows[0], parent.rows[0].negative_cleanup === true)
    if (!native || !session) {
      await assertNeverSubmitted(sql, execution)
      continue // Proven pre-dispatch negative work has no native row to invent.
    }
    const configuration = (await sql.query<{ harness: string; agent_id: string; workspace_id: string; pinned: boolean }>(
      `select c.record#>>'{harness,harness}' as harness,c.agent_id,c.workspace_id,
        (c.record->>'id'=c.id and c.record->>'agentId'=c.agent_id and c.record->>'workspaceId'=c.workspace_id
          and r.record->'agentConfigurationVersionIds'->>c.agent_id=c.id) as pinned
       from agent_configuration_versions c join runs r on r.id=$2
       where c.id=$1 and c.workspace_id=r.workspace_id`, [execution.agentConfigurationVersionId, runId])).rows[0]
    if (configuration?.pinned !== true || configuration.agent_id !== execution.agentId || configuration.harness !== session.harness) {
      return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
    }
    // Recheck even a previously finalized workflow: a subsequent reviewer
    // preflight invalidates that older close before it can start a new process.
    const generation = assertRepeatNativeClosure(execution, session, await readWorkflowClosure(sql, execution))
    closed.push({ execution, session, generation, finalized: native.finalized })
  }
  // No irreversible mutation before ALL requesters, reviewers and resources pass.
  // A crash after manager.close but before this transaction is repaired solely
  // from readWorkflowClosure, without attachSession/createSession/startTurn.
  for (const item of closed) {
    const proof = await readWorkflowClosure(sql, item.execution)
    if (assertRepeatNativeClosure(item.execution, item.session, proof) !== item.generation) {
      return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
    }
    if (item.finalized) continue
    const updated = await sql.query(`update execution_native_sessions
      set workflow_finalized_at=coalesce(workflow_finalized_at,clock_timestamp())
      where execution_id=$1 and reference=$2::jsonb returning execution_id`,
    [item.execution.id, JSON.stringify(item.session)])
    if (updated.rowCount !== 1) return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
  }
}

async function readExecution(sql: GraphTransactionSql, runId: string, id: string): Promise<HarnessExecution> {
  const row = (await sql.query<{ id: string; run_id: string; workflow_node_id: string; agent_id: string; attempt: number; record: unknown }>(
    `select id,run_id,workflow_node_id,agent_id,attempt,record from harness_executions where id=$1 and run_id=$2 for update`, [id, runId])).rows[0]
  const execution = HarnessExecutionSchema.parse(row?.record)
  if (row?.id !== id || row.run_id !== runId || execution.id !== id || execution.runId !== runId
    || row.workflow_node_id !== execution.workflowNodeId || row.agent_id !== execution.agentId || row.attempt !== execution.attempt
    || execution.state !== 'completed' || !execution.result || !execution.finishedAt) return repeatNativePending()
  return execution
}

async function assertExecutionResourcesSettled(sql: GraphTransactionSql, runId: string, executionId: string): Promise<void> {
  const row = (await sql.query<{ outstanding: boolean }>(`select (
    exists(select 1 from worker_credential_bindings b left join management_principals p on p.id=b.principal_id
      where b.execution_id=$1 and (b.run_id is distinct from $2 or b.revoked_at is null or p.id is null or p.revoked_at is null))
    or exists(select 1 from approval_execution_state a where a.execution_id=$1
      and (a.graph_thread_id is distinct from $2 or a.active_started_at is not null or a.approval_wait_started_at is not null))
    or exists(select 1 from review_jobs j where j.execution_id=$1 and
      (j.state is distinct from j.record->>'state' or j.state not in ('completed','failed')
        or (j.state='failed' and j.record->'cleanup'->>'completedAt' is null)
        or j.record->'cleanup'->>'nativeState'='pending'
        or j.record->'cleanup'->>'credentialState'='pending'))
    ) as outstanding`, [executionId, runId])).rows[0]
  if (row?.outstanding !== false) return repeatNativePending()
}

/** Absence of a process is NEVER used. This is the stronger, durable negative
 * case: the exact admitted slot has never crossed the canonical launch claim,
 * native preflight, event, interaction, credential or reviewer boundary. Paths
 * or startedAt without a claim are corruption/uncertainty, not launch permission.
 * The v3 native adapter MUST use execution.launch before any resource allocation.
 */
async function assertNeverSubmitted(sql: GraphTransactionSql, execution: HarnessExecution): Promise<void> {
  if (execution.result?.outcome === 'succeeded' || execution.nativeSessionId || execution.startedAt
    || execution.workingDirectory || execution.runtimeDirectory) return repeatNativePending('REPEAT_BOUNDARY_PENDING')
  const row = (await sql.query<{ possible_submission: boolean }>(`select (
    exists(select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch' and entity_id=$2)
    or exists(select 1 from execution_native_closures where execution_id=$2)
    or exists(select 1 from harness_native_events where execution_id=$2)
    or exists(select 1 from run_native_correlations where run_id=$1 and execution_id=$2)
    or exists(select 1 from worker_credential_bindings where execution_id=$2)
    or exists(select 1 from durable_interactions where execution_id=$2)
    or exists(select 1 from review_jobs where execution_id=$2)
    ) as possible_submission`, [execution.runId, execution.id])).rows[0]
  if (row?.possible_submission !== false) return repeatNativePending('REPEAT_BOUNDARY_PENDING')
}

async function readSettledReviewers(sql: GraphTransactionSql, runId: string,
  requester: HarnessExecution): Promise<HarnessExecution[]> {
  const result = new Map<string, HarnessExecution>()
  let after = ''
  for (;;) {
    const rows = (await sql.query<{ id: string; execution_id: string | null; state: string; record: unknown; run_id: string; same_run: boolean; native_reference: unknown }>(
      `select j.id,j.execution_id,j.state,j.record,i.run_id,(i.run_id=$1) as same_run,s.reference as native_reference from review_jobs j
       join durable_interactions i on i.id=j.interaction_id
       left join execution_native_sessions s on s.execution_id=j.execution_id
       where (i.execution_id=$2 or j.execution_id=$2) and j.id>$3
       order by j.id limit 100 for update of j`, [runId, requester.id, after])).rows
    for (const row of rows) {
      const job = ReviewJobSchema.parse(row.record)
      if (row.same_run !== true || row.run_id !== runId || row.id !== job.id || row.state !== job.state) return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
      if (!['completed', 'failed'].includes(job.state) || job.state === 'failed' && !job.cleanup?.completedAt
        || job.cleanup?.nativeState === 'pending' || job.cleanup?.credentialState === 'pending') return repeatNativePending()
      if (!row.execution_id) {
        if (job.state !== 'failed' || job.cleanup?.nativeState !== 'not_started') return repeatNativePending()
        continue
      }
      const execution = result.get(row.execution_id) ?? await readExecution(sql, runId, row.execution_id)
      const native = NativeSessionReferenceSchema.parse(row.native_reference)
      if (execution.agentId !== job.reviewerAgentId || execution.nativeSessionId !== job.nativeSessionId
        || native.harness !== job.provider || native.nativeSessionId !== job.nativeSessionId) {
        return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
      }
      result.set(execution.id, execution)
    }
    if (rows.length < 100) return [...result.values()]
    after = rows[rows.length - 1]!.id
  }
}

async function assertInteractionsSettled(sql: GraphTransactionSql, runId: string, execution: HarnessExecution,
  session: NativeSessionReference | null, scope: { workspace_id: string; workflow_id: string }, negativeCleanup: boolean): Promise<void> {
  let after = ''
  for (;;) {
    const rows = (await sql.query<{ id: string; execution_id: string; status: string; record: unknown; retired: boolean }>(
      `select i.id,i.execution_id,i.status,i.record,(${CANCELED_INTERACTION_RETIRED_SQL}) as retired
       from durable_interactions i where i.run_id=$1 and i.execution_id=$2 and i.id>$3
       order by i.id limit 100 for update of i`, [runId, execution.id, after])).rows
    for (const stored of rows) {
      const interaction = DurableInteractionSchema.parse(stored.record)
      if (interaction.id !== stored.id || interaction.executionId !== execution.id || stored.execution_id !== execution.id
        || interaction.status !== stored.status || interaction.runId !== runId || interaction.graphThreadId !== runId
        || interaction.workspaceId !== scope.workspace_id || interaction.workflowId !== scope.workflow_id
        || interaction.requestingAgentId !== execution.agentId || interaction.nativeSessionId !== execution.nativeSessionId
        || !session || interaction.harness !== session.harness || interaction.providerVersion !== session.providerVersion) {
        return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
      }
      if (interaction.status === 'canceled') {
        // A canceled selected approval needs a negative execution or an already
        // negative-terminal Run, plus canonical retirement. This can finalize
        // cleanup after Stop but never grants routing or a native resume/ack.
        if (stored.retired !== true || interaction.selectedOptionId && execution.result?.outcome === 'succeeded' && !negativeCleanup) {
          return repeatNativePending('APPROVAL_SETTLEMENT_PENDING')
        }
        continue
      }
      if (interaction.status !== 'delivered' || interaction.deliveryState !== 'delivered'
        || !interaction.selectedOptionId || !interaction.graphInterruptId) return repeatNativePending('APPROVAL_SETTLEMENT_PENDING')
      const resume = (await sql.query<{ state: string; approval_native_ack_id: string | null }>(
        `select state,approval_native_ack_id from interaction_graph_resumes where interaction_id=$1 for update`, [interaction.id])).rows[0]
      const receipt = (await sql.query<{ effect_digest: string }>(
        `select effect_digest from run_graph_effects where run_id=$1 and effect_kind='graph.resume' and entity_id=$2`,
        [runId, interaction.id])).rows[0]
      const expected = graphSourceDigest({ interactionId: interaction.id, runId, executionId: execution.id,
        graphThreadId: interaction.graphThreadId, graphInterruptId: interaction.graphInterruptId,
        decision: decisionDigest(interaction) })
      if (receipt && receipt.effect_digest !== expected) return repeatNativePending('REPEAT_APPROVAL_RECEIPT_CONFLICT')
      if (resume?.state !== 'resumed' || !resume.approval_native_ack_id || !receipt) return repeatNativePending('APPROVAL_SETTLEMENT_PENDING')
    }
    if (rows.length < 100) return
    after = rows[rows.length - 1]!.id
  }
}
