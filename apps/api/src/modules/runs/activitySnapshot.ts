import type pg from 'pg'
import { ActivitySnapshotV1Schema, type ActivitySnapshotV1, type ActivitySourceRevision, type InteractionSummary, type WorkRef, type WorkSummary } from '@graphql/contracts'
import { REPEAT_GRAPH_LIMITS, type WorkflowVersionV3 } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { RUN_ACTIVITIES_BOUNDS_SQL, RUN_ACTIVITIES_PAGE_SQL } from './activities.js'
import { readNativeActivityFacts, projectNativeActivityFacts } from './nativeActivitySnapshot.js'
import { publicRunActivity, type ActivityReadRow } from './activityProjection.js'

type Queryable = Pick<pg.PoolClient, 'query'>
export interface RunActivityScope { workspaceId: string; workflowId: string; runId: string; workflowVersionId: string }
interface RunFact { revision: string; stopped: boolean; outcome: string; execution_state: string; started_at: string | null }
interface ExecutionFact { id: string; attempt: number; revision: string; state: string; outcome: string | null;
  started_at: string | null; native_session_id: string | null; harness: string | null; native_revision: string }
interface InteractionFact { id: string; revision: string; execution_id: string; status: string; delivery: string | null;
  answer_recorded: boolean; harness: string; native_session_id: string; native_request_id: string; worker_acknowledged: boolean; acknowledgment_revision: string | null }

async function facts(sql: Queryable, scope: RunActivityScope) {
  const run = (await sql.query<RunFact>(`select activity_record_revision::text as revision,stop_requested_at is not null as stopped,
    record->>'outcome' as outcome,record->>'startedAt' as started_at,execution_state from runs where id=$1 and workspace_id=$2 and workflow_id=$3 and workflow_version_id=$4`,
  [scope.runId, scope.workspaceId, scope.workflowId, scope.workflowVersionId])).rows[0]
  if (!run) throw new DomainError('RUN_PIN_CONFLICT', 'The exact Run activity scope is unavailable.', 409)
  // Only named normalized identity/status fields cross this read boundary.
  const executions = (await sql.query<ExecutionFact>(`select e.id,e.attempt,e.activity_record_revision::text as revision,
    e.record->>'state' as state,e.record#>>'{result,outcome}' as outcome,e.record->>'startedAt' as started_at,
    e.record->>'nativeSessionId' as native_session_id,c.record#>>'{harness,harness}' as harness,
    coalesce((select max(sequence) from harness_native_events n where n.execution_id=e.id),0)::text as native_revision
    from harness_executions e left join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
      and c.agent_id=e.agent_id and c.workspace_id=$2
    where e.run_id=$1 order by e.created_at,e.id limit 16001`, [scope.runId, scope.workspaceId])).rows
  const interactions = (await sql.query<InteractionFact>(`select i.id,i.revision::text,i.execution_id,i.status,
    i.record->>'deliveryState' as delivery,(i.record->>'decidedAt') is not null as answer_recorded,
    i.harness,i.native_session_id,i.native_request_id,
    exists(select 1 from interaction_graph_resumes g where g.interaction_id=i.id and g.run_id=i.run_id
      and g.execution_id=i.execution_id and g.approval_native_ack_id is not null) as worker_acknowledged,
    (select g.revision::text from interaction_graph_resumes g where g.interaction_id=i.id and g.run_id=i.run_id and g.execution_id=i.execution_id) as acknowledgment_revision
    from durable_interactions i where i.run_id=$1 and i.workspace_id=$2 and i.workflow_id=$3 order by i.id limit 2001`,
  [scope.runId, scope.workspaceId, scope.workflowId])).rows
  if (executions.length > REPEAT_GRAPH_LIMITS.executions || interactions.length > REPEAT_GRAPH_LIMITS.decisions) {
    throw new DomainError('ACTIVITY_SNAPSHOT_TOO_LARGE', 'Use the bounded canonical graph for this Run.', 409)
  }
  const bounds = (await sql.query<{ high_water: string; retained_from: string; observed: number }>(RUN_ACTIVITIES_BOUNDS_SQL, [scope.runId])).rows[0]!
  const revisions: ActivitySourceRevision[] = [{ source: 'scope', id: scope.runId, revision: run.revision },
    { source: 'run_activity', id: scope.runId, revision: bounds.high_water },
    ...executions.flatMap((execution) => [{ source: 'execution' as const, id: execution.id, revision: execution.revision },
      { source: 'native_events' as const, id: execution.id, revision: execution.native_revision }]),
    ...interactions.flatMap((interaction) => [{ source: 'interaction' as const, id: interaction.id, revision: interaction.revision },
      ...(interaction.acknowledgment_revision !== null ? [{ source: 'interaction' as const, id: `ack:${interaction.id}`, revision: interaction.acknowledgment_revision }] : [])])]
  return { run, executions, interactions, bounds, revisions }
}

