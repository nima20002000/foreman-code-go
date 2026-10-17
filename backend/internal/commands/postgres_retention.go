package commands

import (
	"context"
	"sync"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

// PostgresReceiptRetention keeps one cursor across bounded cleanup calls.
// Composition owns scheduling. Calls are serialized so they cannot race the
// cursor while PostgreSQL revision checks protect concurrently changed results.
type PostgresReceiptRetention struct {
	sql    database.Querier
	mu     sync.Mutex
	cursor *receiptCursor
}

type receiptCursor struct {
	operation   string
	createdAt   time.Time
	principalID string
	commandID   string
}

type receiptRetentionBatch struct {
	sql        database.Querier
	cutoff     time.Time
	cursor     *receiptCursor
	nextCursor *receiptCursor
}

func NewPostgresReceiptRetention(sql database.Querier) *PostgresReceiptRetention {
	return &PostgresReceiptRetention{sql: sql}
}

func (retention *PostgresReceiptRetention) Prune(ctx context.Context, now time.Time) (int, error) {
	retention.mu.Lock()
	defer retention.mu.Unlock()
	batch := &receiptRetentionBatch{
		sql: retention.sql, cutoff: now.Add(-CommandReceiptRetention), cursor: retention.cursor,
	}
	removed, err := PruneCompletedCommandReceipts(ctx, batch, now)
	if err != nil {
		return 0, err
	}
	retention.cursor = batch.nextCursor
	return removed, nil
}

func (batch *receiptRetentionBatch) Candidates(ctx context.Context, limit int) ([]ExpiringReceipt, error) {
	cursor := receiptCursor{createdAt: time.Unix(0, 0).UTC()}
	if batch.cursor != nil {
		cursor = *batch.cursor
	}
	rows, err := batch.sql.Query(ctx, `with candidates as materialized (
		select principal_id, operation, command_id, created_at, activity_record_revision,
		activity_status, activity_control, activity_acknowledgment from management_command_receipts
		where operation = any($1::text[]) and created_at < $2
		and (operation, created_at, principal_id, command_id) > ($3::text, $4::timestamptz, $5::text, $6::text)
		order by operation, created_at, principal_id, command_id limit $7
	) select r.principal_id, r.operation, r.command_id, r.created_at,
		a.occurred_at, r.activity_record_revision, r.activity_status,
		r.activity_control is not null, r.activity_acknowledgment is not null
		from candidates r
		left join lateral (select occurred_at from management_audit
			where principal_id = r.principal_id and action = r.operation
			and details->>'commandId' = r.command_id and outcome = 'succeeded'
			order by occurred_at desc limit 1) a on true
		order by r.operation, r.created_at, r.principal_id, r.command_id`,
		retrySnapshotOperations, batch.cutoff, cursor.operation, cursor.createdAt, cursor.principalID, cursor.commandID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []ExpiringReceipt
	for rows.Next() {
		var row ExpiringReceipt
		if err := rows.Scan(&row.PrincipalID, &row.Operation, &row.CommandID, &row.CreatedAt,
			&row.CompletedAt, &row.Revision, &row.Status, &row.HasAcceptedControl, &row.HasAcknowledgment); err != nil {
			return nil, err
		}
		batch.nextCursor = &receiptCursor{
			operation: row.Operation, createdAt: row.CreatedAt, principalID: row.PrincipalID, commandID: row.CommandID,
		}
		if row.CompletedAt != nil {
			candidates = append(candidates, row)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func (batch *receiptRetentionBatch) Remove(ctx context.Context, row ExpiringReceipt) (bool, error) {
	deleted, err := batch.sql.Exec(ctx, `delete from management_command_receipts
		where principal_id = $1 and operation = $2 and command_id = $3 and activity_record_revision = $4`,
		row.PrincipalID, row.Operation, row.CommandID, row.Revision)
	if err != nil {
		return false, err
	}
	return deleted.RowsAffected() == 1, nil
}
