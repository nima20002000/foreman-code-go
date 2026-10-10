import type pg from 'pg'
import { z } from 'zod'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { GraphSequenceSchema, RunActivitiesInputSchema, RunActivitiesPageSchema,
  RUN_ACTIVITIES_RETAINED, RUN_ACTIVITIES_PAGE_BYTES,
  canonicalGraphJson, graphJsonBytes, type RunActivitiesPage } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { withCurrentRunRead } from './currentRead.js'
import { publicRunActivity, type ActivityReadRow } from './activityProjection.js'

/** The original Run audit remains immutable. Activities expose its latest 1000
 * rows and make a cursor outside that bounded window explicitly expire. */
export { RUN_ACTIVITIES_RETAINED } from '@foreman-code/contracts/wave25'
export const RUN_ACTIVITIES_BOUNDS_SQL = `with recent as materialized (
  select sequence from run_activity where run_id=$1 order by sequence desc limit 1001
), retained as (select sequence from recent order by sequence desc limit 1000)
select coalesce((select max(sequence) from recent),0)::text as high_water,
  coalesce((select min(sequence) from retained),0)::text as retained_from,
  (select count(*) from recent)::integer as observed`

/** Extract protocol metadata and recorded work results without native provider bodies. */
export const RUN_ACTIVITIES_PAGE_SQL = `select a.sequence::text,a.source,a.kind,a.occurred_at,a.harness_execution_id,
  coalesce(e.workflow_node_id,j.record#>>'{workflow,nodeId}') as execution_node_id,e.agent_id as execution_agent_id,
  coalesce(e.attempt,x.technical_attempt) as execution_attempt,e.work_activation_id,
  j.id as job_execution_id,j.attempt_id as job_attempt_id,j.operation_id as job_operation_id,
  cq.id::text as ci_ticket_id,cq.execution_id as ci_execution_id,
  cq.attempt_id as ci_attempt_id,cq.operation_id as ci_operation_id,
  w.node_execution_id,j.accepted_spec->>'definitionId' as job_definition_id,
  (j.accepted_spec->>'definitionRevision')::integer as job_definition_revision,
  j.accepted_spec->>'definitionVersionId' as job_definition_version_id,
  coalesce(e.record#>>'{result,outcome}',case when j.record#>>'{process,phase}'='terminal'
    then case j.record#>>'{process,outcome}' when 'succeeded' then 'succeeded' when 'cancelled' then 'canceled' else 'failed' end end) as result_outcome,
  case when a.kind in ('result_recorded','work_result_accepted','work_needs_direction')
    then e.record->'result' end as work_result,
  jsonb_strip_nulls(jsonb_build_object(
    'continuedFromExecutionId',e.record#>>'{sessionContinuation,previousExecutionId}',
    'executionState',a.payload->>'executionState','state',a.payload->>'state',
    'status',a.payload->>'status','deliveryState',a.payload->>'deliveryState',
    'selectedSemantic',a.payload->>'selectedSemantic',
    'outcome',a.payload->>'outcome','failed',a.payload->'failed','suite',a.payload->>'suite',
    'actorName',(select captured->>'name' from jsonb_array_elements(s.record->'nodes') captured
      where captured->>'id'=coalesce(e.workflow_node_id,j.record#>>'{workflow,nodeId}')),
    'subjectName',(select captured->>'name' from jsonb_array_elements(s.record->'nodes') captured
      where captured->>'id'=case when a.kind='work_requester_reactivated' then a.payload->>'requesterNodeId'
        when a.kind like 'work_limit_notice_%' or a.kind='work_rerouted' then a.payload->>'destinationNodeId' end),
    'activationId',case when exists(select 1 from run_work_activations w
      where w.run_id=a.run_id and w.activation_id=a.payload->>'activationId')
      then a.payload->>'activationId' end,
    'requestId',case when exists(select 1 from run_work_requests w
      where w.run_id=a.run_id and w.request_id=a.payload->>'requestId')
      then a.payload->>'requestId' end,
    'returnId',case when exists(select 1 from run_work_returns w
      where w.run_id=a.run_id and w.return_id=a.payload->>'returnId')
      then a.payload->>'returnId' end,
    'denialId',case when exists(select 1 from run_work_denials w
      where w.run_id=a.run_id and w.denial_id=a.payload->>'denialId')
      then a.payload->>'denialId' end,
    'noticeId',case when exists(select 1 from run_work_notices w
      where w.run_id=a.run_id and w.notice_id=a.payload->>'noticeId')
      then a.payload->>'noticeId' end,
    'unresolvedId',case when exists(select 1 from run_work_unresolved w
      where w.run_id=a.run_id and w.unresolved_id=a.payload->>'unresolvedId')
      then a.payload->>'unresolvedId' end,
    'relationshipId',a.payload->>'relationshipId',
    'fromRelationshipId',a.payload->>'fromRelationshipId',
    'requesterNodeId',a.payload->>'requesterNodeId',
    'destinationNodeId',a.payload->>'destinationNodeId',
    'interactionId',case when exists(select 1 from durable_interactions i
      where i.run_id=a.run_id and i.id=a.payload->>'interactionId')
      then a.payload->>'interactionId' end,
    'reviewJobId',case when exists(select 1 from review_jobs j
      join durable_interactions i on i.id=j.interaction_id and i.run_id=a.run_id
      where j.id=a.payload->>'reviewJobId') then a.payload->>'reviewJobId' end,
    'acknowledgementId',case when exists(select 1 from interaction_graph_resumes g
      where g.run_id=a.run_id and g.interaction_id=a.payload->>'interactionId'
        and g.approval_native_ack_id=a.payload->>'acknowledgementId')
      then a.payload->>'acknowledgementId' end,
    'nativeEventSequence',a.payload->'nativeEventSequence',
    'used',a.payload->'used','maximum',a.payload->'maximum')) as safe_payload,
  case when n.execution_id is null then null else jsonb_strip_nulls(jsonb_build_object(
    'type',left(n.record->>'type',48),
    'subagent',case when n.record->>'subagent'='true' then true end,
    'nativeMethod',left(n.record#>>'{payload,nativeMethod}',100),
    'turnStatus',left(n.record#>>'{payload,turn,status}',48),
    'unsupportedInteractionCode',case when n.record->>'type'='interaction.unsupported'
      then left(n.record#>>'{payload,code}',100) end,
    'itemType',left(n.record#>>'{payload,item,type}',48),
    'toolName',left(n.record#>>'{payload,item,tool}',64),
    'commandName',substring(n.record#>>'{payload,item,command}' from '^[[:space:]]*([A-Za-z0-9_./-]+)'),
    'itemStatus',left(n.record#>>'{payload,item,status}',48),
    'itemError',coalesce(n.record#>'{payload,item,error}' <> 'null'::jsonb,false)
      or (n.record#>>'{payload,item,type}'='dynamicToolCall'
        and coalesce(n.record#>'{payload,item,success}'='false'::jsonb,false)),
    'messagePhase',left(n.record#>>'{payload,item,phase}',48),
    'exitCode',case when jsonb_typeof(n.record#>'{payload,item,exitCode}')='number'
      then n.record#>'{payload,item,exitCode}' end,
    'fileChangeCount',case when jsonb_typeof(n.record#>'{payload,item,changes}')='array'
      then jsonb_array_length(n.record#>'{payload,item,changes}') end,
    'deltaLength',case when jsonb_typeof(n.record#>'{payload,delta}')='string'
      then length(n.record#>>'{payload,delta}') end,
    'partTool',left(n.record#>>'{payload,part,tool}',48),
    'partStatus',left(n.record#>>'{payload,part,state,status}',48),
    'claudeItemId',case when n.record->>'type'='claude.tool' then n.record#>>'{payload,itemId}' end,
    'claudeTaskId',case when n.record->>'type'='claude.task' then n.record#>>'{payload,taskId}' end,
    'claudeName',case when n.record->>'type'='claude.tool' then n.record#>>'{payload,name}' end,
    'claudeStatus',case when n.record->>'type' in ('claude.tool','claude.task') then n.record#>>'{payload,status}' end)) end as native
from run_activity a
left join harness_executions e on e.id=a.harness_execution_id and e.run_id=a.run_id
left join runs r on r.id=a.run_id
left join job_admission_queue cq on a.kind='ci_state_changed' and cq.id::text=a.payload->>'ticketId'
  and cq.workspace_id=r.workspace_id and cq.execution_id=a.payload->>'jobExecutionId'
  and cq.attempt_id=a.payload->>'jobAttemptId' and cq.operation_id=a.payload->>'jobOperationId'
  and cq.record #>> '{initiatingAgent,runId}'=r.id
  and cq.record #>> '{initiatingAgent,workflowId}'=r.workflow_id
  and cq.record #>> '{initiatingAgent,executionId}'=e.id
  and cq.record #>> '{initiatingAgent,agentId}'=e.agent_id
left join run_board_snapshots s on s.run_id=r.id and s.workspace_id=r.workspace_id
  and s.workflow_id=r.workflow_id and s.workflow_version_id=r.workflow_version_id
left join workflow_job_executions w on w.run_id=a.run_id and w.job_execution_id=a.payload->>'jobExecutionId'
left join run_repeat_executions x on x.run_id=w.run_id and x.execution_id=w.node_execution_id and x.executor_kind='job'
left join job_executions j on j.id=w.job_execution_id and j.id=w.node_execution_id and j.workspace_id=r.workspace_id
  and j.record#>>'{workflow,runId}'=a.run_id and j.record#>>'{workflow,workflowId}'=r.workflow_id
  and j.record#>>'{workflow,nodeExecutionId}'=w.node_execution_id and j.record#>>'{workflow,nodeId}'=x.workflow_node_id
  and j.accepted_spec=j.record->'acceptedSpec' and j.attempt_id=j.record->>'attemptId' and j.operation_id=j.record->>'operationId'
  and w.reference->>'workspaceId'=r.workspace_id and w.reference->>'workflowVersionId'=r.workflow_version_id
  and w.reference->>'runId'=a.run_id and w.reference->>'workflowId'=r.workflow_id
left join lateral (
  -- Child-thread notifications wrap the item in params; present them in the parent's shape, marked as subagent work.
  select n0.execution_id,case when n0.record->>'type'='native.unlinked_notification'
      and jsonb_typeof(n0.record#>'{payload,params}')='object' then jsonb_build_object(
        'type',case n0.record#>>'{payload,method}' when 'item/started' then 'item.started' when 'item/completed' then 'item.completed'
          when 'turn/started' then 'turn.started' when 'turn/completed' then 'turn.completed' else 'native.notification' end,
        'subagent',true,'payload',(n0.record#>'{payload,params}') || jsonb_build_object('nativeMethod',n0.record#>>'{payload,method}'))
    else n0.record end as record
  from harness_native_events n0 where n0.execution_id=a.harness_execution_id
    and n0.sequence=case when a.kind='harness_output'
      and (a.payload->>'nativeEventSequence') ~ '^[0-9]{1,9}$'
      then (a.payload->>'nativeEventSequence')::integer end) n on true
where a.run_id=$1 and a.sequence __COMPARATOR__ $2::bigint and a.sequence<=$3::bigint
  and a.sequence>=$4::bigint
order by a.sequence __ORDER__ limit $5`

