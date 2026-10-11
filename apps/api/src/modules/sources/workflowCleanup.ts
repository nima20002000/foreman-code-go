import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readUnboundWorkflowClosure, readWorkflowClosure } from '../interactions/workflowClosure.js'
import { hasRetainedRemoteReviewerSource, readRetainedRemoteReviewer } from '../interactions/retainedRemoteReviewer.js'
import type { PostgresSourceService } from './service.js'

export async function localWorkflowSourceClosed(sql: GraphSqlClient, executionId: string): Promise<boolean> {
  const row = (await sql.query<{ record: unknown }>(
    'select record from harness_executions where id=$1', [executionId],
  )).rows[0]
  if (!row) return false
  const execution = HarnessExecutionSchema.parse(row.record)
  if (execution.id !== executionId || execution.state !== 'completed') return false
  const closed = execution.nativeSessionId
    ? await readWorkflowClosure(sql, execution)
    : await readUnboundWorkflowClosure(sql, execution)
  return closed !== undefined
}

export async function closeCompletedWorkflowSources(
  pool: Pick<pg.Pool, 'query'>,
  sources: Pick<PostgresSourceService, 'confirmClosed'>,
  report: (error: unknown) => void,
): Promise<void> {
  const rows = await pool.query<{ record: unknown; execution: unknown; settlement_pending: boolean }>(`select m.record,e.record as execution,
      (r.execution_state in ('running','waiting')
        and e.record#>>'{result,outcome}'='succeeded'
        and exists(select 1 from execution_native_sessions n
          join execution_native_closures c on c.execution_id=n.execution_id
          where n.execution_id=e.id and n.workflow_finalized_at is null
            and n.reference->>'nativeSessionId'=e.record->>'nativeSessionId'
            and c.closed_at is null and c.detached_at is null
            and (c.expected_reference is null or c.expected_reference=n.reference)
            and not exists(select 1 from execution_native_closures newer
              where newer.execution_id=c.execution_id and newer.generation>c.generation))) as settlement_pending
    from source_execution_materializations m
    join harness_executions e on e.id=m.execution_id
    join runs r on r.id=e.run_id
    join source_storage_reservations s on s.reservation_id=m.reservation_id
    where (m.record#>'{receipt,worktree}' is null or r.execution_state in ('completed','interrupted'))
      and (m.state<>'closed' or (
        s.state='retained' and s.reserved_bytes=(s.record->>'reservedBytes')::bigint
        and not exists(select 1 from source_preparation_reconciliations c
          where c.operation_id::text=m.record->>'operationId' and c.status='closed')
      )) and e.record->>'state'='completed'
    order by m.materialization_id limit 100`)
  for (const row of rows.rows) {
    try {
      // Stop or cleanup can arrive between result publication and the native closure commit.
      // Keep its source until that owner has finished; confirmClosed still fences release.
      if (row.settlement_pending) continue
      const record = SourceMaterializationRecordSchema.parse(row.record)
      if (record.receipt.binding.deviceId !== null) {
        const execution = HarnessExecutionSchema.parse(row.execution)
        // A completed initial reviewer turn still owns its source while the
        // verified original session remains available for review decisions.
        if (execution.id === record.receipt.executionId
          && (await readRetainedRemoteReviewer(pool, execution) || await hasRetainedRemoteReviewerSource(pool, execution))) continue
      }
      await sources.confirmClosed(record)
    } catch (error) {
      report(error)
    }
  }
}
