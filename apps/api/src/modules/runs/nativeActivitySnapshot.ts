import type pg from 'pg'
import { type ActivityItem, type WorkRef, type WorkSummary } from '@foreman-code/contracts'
import { nativeActivityStatus } from './nativeActivityStatus.js'
import { claudeConversationActivity } from '../harnesses/claudeSdk/conversationActivity.js'
import { nativeToolTitle } from './nativeAction.js'

export interface NativeActivityFact {
  execution_id: string; sequence: string; item_id: string; item_type: string; status: string | null;
  native_session_id: string | null; native_turn_id: string | null; generation: string | null; observed_at: string | null;
  native_type?: string | null; tool_name?: string | null; command_name?: string | null; item_error?: boolean;
}
/** Only protocol metadata and the first executable token cross this read boundary. */
export const RUN_NATIVE_ACTIVITY_FACTS_SQL = `with normalized as (
  select n.execution_id,n.sequence,
    coalesce(case n.record->>'type'
      when 'claude.tool' then coalesce(n.record#>>'{payload,toolUseId}',n.record#>>'{payload,itemId}')
      when 'claude.task' then n.record#>>'{payload,taskId}'
      when 'native.unlinked_notification' then n.record#>>'{payload,turnId}' end,
      n.record#>>'{payload,item,id}',n.record#>>'{payload,part,id}',n.record#>>'{payload,itemId}',
      case when n.record#>>'{payload,method}' in ('turn/started','turn/completed') then n.record#>>'{payload,turnId}' end) as item_id,
    case when n.record->>'type'='native.unlinked_notification' then 'subagent'
      when n.record->>'type'='claude.tool' then 'tool'
      when n.record->>'type'='claude.task' then 'subagent'
      else coalesce(n.record#>>'{payload,item,type}',n.record#>>'{payload,part,type}') end as item_type,
    case when n.record->>'type'='native.unlinked_notification' then
      case when n.record#>>'{payload,method}'='turn/completed' then coalesce(n.record#>>'{payload,params,turn,status}','unknown')
        when n.record#>>'{payload,method}'='turn/started' then 'running' else 'unknown' end
      else coalesce(case when n.record->>'type' in ('claude.tool','claude.task') then n.record#>>'{payload,status}' end,
        n.record#>>'{payload,item,status}',n.record#>>'{payload,part,state,status}',
        case when n.record->>'type'='item.completed' then 'completed' when n.record->>'type'='item.started' then 'running' end) end as status,
    coalesce(case when n.record->>'type' in ('claude.tool','claude.task') then n.record#>>'{payload,nativeSessionId}' end,
      n.record#>>'{payload,threadId}',
      n.record#>>'{payload,part,sessionID}') as native_session_id,
    n.record#>>'{payload,turnId}' as native_turn_id,
    coalesce(case when n.record->>'type' in ('claude.tool','claude.task') then n.record#>>'{payload,owner,generation}' end,
      n.record#>>'{payload,runtimeGeneration}') as generation,
    n.record->>'occurredAt' as observed_at,n.record->>'type' as native_type,
    (coalesce(n.record#>'{payload,item,error}' <> 'null'::jsonb,false)
      or (n.record#>>'{payload,item,type}'='dynamicToolCall'
        and coalesce(n.record#>'{payload,item,success}'='false'::jsonb,false))) as item_error,
    coalesce(case when n.record->>'type'='claude.tool' then n.record#>>'{payload,name}' end,
      n.record#>>'{payload,item,tool}',n.record#>>'{payload,part,tool}') as tool_name,
    substring(n.record#>>'{payload,item,command}' from '^[[:space:]]*([A-Za-z0-9_./-]+)') as command_name
  from harness_native_events n join harness_executions e on e.id=n.execution_id where e.run_id=$1
), latest as (
  select distinct on (execution_id,native_session_id,generation,item_id) * from normalized
  where item_id is not null and item_type in
    ('commandExecution','fileChange','webSearch','mcpToolCall','dynamicToolCall','collabAgentToolCall','tool','subagent')
  order by execution_id,native_session_id,generation,item_id,sequence desc
), classified as (
  select *, coalesce(status in ('completed','failed','declined','error','canceled','cancelled','interrupted'),false)
    or item_error as finished from latest
), bounded as (
  (select * from classified where not finished order by execution_id,sequence limit 1001)
  union all
  (select * from classified where finished order by execution_id,sequence limit 1000)
) select execution_id,sequence::text,item_id,item_type,status,native_session_id,native_turn_id,generation,observed_at,
  native_type,tool_name,command_name,item_error
  from bounded order by execution_id,bounded.sequence`

export async function readNativeActivityFacts(sql: Pick<pg.PoolClient, 'query'>, runId: string) {
  return (await sql.query<NativeActivityFact>(RUN_NATIVE_ACTIVITY_FACTS_SQL, [runId])).rows
}
export function projectNativeActivityFacts(rows: readonly NativeActivityFact[], resolve: (executionId: string) =>
  { owner: WorkRef; harness: string | null; sessionId: string | null; terminal: boolean }) {
  const activities: ActivityItem[] = []
  const active: WorkSummary[] = []
  let finishedCount = 0
  let unfinishedCount = 0
  for (const row of rows) {
    let observed = nativeActivityStatus(row.status)
    if (observed !== 'canceled' && row.item_error) observed = 'failed'
    const provenTerminal = observed === 'completed' || observed === 'failed' || observed === 'canceled'
    if (provenTerminal) {
      if (++finishedCount > 1000) continue
    } else if (++unfinishedCount > 1000) continue
    const context = resolve(row.execution_id)
    const child = row.item_type === 'subagent'
    const kind = child ? 'subagent' : 'tool'
    const claude = claudeConversationActivity({ type: row.native_type ?? '', payload: {
      itemId: row.item_id, taskId: row.item_id, name: row.tool_name, status: row.status,
    } }, row.execution_id)
    let status: Extract<ActivityItem, { kind: 'tool' }>['status'] = observed ?? 'running'
    if (!provenTerminal && context.terminal) status = 'unknown'
    const nativeSession = row.native_session_id ?? (child ? null : context.sessionId)
    const native = nativeSession && context.harness ? { harness: context.harness, sessionId: nativeSession,
      ...(row.native_turn_id ? { turnId: row.native_turn_id } : {}), itemId: row.item_id,
      ...(row.generation ? { generation: row.generation } : {}) } : undefined
    const id = JSON.stringify(['native-item', row.execution_id, row.native_session_id, row.generation, row.item_id])
    const ref: WorkRef = { kind, itemId: id, ...(native ? { native } : {}) }
    activities.push({ kind, id, title: claude?.title ?? nativeToolTitle(row.item_type, row.tool_name, row.command_name), status,
      revision: row.sequence, order: row.sequence, owner: context.owner, ...(native ? { native } : {}),
      source: { schemaVersion: 1, system: 'harness_native_events', observedAt: row.observed_at },
      evidence: status === 'unknown' ? 'unknown' : 'confirmed' })
    if (!provenTerminal) active.push({ ref, phase: 'active', outcome: null, delivery: null, startedAt: null,
      evidence: context.terminal || status === 'unknown' ? 'unknown' : 'confirmed', ...(native ? { native } : {}) })
  }
  return { activities, active, hasMore: unfinishedCount > 1000 }
}
