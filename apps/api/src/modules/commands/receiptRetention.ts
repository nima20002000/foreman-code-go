import type pg from 'pg'
import { DomainError } from '../errors.js'

export const COMMAND_RECEIPT_RETENTION_MS = 30 * 86_400_000
const batchSize = 100

// These responses are retry snapshots. Other operations also store live bindings,
// workflow publication facts or resumable external work in the same table.
const retrySnapshotOperations = [
  'agent_chat_control', 'operator_chat_control', 'operator_chat_create',
  'workflow.create', 'workflow.update', 'workflow.reorder', 'workflow.archive',
  'workflow.batch_archive', 'workflow.restore',
  'workspace.archive', 'workspace.batch_archive', 'workspace.restore',
  'agent.create', 'agent.update', 'agent.archive', 'agent.restore', 'agent.clone', 'agent.configuration.restore',
  'harness.defaults.update', 'harness.instance.save', 'harness.instance.check',
  'workspace.location.set', 'workspace.location.clear', 'workspace.location.provision',
  'workspace.root.configuration.adopt', 'workspace.root.managed.bind',
  'computer_sync_update', 'ci_enrollment_update',
]
const retrySnapshots = new Set(retrySnapshotOperations)

export function expiredCommandResult(): DomainError {
  return new DomainError('COMMAND_RESULT_EXPIRED',
    'This command already completed, but its saved response has expired. Read the current state before sending a new command.', 409)
}

export interface ExpiringCommandReceipt {
  principalId: string
  operation: string
  commandId: string
  createdAt: number
  completedAt?: number
  revision?: string
  status: string | null
  hasAcceptedControl: boolean
  hasAcknowledgment: boolean
}
export interface CommandReceiptRetentionStore {
  /** Candidates have a successful completion audit whose identity outlives the response. */
  candidates(limit: number): Promise<ExpiringCommandReceipt[]>
  /** Delete only the selected revision, retaining its existing audit identity. */
  remove(receipt: ExpiringCommandReceipt): Promise<boolean>
}

export async function pruneCompletedCommandReceipts(store: CommandReceiptRetentionStore, now: number): Promise<number> {
  const cutoff = now - COMMAND_RECEIPT_RETENTION_MS
  let removed = 0
  for (const row of await store.candidates(batchSize)) {
    if (!retrySnapshots.has(row.operation) || Math.max(row.createdAt, row.completedAt ?? row.createdAt) >= cutoff) continue
    const chat = row.operation === 'agent_chat_control' || row.operation === 'operator_chat_control'
    const completed = chat ? row.status === 'completed' && (!row.hasAcceptedControl || row.hasAcknowledgment)
      : row.status === null || row.status === 'completed' || row.status === 'succeeded'
    if (completed && await store.remove(row)) removed++
  }
  return removed
}

/** One bounded batch per periodic cleanup, with optimistic concurrency on mutable responses. */
export class PostgresCommandReceiptRetention {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async prune(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - COMMAND_RECEIPT_RETENTION_MS)
    return pruneCompletedCommandReceipts({
      candidates: async limit => {
        const rows = (await this.pool.query<{
          principal_id: string; operation: string; command_id: string; created_at: Date; completed_at: Date;
          revision: string; status: string | null; has_control: boolean; has_ack: boolean;
        }>(`select r.principal_id,r.operation,r.command_id,r.created_at,a.occurred_at as completed_at,
          r.activity_record_revision::text as revision,r.activity_status as status,
          r.activity_control is not null as has_control,r.activity_acknowledgment is not null as has_ack
          from management_command_receipts r
          join lateral (select occurred_at from management_audit
            where principal_id=r.principal_id and action=r.operation and details->>'commandId'=r.command_id
              and outcome='succeeded'
            order by occurred_at desc limit 1) a on true
          where r.operation=any($1::text[]) and r.created_at<$2 and a.occurred_at<$2
            and (case when r.operation in ('agent_chat_control','operator_chat_control')
              then r.activity_status='completed'
                and (r.activity_control is null or r.activity_acknowledgment is not null)
              else r.activity_status is null or r.activity_status in ('completed','succeeded') end)
          order by r.created_at,r.principal_id,r.operation,r.command_id limit $3`,
        [retrySnapshotOperations, cutoff, limit])).rows
        return rows.map(row => ({ principalId: row.principal_id, operation: row.operation, commandId: row.command_id,
          createdAt: row.created_at.getTime(), completedAt: row.completed_at.getTime(), revision: row.revision,
          status: row.status, hasAcceptedControl: row.has_control, hasAcknowledgment: row.has_ack }))
      },
      remove: async row => {
        const deleted = await this.pool.query(`delete from management_command_receipts
          where principal_id=$1 and operation=$2 and command_id=$3 and activity_record_revision=$4`,
        [row.principalId, row.operation, row.commandId, row.revision])
        return deleted.rowCount === 1
      },
    }, now)
  }
}
