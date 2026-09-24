import type pg from 'pg'
import { RunOutcomeSchema } from '@graphql/contracts'
import { GraphEditRunPinSchema, GraphEditRunStateSchema, type GraphEditRunState } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { CANCELED_INTERACTION_RETIRED_SQL } from '../interactions/wave25/publication.js'
import { PUBLIC_PENDING_INTERACTION_SQL, PUBLIC_UNSETTLED_REVIEW_SQL } from '../run-graph/publicObligations.js'

export interface AffectedGraphScope { workspaceId: string; workflowId: string; stagedAgentIds: readonly string[] }
const affected = `r.workspace_id=$1
  and (r.workflow_id=$2 or r.record->'agentConfigurationVersionIds' ?| $3::text[]
    or exists (select 1 from workflow_versions affected_version where affected_version.id=r.workflow_version_id
      and affected_version.record->'agentConfigurationVersionIds' ?| $3::text[]))`
const invalidTerminal = `r.execution_state<>'completed'
  or r.record->>'executionState' is distinct from r.execution_state
  or r.record->>'outcome' is null or not (r.record->>'outcome'=any($4::text[]))
  or r.record->>'id' is distinct from r.id
  or r.record->>'workspaceId' is distinct from r.workspace_id
  or r.record->>'workflowId' is distinct from r.workflow_id
  or r.record->>'workflowVersionId' is distinct from r.workflow_version_id
  or coalesce(r.record->>'executionSemanticsVersion','1') not in ('1','2')
  or not exists (select 1 from workflow_versions v where v.id=r.workflow_version_id
    and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
    and v.execution_semantics_version::text=coalesce(r.record->>'executionSemanticsVersion','1')
    and v.record->>'id'=v.id and v.record->>'workspaceId'=r.workspace_id and v.record->>'workflowId'=r.workflow_id
    and v.record->'agentConfigurationVersionIds'=r.record->'agentConfigurationVersionIds')`
const cleanup = `exists (select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)`
// Native finalization and credential closure are durable lifecycle facts, not a
// guess from a terminal business outcome or a Stop acceptance receipt.
const native = `exists (select 1 from harness_executions e where e.run_id=r.id and (
    e.record->>'state' is distinct from 'completed'
    or e.record->'result'->>'outcome' is null or not (e.record->'result'->>'outcome'=any($4::text[]))
    or (e.record->>'nativeSessionId' is not null and not exists (
      select 1 from execution_native_sessions s where s.execution_id=e.id
        and s.reference->>'nativeSessionId'=e.record->>'nativeSessionId' and s.workflow_finalized_at is not null))
    or exists (select 1 from execution_native_sessions s where s.execution_id=e.id and s.workflow_finalized_at is null)
  )) or exists (select 1 from worker_credential_bindings b where b.run_id=r.id and b.revoked_at is null)`
const interactions = `exists (
  select 1 from durable_interactions i
  left join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
  left join interaction_graph_resumes g on g.interaction_id=i.id
  where i.run_id=r.id and (e.id is null or
    (r.record->>'executionSemanticsVersion'='2' and ((${PUBLIC_PENDING_INTERACTION_SQL})
      or (i.status='canceled' and not (${CANCELED_INTERACTION_RETIRED_SQL}))))
    or (coalesce(r.record->>'executionSemanticsVersion','1')='1' and i.status not in ('canceled','delivered')))
)`
// A queued review may not have an execution ID yet. Its owning interaction,
// not an optional launched execution, determines the affected Run.
const reviews = `exists (select 1 from review_jobs j join durable_interactions review_owner on review_owner.id=j.interaction_id
  where review_owner.run_id=r.id and ((${PUBLIC_UNSETTLED_REVIEW_SQL})
    or j.record->'cleanup'->>'nativeState'='pending' or j.record->'cleanup'->>'credentialState'='pending'))`
const values = (input: AffectedGraphScope) => [input.workspaceId, input.workflowId,
  [...new Set(input.stagedAgentIds)].sort(), RunOutcomeSchema.options.filter((outcome) => outcome !== 'pending')]

/** Caller holds workspace admission + workflow locks until COMMIT. Same
 * predicate as planning; no selected-Run shortcut, paging, history or mutation. */
export async function assertMeaningfulSaveAdmitted(client: Pick<pg.PoolClient, 'query'>, input: AffectedGraphScope): Promise<void> {
  const blocked = await client.query<{ blocked: boolean }>(`select exists (
    select 1 from runs r where ${affected} and (
      ${invalidTerminal} or ${cleanup} or ${native} or ${interactions} or ${reviews}
    )
  ) as blocked`, values(input))
  // Do not disclose Run identities to a caller with graph:save but no runs:read.
  if (blocked.rows[0]?.blocked !== false) throw new DomainError('WORKFLOW_RUNS_UNSETTLED',
    'Meaningful edits cannot be published while an affected Run is active or has unresolved native, cleanup, interaction or review obligations. The draft is retained; Stop acceptance alone is not settlement.', 409)
}

/** Read-only plan/readback. Caller must authorize every returned exact scope
 * before returning ANY of it. One MVCC statement reads all current facts. */
export async function readAffectedGraphRuns(client: Pick<pg.PoolClient, 'query'>, input: AffectedGraphScope): Promise<GraphEditRunState[]> {
  const rows = await client.query<{
    id: string; workspace_id: string; workflow_id: string; workflow_version_id: string; record: Record<string, unknown>;
    terminal: boolean; cleanup: boolean; native: boolean; interactions: boolean; reviews: boolean
  }>(`select r.id,r.workspace_id,r.workflow_id,r.workflow_version_id,r.record,
    not (${invalidTerminal}) as terminal, ${cleanup} as cleanup, (${native}) as native,
    ${interactions} as interactions, ${reviews} as reviews
    from runs r where ${affected} order by r.id`, values(input))
  return rows.rows.map((row) => {
    const pin = GraphEditRunPinSchema.parse({ workspaceId: row.workspace_id, workflowId: row.workflow_id,
      runId: row.id, workflowVersionId: row.workflow_version_id,
      executionSemanticsVersion: row.record.executionSemanticsVersion ?? 1,
      agentConfigurationVersionIds: row.record.agentConfigurationVersionIds })
    // Missing/corrupt flags are never interpreted as settlement.
    const terminal = row.terminal === true
    const cleanupPending = row.cleanup !== false, nativePending = row.native !== false
    const interactionPending = row.interactions !== false, reviewPending = row.reviews !== false
    return GraphEditRunStateSchema.parse({ pin, terminal, outcome: row.record.outcome,
      settled: terminal && !cleanupPending && !nativePending && !interactionPending && !reviewPending,
      cleanupPending, nativePending, interactionPending, reviewPending })
  })
}
