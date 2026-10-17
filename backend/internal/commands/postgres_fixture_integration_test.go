//go:build integration

package commands_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/commands"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

type commandDatabase struct {
	pool        *database.DB
	observer    *database.DB
	principalID string
}

func receiptDatabase(t *testing.T) commandDatabase {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	fixture := testdb.New(t)
	options := fixture.Config()
	options.QueryTimeout = 30 * time.Minute
	options.LockTimeout = 5 * time.Second
	pool, err := database.OpenPool(t.Context(), options, "command-receipt-integration", nil)
	if err != nil {
		t.Fatalf("Open isolated command receipt database (%T)", err)
	}
	t.Cleanup(pool.Close)
	if err := schema.Prepare(t.Context(), pool, "langgraph"); err != nil {
		t.Fatalf("Restore the actual frozen TypeScript baseline: %v", err)
	}
	observer, err := database.OpenPool(t.Context(), options, "command-receipt-observer", nil)
	if err != nil {
		t.Fatalf("Open isolated receipt observer (%T)", err)
	}
	t.Cleanup(observer.Close)
	var principalID string
	if err := pool.QueryRow(t.Context(), "select principal_id from local_human_principal where singleton = true").Scan(&principalID); err != nil {
		t.Fatalf("Read the isolated baseline principal: %v", err)
	}
	return commandDatabase{pool: pool, observer: observer, principalID: principalID}
}

func receiptKey(fixture commandDatabase, commandID string) commands.ReceiptQuery {
	return commands.ReceiptQuery{
		PrincipalIDs: []string{fixture.principalID}, Operation: "workflow.update", CommandID: commandID,
		TargetKey: "workflow:fixture", InputHash: "hash-already-computed-by-the-contract-adapter",
	}
}

func insertReceipt(t *testing.T, fixture commandDatabase, key commands.ReceiptQuery, result string, createdAt time.Time) {
	t.Helper()
	executeReceiptSQL(t, fixture.pool, `insert into management_command_receipts
		(principal_id, operation, command_id, target_key, input_hash, result, created_at)
		values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
		key.PrincipalIDs[0], key.Operation, key.CommandID, key.TargetKey, key.InputHash, result, createdAt)
}

func insertAudit(t *testing.T, fixture commandDatabase, key commands.ReceiptQuery, outcome string, occurredAt time.Time) {
	t.Helper()
	executeReceiptSQL(t, fixture.pool, `insert into management_audit
		(principal_id, source, action, target_key, outcome, details, occurred_at)
		values ($1, 'http', $2, $3, $4, jsonb_build_object('commandId', $5::text), $6)`,
		key.PrincipalIDs[0], key.Operation, key.TargetKey, outcome, key.CommandID, occurredAt)
}

func executeReceiptSQL(t *testing.T, sql database.Querier, statement string, arguments ...any) {
	t.Helper()
	if _, err := sql.Exec(t.Context(), statement, arguments...); err != nil {
		t.Fatalf("Prepare or inspect owned receipt fixture: %v", err)
	}
}

func requireReceiptFailure(t *testing.T, err error, code string) {
	t.Helper()
	failure, ok := domainerror.As(err)
	if !ok || failure.Code != code || failure.Status != 409 {
		t.Fatalf("Receipt failure = %v, want %s (409)", err, code)
	}
}

func requireReceiptResult(t *testing.T, receipt *commands.Receipt, expected string) {
	t.Helper()
	if receipt == nil {
		t.Fatal("Persisted receipt was missing")
	}
	var actual, want any
	if err := json.Unmarshal(receipt.Result, &actual); err != nil {
		t.Fatalf("Read persisted receipt JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(expected), &want); err != nil {
		t.Fatalf("Read expected fixture JSON: %v", err)
	}
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("Persisted receipt response = %v, want %v", actual, want)
	}
}

func receiptCount(t *testing.T, fixture commandDatabase) int {
	t.Helper()
	var count int
	if err := fixture.observer.QueryRow(t.Context(), "select count(*) from management_command_receipts").Scan(&count); err != nil {
		t.Fatalf("Read remaining command receipts: %v", err)
	}
	return count
}

func auditCount(t *testing.T, fixture commandDatabase, commandID string) int {
	t.Helper()
	var count int
	if err := fixture.observer.QueryRow(t.Context(),
		"select count(*) from management_audit where details->>'commandId' = $1 and outcome = 'succeeded'", commandID).Scan(&count); err != nil {
		t.Fatalf("Read retained command completion audit: %v", err)
	}
	return count
}

func lookupReceipt(t *testing.T, fixture commandDatabase, key commands.ReceiptQuery) *commands.Receipt {
	t.Helper()
	var receipt *commands.Receipt
	err := database.WithTransaction(t.Context(), fixture.pool, func(ctx context.Context, sql database.Querier) error {
		var err error
		receipt, err = commands.LookupReceipt(ctx, sql, key)
		return err
	}, database.TransactionOptions{})
	if err != nil {
		t.Fatalf("Look up the persisted command response: %v", err)
	}
	return receipt
}
