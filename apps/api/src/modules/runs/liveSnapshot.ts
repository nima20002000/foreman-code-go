import {
  GetRunResponseSchema, HarnessExecutionSchema, ReviewJobSchema, WorkflowRunSchema, WorkflowVersionSchema,
  type GetRunResponse,
} from '@graphql/contracts'
import type pg from 'pg'
import { RunCurrentRequestSchema, RunCurrentResponseSchema, type RunCurrentRequest, type RunCurrentResponse } from '@graphql/contracts/run-current'
import { DomainError } from '../errors.js'
import { projectRunLiveActivity, type LiveActivityEvent } from './liveActivity.js'

/** A single MVCC snapshot: status, native evidence and review ownership cannot come from different polls. */
export async function readRunDetails(pool: pg.Pool, workspaceId: string, runId: string): Promise<GetRunResponse | undefined> {
  const result = await pool.query<{
    run: unknown; version: unknown; executions: unknown[]; events: LiveActivityEvent[]; cleanup_pending: boolean
    reviews: Array<{ executionId: string; record: unknown }>
  }>(
    `select r.record as run, v.record as version,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending,
      coalesce((select jsonb_agg(e.record order by e.created_at,e.id)
        from harness_executions e where e.run_id=r.id),'[]'::jsonb) as executions,
      coalesce((select jsonb_agg(jsonb_build_object(
        'runId',a.run_id,'sequence',a.sequence::text,'source',a.source,'kind',a.kind,
        'harnessExecutionId',a.harness_execution_id,'occurredAt',a.occurred_at,'payload',a.payload,
        'native',case when n.execution_id is null then null else jsonb_build_object(
          'type',n.record->>'type','connectionId',n.connection_id,
          'sourceSequence',coalesce(n.source_sequence,n.sequence)::text,
          'payload',jsonb_build_object(
            'turnId',n.record->'payload'->'turnId','turn',jsonb_build_object(
              'id',n.record->'payload'->'turn'->'id'),
            'nativeTurnStatus',n.record->'payload'->'nativeTurnStatus',
            'item',jsonb_build_object(
              'id',n.record->'payload'->'item'->'id','type',n.record->'payload'->'item'->'type',
              'status',n.record->'payload'->'item'->'status',
              'error',coalesce(n.record->'payload'->'item'->'error','null'::jsonb) <> 'null'::jsonb,
              'server',n.record->'payload'->'item'->'server','tool',n.record->'payload'->'item'->'tool',
              'commandActions',case when jsonb_typeof(n.record->'payload'->'item'->'commandActions')='array'
                then (select jsonb_agg(jsonb_build_object('type',action->'type'))
                  from jsonb_array_elements(n.record->'payload'->'item'->'commandActions') action)
                else '[]'::jsonb end),
            'info',jsonb_build_object(
              'id',n.record->'payload'->'info'->'id','role',n.record->'payload'->'info'->'role',
              'parentID',n.record->'payload'->'info'->'parentID','sessionID',n.record->'payload'->'info'->'sessionID',
              'summary',n.record->'payload'->'info'->'summary'),
            'part',jsonb_build_object(
              'id',n.record->'payload'->'part'->'id','type',n.record->'payload'->'part'->'type',
              'messageID',n.record->'payload'->'part'->'messageID','tool',n.record->'payload'->'part'->'tool',
              'state',jsonb_build_object('status',n.record->'payload'->'part'->'state'->'status'))
          )) end) order by a.sequence)
        from run_activity a left join harness_native_events n
          on n.execution_id=a.harness_execution_id and a.source='harness' and a.kind='harness_output'
          and n.sequence=case when (a.payload->>'nativeEventSequence') ~ '^[0-9]{1,10}$'
            then (a.payload->>'nativeEventSequence')::bigint else null end
        where a.run_id=r.id),'[]'::jsonb) as events,
      coalesce((select jsonb_agg(jsonb_build_object('executionId',j.execution_id,'record',j.record))
        from review_jobs j join harness_executions e on e.id=j.execution_id
        where e.run_id=r.id),'[]'::jsonb) as reviews
     from runs r join workflow_versions v on v.id=r.workflow_version_id
       and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
     where r.workspace_id=$1 and r.id=$2`,
    [workspaceId, runId],
  )
  const row = result.rows[0]
  if (!row) return undefined
  const run = WorkflowRunSchema.parse(row.run)
  const version = WorkflowVersionSchema.parse(row.version)
  if (run.id !== runId || run.workspaceId !== workspaceId || version.id !== run.workflowVersionId
    || version.workspaceId !== workspaceId || version.workflowId !== run.workflowId
    || version.definition.id !== run.workflowId || version.definition.workspaceId !== workspaceId) {
    throw new DomainError('RUN_IDENTITY_INVALID', 'The saved Run and workflow version do not match.', 409)
  }
  const executions = row.executions.map((value) => HarnessExecutionSchema.parse(value))
  const reviews = row.reviews.flatMap((value) => {
    const parsed = ReviewJobSchema.safeParse(value.record)
    return parsed.success ? [{ executionId: value.executionId, job: parsed.data }] : []
  })
  return GetRunResponseSchema.parse({
    run, executions, cleanupPending: row.cleanup_pending,
    activity: row.events.map((event) => ({
      id: `activity-${run.id}-${event.sequence}`, runId: run.id, sequence: Number(event.sequence),
      source: event.source, kind: event.kind,
      ...(event.harnessExecutionId ? { harnessExecutionId: event.harnessExecutionId } : {}),
      occurredAt: new Date(event.occurredAt).toISOString(), payload: event.payload,
    })),
    liveActivity: projectRunLiveActivity({ run, definition: version.definition, executions, events: row.events, reviews }),
  })
}

