import {
  GetRunResponseSchema, HarnessExecutionSchema, ReviewJobSchema, WorkflowRunSchema, WorkflowVersionSchema,
  type GetRunResponse,
} from '@graphql/contracts'
import type pg from 'pg'
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
