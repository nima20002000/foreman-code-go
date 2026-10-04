import { HarnessExecutionSchema, NativeSessionReferenceSchema, RunOutcomeSchema,
  type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { RepeatRunVersionV1Schema } from '@foreman-code/contracts/wave25'
import { settleRepeatNativeExecutionLocked } from './repeatNativeSettlement.js'
import { DomainError } from '../errors.js'
import { readWorkflowClosure } from './workflowClosure.js'
import type { RunOwnership } from '../runs/ownership.js'
import { PUBLIC_PENDING_INTERACTION_SQL, PUBLIC_UNSETTLED_REVIEW_SQL } from '../run-graph/publicObligations.js'
import { CANCELED_INTERACTION_RETIRED_SQL } from './wave25/publication.js'

/** Private native-closure evidence, captured by the coordinator, never an API
 * input or an inference from a terminal business result. No secrets are stored. */
export interface ClosedWorkflowSession {
  execution: Pick<HarnessExecution, 'id' | 'runId' | 'workflowNodeId' | 'agentId' | 'agentConfigurationVersionId'
    | 'attempt' | 'workingDirectory' | 'runtimeDirectory' | 'nativeSessionId'>
  session: NativeSessionReference
  durableGeneration?: string
}

function unsettled(): never {
  throw new DomainError('NATIVE_WORKFLOW_FINALIZATION_PENDING',
    'Stopped workflow finalization requires exact native closure, terminal execution and completed resource cleanup.', 409)
}

const identityKeys = ['id', 'runId', 'workflowNodeId', 'agentId', 'agentConfigurationVersionId',
  'attempt', 'workingDirectory', 'runtimeDirectory', 'nativeSessionId'] as const

/** SQL-only finalization on the actual Run-owner session, AFTER native cleanup
 * and review/interaction retirement have committed. The caller clears the Run
 * cleanup intent only after this commits. A crash or any failed fence leaves
 * that intent retryable. No native call, result rewrite, resume or graph effect.
 * Lock order: parent Run, executions by ID, bound sessions by execution ID.
 */
export async function finalizeStoppedWorkflowSessions(runId: string, owner: RunOwnership,
  readClosure: (executionId: string) => ClosedWorkflowSession | undefined): Promise<void> {
  owner.assertOwned()
  if (owner.runId !== runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Run ownership cannot cross Run identities.', 409)
  const terminalOutcomes = RunOutcomeSchema.options.filter((outcome) => outcome !== 'pending')
  await owner.oneShotConnection().transaction(async (sql) => {
    await owner.readOneShotFence(sql)
    const run = await sql.query<{ terminal: boolean; semantics: string }>(`select
      (execution_state='completed' and record->>'executionState'=execution_state
        and record->>'id'=id and record->>'outcome'=any($2::text[])
        and coalesce(record->>'executionSemanticsVersion','1') in ('1','2','3')) as terminal,
      coalesce(record->>'executionSemanticsVersion','1') as semantics
      from runs where id=$1 for update`, [runId, terminalOutcomes])
    if (run.rows[0]?.terminal !== true) return unsettled()
    const repeat = run.rows[0].semantics === '3'
    if (repeat) {
      const pinned = (await sql.query<{ run: unknown; version: unknown; pins_match: boolean }>(`select r.record as run,v.record as version,
        (r.record->>'workspaceId'=r.workspace_id and r.record->>'workflowId'=r.workflow_id
          and r.record->>'workflowVersionId'=r.workflow_version_id and v.record->>'id'=v.id
          and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id) as pins_match
        from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1`, [runId])).rows[0]
      if (!pinned?.pins_match) return unsettled()
      const value = RepeatRunVersionV1Schema.parse({ run: pinned.run, version: pinned.version })
      if (value.run.id !== runId || value.run.executionState !== 'completed') return unsettled()
    }
    const executions = await sql.query<{ id: string; record: unknown }>(
      'select id,record from harness_executions where run_id=$1 order by id for update', [runId])
    const sessions = await sql.query<{ execution_id: string; reference: unknown; finalized: boolean }>(
      `select s.execution_id,s.reference,s.workflow_finalized_at is not null as finalized
       from execution_native_sessions s join harness_executions e on e.id=s.execution_id
       where e.run_id=$1 order by s.execution_id for update of s`, [runId])
    const byExecution = new Map(sessions.rows.map((row) => [row.execution_id, row]))
    const pending: Array<{ execution: HarnessExecution; session: NativeSessionReference; proof: ClosedWorkflowSession }> = []
    for (const row of executions.rows) {
      const execution = HarnessExecutionSchema.parse(row.record)
      if (execution.id !== row.id || execution.runId !== runId || execution.state !== 'completed'
        || !execution.result || !terminalOutcomes.some((outcome) => outcome === execution.result?.outcome)) return unsettled()
      if (repeat) {
        // An empty coordinator cache after restart is not proof either way.
        // Re-read exact durable closure generations and all per-execution
        // obligations; never synthesize a native acknowledgment or a close.
        await settleRepeatNativeExecutionLocked(sql, runId, execution)
        continue
      }
      const native = byExecution.get(execution.id)
      if (!native) {
        if (execution.nativeSessionId) return unsettled()
        continue // Never create a missing binding or a session for queued work.
      }
      const session = NativeSessionReferenceSchema.parse(native.reference)
      if (execution.nativeSessionId !== session.nativeSessionId) return unsettled()
      if (native.finalized) continue // Preserve the original timestamp on retries.
      const proof = readClosure(execution.id)
      if (!proof || identityKeys.some((key) => proof.execution[key] !== execution[key])
        || proof.session.harness !== session.harness || proof.session.providerVersion !== session.providerVersion
        || proof.session.nativeSessionId !== session.nativeSessionId) return unsettled()
      if (proof.durableGeneration) {
        // Re-read on the same owner transaction while the execution is locked.
        // A fresh preflight invalidates an older proof before any native spawn.
        const durable = await readWorkflowClosure(sql, execution)
        if (durable?.durableGeneration !== proof.durableGeneration) return unsettled()
      }
      pending.push({ execution, session, proof })
    }
    // Use the same durable obligations as save admission, without weakening it
    // or treating Stop/cleanup acceptance as native closure. Include queued jobs
    // by their owning interaction even when no reviewer execution exists yet.
    const obligations = await sql.query<{ outstanding: boolean }>(`select (
      exists (select 1 from worker_credential_bindings b left join management_principals p on p.id=b.principal_id
        where b.run_id=r.id and (b.revoked_at is null or p.id is null or p.revoked_at is null))
      or exists (select 1 from durable_interactions i
        left join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
        left join interaction_graph_resumes g on g.interaction_id=i.id
        where i.run_id=r.id and (e.id is null
          or (r.record->>'executionSemanticsVersion' in ('2','3') and ((${PUBLIC_PENDING_INTERACTION_SQL})
            or (i.status='canceled' and not (${CANCELED_INTERACTION_RETIRED_SQL}))))
          or (coalesce(r.record->>'executionSemanticsVersion','1')='1' and i.status not in ('canceled','delivered'))))
      or exists (select 1 from review_jobs j join durable_interactions i on i.id=j.interaction_id
        where i.run_id=r.id and ((${PUBLIC_UNSETTLED_REVIEW_SQL})
          or j.record->'cleanup'->>'nativeState'='pending' or j.record->'cleanup'->>'credentialState'='pending'))
      ) as outstanding from runs r where r.id=$1`, [runId])
    if (obligations.rows[0]?.outstanding !== false) return unsettled()
    for (const { execution, session, proof } of pending) {
      owner.assertOwned()
      if (readClosure(execution.id) !== proof) return unsettled()
      const updated = await sql.query(`update execution_native_sessions
        set workflow_finalized_at=coalesce(workflow_finalized_at,clock_timestamp())
        where execution_id=$1 and reference=$2::jsonb returning execution_id`, [execution.id, JSON.stringify(session)])
      if (updated.rowCount !== 1) return unsettled()
    }
    // A late create/attach completion invalidates the in-memory closure proof.
    // Lost database ownership or a changed local generation rolls back all rows.
    await owner.readOneShotFence(sql)
    if (pending.some(({ execution, proof }) => readClosure(execution.id) !== proof)) return unsettled()
    owner.assertOwned()
  })
}
