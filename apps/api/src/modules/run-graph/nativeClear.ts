import {
  assertNativeGraphProjectionAuthority, canonicalGraphJson, sameGraphScope,
  type GraphFact, type NativeGraphActivityRecord,
} from '@foreman-code/contracts/wave25'
import { readCurrentNodeAttention } from './currentAttention.js'
import { poisonGraphTransaction } from './connection.js'
import { assertRunGraphPublication, type RunGraphPublication } from './publication.js'
import { readNativeGraphActivity, type NativeGraphProjectionGuard } from './records.js'
import { PostgresNativeGraphProjectionWriter } from './nativeWriter.js'
import { readCurrentNativeActivities, readCurrentActivityContext, selectCurrentNodeActivity, type CurrentActivityContext } from './currentActivity.js'
import { RunGraphError } from './errors.js'

/** Call AFTER the terminal/Stop domain mutation, within the same G1 transaction.
 * Publish these facts under the coordinator's stable clear-source identity, then apply().
 * Clearing projection is NOT proof of native closure and never writes a terminal native sequence.
 */
export async function prepareNativeGraphClear(publication: RunGraphPublication,
  guards: readonly NativeGraphProjectionGuard[], options: { runClosed?: boolean } = {}, writer = new PostgresNativeGraphProjectionWriter()) {
  const { sql, scope } = publication
  assertRunGraphPublication(sql, scope)
  if ((!guards.length && !options.runClosed) || guards.length > 3000) throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
  const ordered = [...guards].sort((a, b) => canonicalGraphJson(a.expected.key).localeCompare(canonicalGraphJson(b.expected.key)))
  if (new Set(ordered.map((guard) => canonicalGraphJson(guard.expected.key))).size !== ordered.length) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
  const plans: { guard: NativeGraphProjectionGuard; previous: NativeGraphActivityRecord | undefined; next: NativeGraphActivityRecord }[] = []
  try {
    const nodeIds = options.runClosed ? (await sql.query<{ id: string }>(
      `select n.node->>'id' as id from workflow_versions v
       cross join lateral jsonb_array_elements(v.record->'definition'->'nodes') n(node)
       where v.id=$1 order by n.node->>'id' limit 1001`, [scope.workflowVersionId])).rows.map((row) => row.id)
      : [...new Set(ordered.map((guard) => guard.expected.key.execution.workflowNodeId))]
    if (nodeIds.length > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
    const candidates = await readCurrentNativeActivities(sql, scope, nodeIds, true)
    for (const guard of ordered) {
      const key = guard.expected.key
      if (!sameGraphScope(scope, guard.expected.scope)) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      assertNativeGraphProjectionAuthority(guard.expected, await guard.readCurrentLocked(sql, scope, key))
      const previous = await readNativeGraphActivity(sql, scope, key)
      const next: NativeGraphActivityRecord = { key, projectionRevision: previous ? String(BigInt(previous.projectionRevision) + 1n) : '0',
        lastNativeSequence: previous?.lastNativeSequence ?? null, terminalNativeSequence: previous?.terminalNativeSequence ?? null,
        activity: { workflowNodeId: key.execution.workflowNodeId, execution: key.execution, status: 'none' } }
      plans.push({ guard, previous, next })
      const index = candidates.findIndex((candidate) => canonicalGraphJson(candidate.key) === canonicalGraphJson(key))
      const candidate = { key, activity: next.activity, lastNativeSequence: next.lastNativeSequence }
      if (index < 0) candidates.push(candidate); else candidates[index] = candidate
    }
    const facts: GraphFact[] = []
    for (const id of nodeIds) {
      const context: CurrentActivityContext = options.runClosed ? { closed: true } : await readCurrentActivityContext(sql, scope, id)
      if (ordered.some((guard) => guard.expected.key.workKind === 'workflow' && guard.expected.key.execution.workflowNodeId === id)) context.workflowClosed = true
      facts.push({ type: 'node.activity', activity: selectCurrentNodeActivity(id, candidates, context) })
    }
    const attention = await readCurrentNodeAttention(sql, scope, new Map(facts.flatMap((fact) =>
      fact.type === 'node.activity' ? [[fact.activity.workflowNodeId, fact.activity] as const] : [])))
    for (const value of attention.values()) facts.push({ type: 'node.attention', attention: value })
    let applied = false
    return { facts, apply: async () => {
      if (applied) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      applied = true
      try {
        if (options.runClosed) {
          const closed = await sql.query(`select 1 from runs where id=$1
            and (stop_requested_at is not null or execution_state in ('completed','interrupted'))`, [scope.runId])
          if (closed.rowCount !== 1) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
        }
        for (const plan of plans) {
          const key = plan.next.key
          const row = (await sql.query<{ closed: boolean }>(
            `select (r.stop_requested_at is not null or r.execution_state in ('completed','interrupted') or
              case when $3='workflow' then e.record->>'state'='completed' else
                exists(select 1 from review_jobs j where j.id=$4 and j.execution_id=e.id and
                  (j.record->>'state'='completed' or j.record->'cleanup'->>'completedAt' is not null)) end) as closed
             from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2`,
            [scope.runId, key.execution.executionId, key.workKind, key.workId])).rows[0]
          if (!row?.closed) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
          await writer.persistActivity(sql, scope, plan.previous?.projectionRevision ?? null, plan.next, plan.guard)
          await sql.query(`delete from run_native_projection_checkpoints
            where run_id=$1 and execution_id=$2 and work_kind=$3 and work_id=$4`,
          [scope.runId, key.execution.executionId, key.workKind, key.workId])
        }
      } catch (error) { poisonGraphTransaction(sql); throw error }
    } }
  } catch (error) { poisonGraphTransaction(sql); throw error }
}