/**
 * Current compatibility facts from one MVCC statement. The only activity access
 * is an indexed high-water seek: no payloads, count, native join or replay.
 * The existing (run_id, workflow_node_id, attempt) unique index bounds each
 * latest-attempt seek; attempts/results are not accumulated in the response.
 * Authorization belongs to RunManagementService.current, before this read.
 */
export async function readRunCurrent(pool: Pick<pg.Pool, 'query'>, input: RunCurrentRequest): Promise<RunCurrentResponse | undefined> {
  const scope = RunCurrentRequestSchema.parse(input)
  const result = await pool.query<{
    run: RunCurrentResponse['run']; executions: RunCurrentResponse['executions']; cleanup_pending: boolean
    sequence: string; run_semantics: unknown; version_semantics: unknown; version_pin: number; definition_semantics: unknown
    version_id: string; version_workspace_id: string; version_workflow_id: string
    definition_id: string; definition_workspace_id: string; node_ids: string[]; nodes_valid: boolean; identities_valid: boolean
  }>(
    `select jsonb_strip_nulls(jsonb_build_object(
        'id',r.record->'id','workspaceId',r.record->'workspaceId','workflowId',r.record->'workflowId',
        'workflowVersionId',r.record->'workflowVersionId','executionState',r.record->'executionState',
        'outcome',r.record->'outcome','stopCause',r.record->'stopCause',
        'createdAt',r.record->'createdAt','startedAt',r.record->'startedAt','finishedAt',r.record->'finishedAt')) as run,
      coalesce(r.record->'executionSemanticsVersion','1'::jsonb) as run_semantics,
      coalesce(v.record->'executionSemanticsVersion','1'::jsonb) as version_semantics,
      v.execution_semantics_version as version_pin,
      coalesce(v.record->'definition'->'executionSemanticsVersion','1'::jsonb) as definition_semantics,
      v.record->>'id' as version_id, v.record->>'workspaceId' as version_workspace_id,
      v.record->>'workflowId' as version_workflow_id,
      v.record->'definition'->>'id' as definition_id,
      v.record->'definition'->>'workspaceId' as definition_workspace_id,
      jsonb_typeof(v.record->'definition'->'nodes')='array' as nodes_valid,
      (select coalesce(jsonb_agg(node->'id'),'[]'::jsonb)
        from jsonb_array_elements(v.record->'definition'->'nodes') node) as node_ids,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending,
      coalesce((select a.sequence::text from run_activity a
        where a.run_id=r.id order by a.sequence desc limit 1),'0') as sequence,
      latest.executions, latest.identities_valid
     from runs r join workflow_versions v on v.id=r.workflow_version_id
       and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
     cross join lateral (
       select coalesce(jsonb_agg(jsonb_build_object(
         'id',e.record->'id','runId',e.record->'runId','workflowNodeId',e.record->'workflowNodeId',
         'attempt',e.record->'attempt','state',e.record->'state') order by node.ordinality),'[]'::jsonb) as executions,
         coalesce(bool_and(coalesce(e.record->>'id'=e.id and e.record->>'runId'=r.id
           and e.record->>'workflowNodeId'=node.value->>'id'
           and e.record->>'attempt'=e.attempt::text,false)),true) as identities_valid
       from jsonb_array_elements(v.record->'definition'->'nodes') with ordinality node(value,ordinality)
       cross join lateral (select e.id,e.attempt,e.record from harness_executions e
         where e.run_id=r.id and e.workflow_node_id=node.value->>'id'
         order by e.attempt desc limit 1) e
     ) latest
     where r.workspace_id=$1 and r.workflow_id=$2 and r.id=$3 and r.workflow_version_id=$4`,
    [scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId],
  )
  const row = result.rows[0]
  if (!row) return undefined
  if (row.run_semantics !== 1 || row.version_semantics !== 1 || row.version_pin !== 1 || row.definition_semantics !== 1) {
    throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'The compatibility read requires saved semantics 1.', 409)
  }
  if (row.run.id !== scope.runId || row.run.workspaceId !== scope.workspaceId || row.run.workflowId !== scope.workflowId
    || row.run.workflowVersionId !== scope.workflowVersionId || row.version_id !== scope.workflowVersionId
    || row.version_workspace_id !== scope.workspaceId || row.version_workflow_id !== scope.workflowId
    || row.definition_id !== scope.workflowId || row.definition_workspace_id !== scope.workspaceId
    || !row.identities_valid || !row.nodes_valid || !Array.isArray(row.node_ids)
    || row.node_ids.some((id) => typeof id !== 'string' || !id.length)
    || new Set(row.node_ids).size !== row.node_ids.length) {
    throw new DomainError('RUN_IDENTITY_INVALID', 'The saved Run, workflow version and current attempts do not match.', 409)
  }
  return RunCurrentResponseSchema.parse({
    kind: 'legacy-run-current', executionSemanticsVersion: 1, run: row.run, executions: row.executions,
    executionCoverage: 'latest-attempt-per-pinned-node', cleanupPending: row.cleanup_pending,
    settlement: 'unconfirmed', history: 'not-included', asOfActivitySequence: row.sequence,
  })
}