const Cursor = z.object({ version: z.literal(1), runId: z.string().min(1).max(200),
  workflowVersionId: z.string().min(1).max(200), mode: z.enum(['older','newer']),
  position: GraphSequenceSchema, through: GraphSequenceSchema }).strict()
type CursorValue = z.infer<typeof Cursor>
const invalid = (code: string, message: string, status = 409): never => { throw new DomainError(code, message, status) }
function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(Cursor.parse(value))).toString('base64url')
}
function decodeCursor(value: string): CursorValue {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid('ACTIVITIES_CURSOR_INVALID', 'The Activities cursor is invalid.', 400)
    return Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch { return invalid('ACTIVITIES_CURSOR_INVALID', 'The Activities cursor is invalid.', 400) }
}

export class RunActivitiesService {
  constructor(private readonly pool: pg.Pool) {}

  async read(principal: ManagementPrincipal, raw: unknown): Promise<RunActivitiesPage> {
    const input = RunActivitiesInputSchema.parse(raw)
    try { return await withCurrentRunRead(this.pool, principal, input.workspaceId, input.runId, 'runs:read',
      async (sql, snapshot) => {
        const { run, version } = snapshot
        const scope = { workspaceId: run.workspaceId, workflowId: run.workflowId,
          runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 as const }
        const bounds = (await sql.query<{ high_water: string; retained_from: string; observed: number }>(
          RUN_ACTIVITIES_BOUNDS_SQL, [run.id])).rows[0]
        if (!bounds) return invalid('ACTIVITIES_UNAVAILABLE', 'The Run activity bounds are unavailable.', 503)
        const currentHigh = BigInt(bounds.high_water), floor = BigInt(bounds.retained_from)
        const cursor = input.cursor ? decodeCursor(input.cursor) : undefined
        if (cursor && (cursor.runId !== run.id || cursor.workflowVersionId !== version.id)) {
          return invalid('ACTIVITIES_CURSOR_SCOPE_CONFLICT', 'The cursor belongs to another Run or version.')
        }
        if (cursor) {
          const position = BigInt(cursor.position), through = BigInt(cursor.through)
          if (position>currentHigh || through>currentHigh
            || cursor.mode === 'older' && (through===0n || position>through)
            || cursor.mode === 'newer' && through!==0n && position>through) {
            return invalid('ACTIVITIES_CURSOR_INVALID', 'The Activities cursor is outside the Run history.', 400)
          }
          if (position !== 0n) {
            const anchor = await sql.query('select 1 from run_activity where run_id=$1 and sequence=$2::bigint',
              [run.id, cursor.position])
            if (anchor.rowCount !== 1 || position<floor) return invalid('ACTIVITIES_CURSOR_EXPIRED',
              'The Activities cursor is no longer retained. Reload this Run.', 410)
          } else if (bounds.observed > RUN_ACTIVITIES_RETAINED) return invalid('ACTIVITIES_CURSOR_EXPIRED',
            'The Activities cursor is no longer retained. Reload this Run.', 410)
          if (through!==0n && through<floor) return invalid('ACTIVITIES_CURSOR_EXPIRED',
            'The Activities snapshot is no longer retained. Reload this Run.', 410)
        }
        const mode = cursor?.mode ?? 'initial'
        const through = cursor?.through && cursor.through !== '0' ? cursor.through : bounds.high_water
        const position = cursor?.position ?? through
        const descending = mode !== 'newer'
        const rows = (await sql.query<ActivityReadRow>(RUN_ACTIVITIES_PAGE_SQL.replace('__COMPARATOR__',
          mode === 'initial' ? '<=' : descending ? '<' : '>')
          .replace('__ORDER__', descending ? 'desc' : 'asc'),
        [run.id, position, through, bounds.retained_from, input.limit + 1])).rows
        const selected = rows.slice(0, input.limit)
        if (descending) selected.reverse()
        const items = selected.map((row) => publicRunActivity(row, version, run.id, run.outcome))
        const pageFor = (count: number): RunActivitiesPage => {
          const pageItems = descending ? items.slice(items.length - count) : items.slice(0, count)
          const hasMore = rows.length > count
          const first = pageItems[0]?.sequence
          const last = pageItems.at(-1)?.sequence
          const olderCursor = descending && hasMore && first ? encodeCursor({ version: 1,
            runId: run.id, workflowVersionId: version.id, mode: 'older', position: first, through }) : null
          const nextCursor = encodeCursor({ version: 1, runId: run.id,
            workflowVersionId: version.id, mode: 'newer',
            position: mode === 'newer' && hasMore && last ? last : through,
            through: mode === 'newer' && hasMore ? through : '0' })
          return RunActivitiesPageSchema.parse({ scope, items: pageItems, mode,
            highWater: through, retainedFrom: bounds.retained_from, nextCursor, olderCursor, hasMore })
        }
        let page = pageFor(items.length)
        if (graphJsonBytes(page) > RUN_ACTIVITIES_PAGE_BYTES) {
          let minimum = 1
          let maximum = items.length - 1
          page = pageFor(1)
          while (minimum <= maximum) {
            const count = Math.floor((minimum + maximum) / 2)
            const candidate = pageFor(count)
            if (graphJsonBytes(candidate) <= RUN_ACTIVITIES_PAGE_BYTES) {
              page = candidate
              minimum = count + 1
            } else maximum = count - 1
          }
        }
        canonicalGraphJson(page, RUN_ACTIVITIES_PAGE_BYTES)
        return page
      })
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DomainError(
        'ACTIVITIES_EVIDENCE_CONFLICT', 'Persisted Run activity evidence is invalid or unavailable.', 409)
      if (error instanceof Error && error.message === 'GRAPH_JSON_LIMIT') throw new DomainError(
        'ACTIVITIES_PAGE_TOO_LARGE', 'The Activities page exceeds its response bound.', 409)
      throw error
    }
  }
}
