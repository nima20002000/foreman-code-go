import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readUnboundWorkflowClosure, readWorkflowClosure } from '../interactions/workflowClosure.js'
import { readRetainedRemoteReviewer } from '../interactions/retainedRemoteReviewer.js'
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
  const rows = await pool.query<{ record: unknown; execution: unknown }>(`select m.record,e.record as execution
    from source_execution_materializations m
    join harness_executions e on e.id=m.execution_id
    join source_storage_reservations s on s.reservation_id=m.reservation_id
    where (m.state<>'closed' or (
        s.state='retained' and s.reserved_bytes=(s.record->>'reservedBytes')::bigint
        and not exists(select 1 from source_preparation_reconciliations c
          where c.operation_id::text=m.record->>'operationId' and c.status='closed')
      )) and e.record->>'state'='completed'
    order by m.materialization_id limit 100`)
  for (const row of rows.rows) {
    try {
      const record = SourceMaterializationRecordSchema.parse(row.record)
      if (record.receipt.binding.deviceId !== null) {
        const execution = HarnessExecutionSchema.parse(row.execution)
        // A completed initial reviewer turn still owns its source while the
        // verified original session remains available for review decisions.
        if (execution.id === record.receipt.executionId && await readRetainedRemoteReviewer(pool, execution)) continue
      }
      await sources.confirmClosed(record)
    } catch (error) {
      report(error)
    }
  }
}
