import type pg from 'pg'

import { DomainError } from '../errors.js'

interface BudgetRow {
  active_timeout_ms: string
  active_elapsed_ms: string
  active_started_at: Date | null
  approval_wait_started_at: Date | null
  stopped_at: Date | null
  revision: string
}

export class PostgresApprovalBudgetRepository {
  constructor(private readonly pool: pg.Pool) {}

  async ensure(executionId: string, graphThreadId: string, activeTimeoutMs: number): Promise<void> {
    await this.pool.query(
      `insert into approval_execution_state
       (execution_id,graph_thread_id,active_timeout_ms,active_elapsed_ms,active_started_at)
       values ($1,$2,$3,0,now()) on conflict (execution_id) do nothing`,
      [executionId, graphThreadId, activeTimeoutMs],
    )
  }

  async beginWait(executionId: string): Promise<void> {
    const result = await this.pool.query(
      `update approval_execution_state set
         active_elapsed_ms=active_elapsed_ms + coalesce(extract(epoch from (now()-active_started_at))*1000,0)::bigint,
         active_started_at=null,approval_wait_started_at=coalesce(approval_wait_started_at,now()),
         revision=revision+1,updated_at=now()
       where execution_id=$1 and stopped_at is null`, [executionId],
    )
    if (result.rowCount !== 1) throw new DomainError('EXECUTION_NOT_WAITABLE', 'The execution is stopped or has no active-time budget.', 409)
  }

  async resume(executionId: string): Promise<void> {
    const result = await this.pool.query(
      `update approval_execution_state set active_started_at=coalesce(active_started_at,now()),
         approval_wait_started_at=null,revision=revision+1,updated_at=now()
       where execution_id=$1 and stopped_at is null`, [executionId],
    )
    if (result.rowCount !== 1) throw new DomainError('EXECUTION_STOPPED', 'A stopped execution cannot be resumed.', 409)
  }

  async stop(executionId: string): Promise<void> {
    await this.pool.query(
      `update approval_execution_state set stopped_at=coalesce(stopped_at,now()),active_started_at=null,
         revision=revision+1,updated_at=now() where execution_id=$1`, [executionId],
    )
  }

  async assertActive(executionId: string): Promise<void> {
    const result = await this.pool.query<BudgetRow>(
      `select active_timeout_ms::text,active_elapsed_ms::text,active_started_at,
         approval_wait_started_at,stopped_at,revision::text
       from approval_execution_state where execution_id=$1`, [executionId],
    )
    const row = result.rows[0]
    if (!row || row.stopped_at) throw new DomainError('EXECUTION_STOPPED', 'A stopped execution cannot accept approval delivery.', 409)
    const runningMs = row.active_started_at ? Date.now() - row.active_started_at.getTime() : 0
    if (Number(row.active_elapsed_ms) + runningMs >= Number(row.active_timeout_ms)) {
      throw new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'The execution exhausted its active-time budget.', 409)
    }
  }
}
