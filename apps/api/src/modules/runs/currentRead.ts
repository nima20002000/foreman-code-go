import { readRunActivitySnapshot } from './activitySnapshot.js'
import type pg from 'pg'
import { RunActivitySchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SavedRunDetailsSchema, REPEAT_GRAPH_LIMITS, graphJsonBytes, RUN_GRAPH_LIMITS } from '@foreman-code/contracts/wave25'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { readAcceptedRepeatRunLocked, type AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import { readRepeatExecutionLocked } from './repeatPostgres.js'

/** Same primary-pool immutable V3 reader as Start/owner recovery. This is Run
 * detail composition, not another graph projection, graph head or execution
 * admission. Public graph metadata stays on the canonical graph reader. */
export async function withCurrentRunRead<T>(pool: pg.Pool, principal: ManagementPrincipal,
  workspaceId: string, runId: string, action: 'runs:read' | 'runs:stop',
  work: (sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot, live: ManagementPrincipal) => Promise<T>,
  readAcceptedRun = readAcceptedRepeatRunLocked): Promise<T> {
  return withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const row = (await sql.query<{ workspace_id: string; workflow_id: string }>(
      'select workspace_id,workflow_id from runs where id=$1 and workspace_id=$2', [runId, workspaceId])).rows[0]
    if (!row) throw new DomainError('RUN_NOT_FOUND', 'The Run was not found in this workspace.', 404)
    const live = await readLiveManagementPrincipal(sql as unknown as Pick<pg.ClientBase, 'query'>, principal.id)
    requireAuthorization(live, action, { workspaceId: row.workspace_id, workflowId: row.workflow_id, runId })
    const snapshot = await readAcceptedRun(sql, runId)
    if (snapshot.run.workspaceId !== workspaceId || snapshot.run.workflowId !== row.workflow_id) {
      throw new DomainError('RUN_PIN_CONFLICT', 'The Run changed its exact scope.', 409)
    }
    return work(sql, snapshot, live)
  }))
}
export function readCurrentRunDetails(pool: pg.Pool, principal: ManagementPrincipal, workspaceId: string, runId: string) {
  return withCurrentRunRead(pool, principal, workspaceId, runId, 'runs:read', async (sql, snapshot, live) => {
    const { run } = snapshot
    const rows = (await sql.query<{ id: string }>(
      'select id from harness_executions where run_id=$1 order by created_at,id limit $2',
      [runId, REPEAT_GRAPH_LIMITS.executions + 1])).rows
    if (rows.length > REPEAT_GRAPH_LIMITS.executions) throw new DomainError('RUN_DETAIL_TOO_LARGE', 'Use the bounded canonical current graph for this Run.', 409)
    const executions = []
    for (const { id } of rows) {
      // Reuse A's exact readback, including physical node/Agent/configuration,
      // occurrence/attempt/input identity and its existing canonical source
      // receipt. A loose JSON execution parser cannot qualify current readback.
      executions.push((await readRepeatExecutionLocked(sql, snapshot, id)).execution)
    }
    const activityRows = (await sql.query<{ sequence: string; source: string; kind: string; harness_execution_id: string | null;
      occurred_at: Date; payload: Record<string, unknown> }>(
      `select sequence::text,source,kind,harness_execution_id,occurred_at,payload from run_activity
       where run_id=$1 order by run_activity.sequence desc limit 101`, [runId])).rows
    const activity = activityRows.slice(0, 100).reverse().map((row) => RunActivitySchema.parse({
      id: `activity-${runId}-${row.sequence}`, runId, sequence: Number(row.sequence), source: row.source, kind: row.kind,
      ...(row.harness_execution_id ? { harnessExecutionId: row.harness_execution_id } : {}),
      occurredAt: row.occurred_at.toISOString(), payload: row.payload,
    }))
    const cleanup = (await sql.query<{ pending: boolean }>(
      'select exists(select 1 from run_cleanup_intents where run_id=$1 and pending) as pending', [runId])).rows[0]
    if (!cleanup || typeof cleanup.pending !== 'boolean') throw new DomainError('RUN_DETAIL_INVALID', 'Cleanup status is unavailable.', 409)
    const activitySnapshot = await readRunActivitySnapshot(sql as unknown as Pick<pg.PoolClient, 'query'>,
      { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, workflowVersionId: run.workflowVersionId }, snapshot.version)
    const detail = { run, executions, activity, activitySnapshot, activityPageInfo: { hasEarlier: activityRows.length > 100 }, cleanupPending: cleanup.pending }
    if (graphJsonBytes(detail) > RUN_GRAPH_LIMITS.snapshotBytes) throw new DomainError('RUN_DETAIL_TOO_LARGE', 'Use bounded graph metadata and activity pages for this Run.', 409)
    const parsed = SavedRunDetailsSchema.parse(detail)
    // Redaction uses the live grants locked on this same read, not the possibly
    // older principal snapshot captured by the transport before a grant change.
    delete parsed.run.authorizationPrincipalId
    if (!isAuthorized(live, 'workspace_locations:read', { workspaceId })) {
      delete parsed.run.executionLocation
      for (const execution of parsed.executions) {
        delete execution.workingDirectory
        delete execution.runtimeDirectory
      }
    }
    return parsed
  })
}
