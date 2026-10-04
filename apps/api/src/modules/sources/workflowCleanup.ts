import { HarnessExecutionSchema } from '@graphql/contracts'
import { SourceMaterializationRecordSchema } from '@graphql/contracts/source-admission'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readUnboundWorkflowClosure, readWorkflowClosure } from '../interactions/workflowClosure.js'
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
  const rows = await pool.query<{ record: unknown }>(`select m.record
    from source_execution_materializations m
    join harness_executions e on e.id=m.execution_id
    join runs r on r.id=e.run_id
    where m.state<>'closed' and r.execution_state='completed'
      and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
    order by m.materialization_id limit 100`)
  for (const row of rows.rows) {
    try {
      await sources.confirmClosed(SourceMaterializationRecordSchema.parse(row.record))
    } catch (error) {
      report(error)
    }
  }
}
