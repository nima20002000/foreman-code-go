//go:build integration

package commands_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/nima20002000/foreman-code-go/backend/internal/commands"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

func TestPostgresReceiptRetentionPreservesActiveAndPermanentRecords(t *testing.T) {
	fixture := receiptDatabase(t)
	now := retentionNow()
	old := now.Add(-31 * 24 * time.Hour)
	rows := []struct {
		id        string
		operation string
		result    string
		created   time.Time
		completed time.Time
		keep      bool
	}{
		{"ordinary", "workflow.update", `{}`, old, old, false},
		{"acknowledged", "agent_chat_control", `{"status":"completed","acceptedControl":{},"providerAcknowledgment":{}}`, old, old, false},
		{"fresh", "workflow.update", `{}`, now.Add(-29 * 24 * time.Hour), old, true},
		{"boundary", "workflow.update", `{}`, now.Add(-30 * 24 * time.Hour), old, true},
		{"recent-completion", "workflow.update", `{}`, old, now.Add(-24 * time.Hour), true},
		{"pending", "agent_chat_control", `{"status":"pending"}`, old, old, true},
		{"uncertain", "operator_chat_control", `{"status":"uncertain"}`, old, old, true},
		{"unacknowledged", "operator_chat_control", `{"status":"completed","acceptedControl":{}}`, old, old, true},
		{"workflow-version", "workflow.save.v3", `{}`, old, old, true},
		{"repository-recovery", "workspace.location.set", `{}`, old, old, true},
		{"future-operation", "unrecognized", `{}`, old, old, true},
	}
	for _, row := range rows {
		key := receiptKey(fixture, row.id)
		key.Operation = row.operation
		insertReceipt(t, fixture, key, row.result, row.created)
		insertAudit(t, fixture, key, "succeeded", row.completed)
	}
	// A later successful completion renews the age boundary, even when the
	// original creation and an earlier completion are both old.
	recent := receiptKey(fixture, "recent-completion")
	insertAudit(t, fixture, recent, "succeeded", old)
	retention := commands.NewPostgresReceiptRetention(fixture.pool)
	removed, err := retention.Prune(t.Context(), now)
	if err != nil || removed != 2 {
		t.Fatalf("PostgreSQL retention removed=%d, error=%v, want 2", removed, err)
	}
	for _, row := range rows {
		key := receiptKey(fixture, row.id)
		key.Operation = row.operation
		receipt, err := commands.LookupReceipt(t.Context(), fixture.observer, key)
		if row.keep {
			if err != nil {
				t.Fatalf("Retained receipt %s could not be read: %v", row.id, err)
			}
			requireReceiptResult(t, receipt, row.result)
		} else {
			requireReceiptFailure(t, err, "COMMAND_RESULT_EXPIRED")
			if auditCount(t, fixture, key.CommandID) != 1 {
				t.Fatalf("Expired receipt %s lost its successful audit", row.id)
			}
		}
	}
}

func TestPostgresReceiptRetentionAdvancesPastUnauditedBatchesAndWraps(t *testing.T) {
	fixture := receiptDatabase(t)
	old := retentionNow().Add(-31 * 24 * time.Hour)
	executeReceiptSQL(t, fixture.pool, `insert into management_command_receipts
		(principal_id, operation, command_id, target_key, input_hash, result, created_at)
		select $1, 'workflow.update', 'batch-' || lpad(n::text, 3, '0'),
		'workflow:fixture', 'fixture-hash', '{}'::jsonb, $2 from generate_series(1, 105) n`, fixture.principalID, old)
	executeReceiptSQL(t, fixture.pool, `insert into management_audit
		(principal_id, source, action, target_key, outcome, details, occurred_at)
		select principal_id, 'http', operation, target_key, 'succeeded',
		jsonb_build_object('commandId', command_id), $1 from management_command_receipts
		where command_id > 'batch-100'`, old)
	retention := commands.NewPostgresReceiptRetention(fixture.pool)
	for index, expected := range []int{0, 5, 0} {
		removed, err := retention.Prune(t.Context(), retentionNow())
		if err != nil || removed != expected {
			t.Fatalf("Bounded sweep %d removed=%d, error=%v, want %d", index, removed, err, expected)
		}
	}
	if receiptCount(t, fixture) != 100 {
		t.Fatal("A receipt without a successful completion audit was deleted")
	}
	executeReceiptSQL(t, fixture.pool, `insert into management_audit
		(principal_id, source, action, target_key, outcome, details, occurred_at)
		select principal_id, 'http', operation, target_key, 'succeeded',
		jsonb_build_object('commandId', command_id), $1 from management_command_receipts`, old)
	removed, err := retention.Prune(t.Context(), retentionNow())
	if err != nil || removed != 100 || receiptCount(t, fixture) != 0 {
		t.Fatalf("Wrapped cursor did not revisit newly completed receipts: removed=%d, error=%v", removed, err)
	}
}

// notifyQueryClose lets a separate database connection change a result after
// candidates are read. It does not inspect SQL or substitute query responses.
type notifyQueryClose struct {
	database.Querier
	closed func()
}

func (sql notifyQueryClose) Query(ctx context.Context, statement string, arguments ...any) (pgx.Rows, error) {
	rows, err := sql.Querier.Query(ctx, statement, arguments...)
	if err != nil {
		return nil, err
	}
	return &notifyingRows{Rows: rows, closed: sql.closed}, nil
}

type notifyingRows struct {
	pgx.Rows
	once   sync.Once
	closed func()
}

func (rows *notifyingRows) Close() {
	rows.Rows.Close()
	rows.once.Do(rows.closed)
}

func TestPostgresReceiptRetentionPreservesAConcurrentlyChangedResponse(t *testing.T) {
	fixture := receiptDatabase(t)
	key := receiptKey(fixture, "concurrently-changed")
	old := retentionNow().Add(-31 * 24 * time.Hour)
	insertReceipt(t, fixture, key, `{"status":"completed"}`, old)
	insertAudit(t, fixture, key, "succeeded", old)
	var changeError error
	changed := false
	notifier := notifyQueryClose{Querier: fixture.pool, closed: func() {
		_, changeError = fixture.observer.Exec(t.Context(), `update management_command_receipts
			set result = '{"status":"pending","value":"changed"}'::jsonb
			where principal_id = $1 and operation = $2 and command_id = $3`,
			fixture.principalID, key.Operation, key.CommandID)
		changed = changeError == nil
	}}
	retention := commands.NewPostgresReceiptRetention(notifier)
	removed, err := retention.Prune(t.Context(), retentionNow())
	if changeError != nil || !changed {
		t.Fatalf("Concurrent fixture response update did not complete: %v", changeError)
	}
	if err != nil || removed != 0 {
		t.Fatalf("Cleanup removed a changed response: removed=%d, error=%v", removed, err)
	}
	requireReceiptResult(t, lookupReceipt(t, fixture, key), `{"status":"pending","value":"changed"}`)
	if auditCount(t, fixture, key.CommandID) != 1 {
		t.Fatal("Concurrent response update lost the command completion audit")
	}
}
