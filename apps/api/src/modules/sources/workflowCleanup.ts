import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readUnboundWorkflowClosure, readWorkflowClosure } from '../interactions/workflowClosure.js'
import { hasRetainedRemoteReviewerSource } from '../interactions/retainedRemoteReviewer.js'
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

interface CompletedSource {
  materialization_id: string
  already_closed: boolean
  record: unknown
  execution: unknown
  settlement_pending: boolean
  preparation_closed: boolean
}

const cleanupPageSize = 100
type SourceCleanupService = Pick<PostgresSourceService, 'confirmClosed'>
interface ClosureRetry {
  delayMs: number
  nextAttemptAt: number
  missingFileReported: boolean
}
const closureRetries = new WeakMap<SourceCleanupService, Map<string, ClosureRetry>>()

function deferSourceClosure(
  error: unknown,
  materializationId: string,
  retries: Map<string, ClosureRetry>,
  report: (error: unknown) => void,
): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  // A read that timed out behind a busy Run proves nothing either way; try again on a later pass.
  if (code !== 'SOURCE_EXECUTION_UNCERTAIN' && code !== 'ENOENT' && code !== 'DATABASE_READ_TIMEOUT') {
    retries.delete(materializationId)
    return false
  }
  const previous = retries.get(materializationId)
  const delayMs = previous ? Math.min(previous.delayMs * 2, 5 * 60_000) : 30_000
  const retry = {
    delayMs,
    nextAttemptAt: Date.now() + delayMs,
    missingFileReported: previous?.missingFileReported ?? false,
  }
  retries.set(materializationId, retry)
  // Missing receipts or claims do not prove release; keep the source owned and retry.
  if (code === 'ENOENT' && !retry.missingFileReported) {
    retry.missingFileReported = true
    report(error)
  }
  return true
}

async function completedSourcePage(pool: Pick<pg.Pool, 'query'>, after: CompletedSource | undefined) {
  return pool.query<CompletedSource>(`select m.materialization_id,m.state='closed' as already_closed,
      m.record,e.record as execution,
      exists(select 1 from source_preparation_reconciliations c
        where c.operation_id::text=m.record->>'operationId' and c.status='closed') as preparation_closed,
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
    where (m.state<>'closed' or (
        s.state='retained' and (
          (s.record->>'referenceReclaimed' is distinct from 'true' and (
            s.reserved_bytes=(s.record->>'reservedBytes')::bigint
            or (m.record#>'{receipt,sharedTree}' is not null
              and m.record#>>'{receipt,binding,deviceId}' is null)
          ))
          or (m.record#>'{receipt,worktree}' is not null
            and m.worktree_cleanup->>'state' is distinct from 'removed')
        )
      )) and e.record->>'state'='completed'
      and ($1::uuid is null or (m.state='closed',m.materialization_id)>($2::boolean,$1::uuid))
    order by m.state='closed',m.materialization_id limit $3`,
  [after?.materialization_id ?? null, after?.already_closed ?? false, cleanupPageSize])
}

export async function closeCompletedWorkflowSources(
  pool: Pick<pg.Pool, 'query'>,
  sources: SourceCleanupService,
  report: (error: unknown) => void,
): Promise<void> {
  let retries = closureRetries.get(sources)
  if (!retries) {
    retries = new Map()
    closureRetries.set(sources, retries)
  }
  const unseen = new Set(retries.keys())
  let after: CompletedSource | undefined
  for (;;) {
    const { rows } = await completedSourcePage(pool, after)
    for (const row of rows) {
      unseen.delete(row.materialization_id)
      const retry = retries.get(row.materialization_id)
      if (retry && retry.nextAttemptAt > Date.now()) continue
      try {
        // A successful result can be published before its native closure commits.
        if (row.settlement_pending) continue
        const execution = HarnessExecutionSchema.parse(row.execution)
        // Sessionless cleanup still requires the original preparation and physical closure.
        if (!execution.nativeSessionId && !row.already_closed && !row.preparation_closed) continue
        const record = SourceMaterializationRecordSchema.parse(row.record)
        if (record.receipt.binding.deviceId !== null && execution.id === record.receipt.executionId
          && await hasRetainedRemoteReviewerSource(pool, execution)) continue
        await sources.confirmClosed(record)
        retries.delete(row.materialization_id)
      } catch (error) {
        if (!deferSourceClosure(error, row.materialization_id, retries, report)) report(error)
      }
    }
    if (rows.length < cleanupPageSize) {
      for (const materializationId of unseen) retries.delete(materializationId)
      return
    }
    after = rows.at(-1)
  }
}
