import type pg from 'pg'
import { type ActivityItem, type WorkRef, type WorkSummary } from '@graphql/contracts'

export interface NativeActivityFact {
  execution_id: string; sequence: string; item_id: string; item_type: string; status: string | null;
  native_session_id: string | null; native_turn_id: string | null; generation: string | null; observed_at: string | null;
}
/** Existing immutable native records only. This query never selects prompts, params, paths or tool arguments. */
export const RUN_NATIVE_ACTIVITY_FACTS_SQL = `with normalized as (
  select n.execution_id,n.sequence,
    coalesce(case when n.record->>'type'='native.unlinked_notification' then n.record#>>'{payload,turnId}' end,
      n.record#>>'{payload,item,id}',n.record#>>'{payload,part,id}',n.record#>>'{payload,itemId}',
      case when n.record#>>'{payload,method}' in ('turn/started','turn/completed') then n.record#>>'{payload,turnId}' end) as item_id,
    case when n.record->>'type'='native.unlinked_notification' then 'subagent'
      else coalesce(n.record#>>'{payload,item,type}',n.record#>>'{payload,part,type}') end as item_type,
    case when n.record->>'type'='native.unlinked_notification' then
      case when n.record#>>'{payload,method}'='turn/completed' then coalesce(n.record#>>'{payload,params,turn,status}','unknown')
        when n.record#>>'{payload,method}'='turn/started' then 'running' else 'unknown' end
      else coalesce(n.record#>>'{payload,item,status}',n.record#>>'{payload,part,state,status}',
        case when n.record->>'type'='item.completed' then 'completed' when n.record->>'type'='item.started' then 'running' end) end as status,
    coalesce(n.record#>>'{payload,threadId}',n.record#>>'{payload,part,sessionID}') as native_session_id,
    n.record#>>'{payload,turnId}' as native_turn_id,n.record#>>'{payload,runtimeGeneration}' as generation,
    n.record->>'occurredAt' as observed_at
  from harness_native_events n join harness_executions e on e.id=n.execution_id where e.run_id=$1
), latest as (
  select distinct on (execution_id,native_session_id,generation,item_id) * from normalized
  where item_id is not null and item_type in ('commandExecution','mcpToolCall','dynamicToolCall','collabAgentToolCall','tool','subagent')
  order by execution_id,native_session_id,generation,item_id,sequence desc
) select execution_id,sequence::text,item_id,item_type,status,native_session_id,native_turn_id,generation,observed_at
  from latest order by execution_id,latest.sequence limit 1001`

export async function readNativeActivityFacts(sql: Pick<pg.PoolClient, 'query'>, runId: string) {
  return (await sql.query<NativeActivityFact>(RUN_NATIVE_ACTIVITY_FACTS_SQL, [runId])).rows
}
export function projectNativeActivityFacts(rows: readonly NativeActivityFact[], resolve: (executionId: string) =>
  { owner: WorkRef; harness: string | null; sessionId: string | null; terminal: boolean }) {
  const activities: ActivityItem[] = []; const active: WorkSummary[] = []
  for (const row of rows.slice(0, 1000)) {
    const context = resolve(row.execution_id)
    const child = row.item_type === 'subagent'
    const kind = child ? 'subagent' : 'tool'
    const provenTerminal = ['completed', 'failed', 'declined', 'error', 'canceled', 'cancelled', 'interrupted'].includes(row.status ?? '')
    const status = row.status === 'error' || row.status === 'failed' || row.status === 'declined' ? 'failed'
      : ['canceled', 'cancelled', 'interrupted'].includes(row.status ?? '') ? 'canceled'
        : row.status === 'completed' ? 'completed' : context.terminal || row.status === 'unknown' ? 'unknown' : row.status === 'pending' ? 'pending' : 'running'
    const nativeSession = row.native_session_id ?? (child ? null : context.sessionId)
    const native = nativeSession && context.harness ? { harness: context.harness, sessionId: nativeSession,
      ...(row.native_turn_id ? { turnId: row.native_turn_id } : {}), itemId: row.item_id,
      ...(row.generation ? { generation: row.generation } : {}) } : undefined
    const id = JSON.stringify(['native-item', row.execution_id, row.native_session_id, row.generation, row.item_id])
    const ref: WorkRef = { kind, itemId: id, ...(native ? { native } : {}) }
    activities.push({ kind, id, title: child ? 'Native child turn' : 'Native tool', status,
      revision: row.sequence, order: row.sequence, owner: context.owner, ...(native ? { native } : {}),
      source: { schemaVersion: 1, system: 'harness_native_events', observedAt: row.observed_at },
      evidence: status === 'unknown' ? 'unknown' : 'confirmed' })
    if (!provenTerminal) active.push({ ref, phase: 'active', outcome: null, delivery: null, startedAt: null,
      evidence: context.terminal || status === 'unknown' ? 'unknown' : 'confirmed', ...(native ? { native } : {}) })
  }
  return { activities, active, hasMore: rows.length > 1000 }
}