/** Read on the existing authorized Run transaction. A validated revision vector protects READ COMMITTED callers. */
export async function readRunActivitySnapshot(sql: Queryable, scope: RunActivityScope, version: WorkflowVersionV3): Promise<ActivitySnapshotV1> {
  if (version.id !== scope.workflowVersionId || version.workspaceId !== scope.workspaceId || version.workflowId !== scope.workflowId) {
    throw new DomainError('RUN_PIN_CONFLICT', 'The activity version does not match its immutable Run scope.', 409)
  }
  const before = await facts(sql, scope)
  const ref = (execution: ExecutionFact): WorkRef => ({ kind: 'execution', ...scope, executionId: execution.id, attemptKey: String(execution.attempt) })
  if (before.executions.some((execution) => !['queued', 'starting', 'running', 'waiting', 'completed'].includes(execution.state))) {
    throw new DomainError('ACTIVITY_OWNER_CONFLICT', 'An execution has no authoritative lifecycle state.', 409)
  }
  const summaries: WorkSummary[] = before.executions.map((execution) => ({ ref: ref(execution),
    phase: execution.state === 'completed' ? 'terminal' : before.run.stopped ? 'interrupting'
      : execution.state === 'starting' ? 'preparing' : execution.state === 'waiting' ? 'waiting' : 'active',
    outcome: execution.state === 'completed' && ['succeeded', 'failed', 'canceled'].includes(execution.outcome ?? '')
      ? execution.outcome as WorkSummary['outcome'] : execution.state === 'completed' ? 'unknown' : null,
    evidence: execution.state === 'completed' && !execution.outcome ? 'unknown' : 'confirmed', delivery: null,
    startedAt: execution.started_at,
    ...(execution.native_session_id && execution.harness ? { native: { harness: execution.harness, sessionId: execution.native_session_id } } : {}) }))
  const pendingInteractions: InteractionSummary[] = before.interactions.filter((interaction) => !['delivered', 'canceled'].includes(interaction.status)).flatMap((interaction) => {
    const execution = before.executions.find((entry) => entry.id === interaction.execution_id)
    if (!execution) throw new DomainError('ACTIVITY_OWNER_CONFLICT', 'Interaction lost its exact persisted execution owner.', 409)
    return [{ id: interaction.id, revision: interaction.revision, owner: ref(execution),
      native: { harness: interaction.harness, sessionId: interaction.native_session_id, requestId: interaction.native_request_id },
      delivery: interaction.status === 'pending' ? 'pending' : interaction.delivery === 'uncertain' ? 'uncertain'
        : interaction.status === 'decided' ? 'answer_recorded' : interaction.status === 'delivery_failed' ? 'failed' : 'delivery_pending',
      answerRecorded: interaction.answer_recorded, providerAcknowledged: interaction.delivery === 'delivered',
      workerAcknowledged: interaction.worker_acknowledged, responseAvailability: 'unknown' }]
  })
  const rows = (await sql.query<ActivityReadRow>(RUN_ACTIVITIES_PAGE_SQL.replace('__COMPARATOR__', '<=').replace('__ORDER__', 'desc'),
  [scope.runId, before.bounds.high_water, before.bounds.high_water, before.bounds.retained_from, 101])).rows
  const selected = rows.slice(0, 100).reverse()
  const activities = selected.flatMap((row) => {
    const publicItem = publicRunActivity(row, version, scope.runId, before.run.outcome)
    const execution = before.executions.find((entry) => entry.id === row.harness_execution_id)
    // Run-level audit rows retain their genuine Run owner; never borrow the latest execution.
    const owner: WorkRef = execution ? ref(execution) : { kind: 'run', ...scope }
    return [{ kind: 'diagnostic' as const, id: publicItem.id, revision: '0', order: row.sequence, orderSource: 'run_activity', owner,
      source: { schemaVersion: 1, system: 'run_activity', eventId: publicItem.id, sequence: row.sequence, observedAt: row.occurred_at.toISOString() },
      evidence: publicItem.status === 'unknown' ? 'unknown' : 'confirmed', code: publicItem.kind, message: publicItem.summary }]
  })
  const nativeWork = projectNativeActivityFacts(await readNativeActivityFacts(sql, scope.runId), (executionId) => {
    const execution = before.executions.find((entry) => entry.id === executionId)
    if (!execution) throw new DomainError('ACTIVITY_OWNER_CONFLICT', 'Native item lost its exact execution scope.', 409)
    return { owner: ref(execution), harness: execution.harness, sessionId: execution.native_session_id, terminal: execution.state === 'completed' }
  })
  const after = await facts(sql, scope)
  if (JSON.stringify(before.revisions) !== JSON.stringify(after.revisions)) throw new DomainError('ACTIVITY_SNAPSHOT_CONFLICT',
    'Activity source revisions changed during read. Refresh this exact Run.', 409)
  const activeExecutions = summaries.filter((summary, index) => before.executions[index]!.state !== 'queued' && summary.phase !== 'terminal')
  const runRef: WorkRef = { kind: 'run', ...scope }
  const runWork: WorkSummary[] = activeExecutions.length === 0 && ['running', 'waiting', 'interrupted'].includes(before.run.execution_state)
    ? [{ ref: runRef, phase: before.run.stopped ? 'interrupting' : before.run.execution_state === 'waiting' ? 'waiting' : 'preparing',
      outcome: null, delivery: null, evidence: before.run.execution_state === 'interrupted' ? 'reconciling' : 'confirmed', startedAt: before.run.started_at ?? null }] : []
  return ActivitySnapshotV1Schema.parse({ schemaVersion: 1, scope: { kind: 'workflow_run', ...scope }, revision: before.run.revision,
    sourceRevisions: before.revisions,
    active: [...activeExecutions, ...runWork, ...nativeWork.active],
    ...(nativeWork.hasMore ? { hasMoreActiveWork: true } : {}),
    queued: before.executions.length === 0 && before.run.execution_state === 'queued' ? [runRef] : before.executions.filter((execution) => execution.state === 'queued').map(ref),
    latest: before.executions.length ? ref(before.executions[before.executions.length - 1]!) : runRef,
    pendingInteractions, activities: [...activities, ...nativeWork.activities],
    // This scoped cursor is an audit sequence, never a cross-scope/browser cursor.
    page: { before: null, nextCursor: rows.length > 100 ? selected[0]!.sequence : null, hasMore: rows.length > 100 } })
}
