//go:build integration

package commands_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/commands"
)

func TestPostgresReceiptLookupReplaysOriginalResponseAndScopesIdentity(t *testing.T) {
	fixture := receiptDatabase(t)
	key := receiptKey(fixture, "command-replay")
	response := `{"value":"original","revision":2}`
	insertReceipt(t, fixture, key, response, retentionNow())
	insertAudit(t, fixture, key, "succeeded", retentionNow())
	for attempt := 0; attempt < 2; attempt++ {
		receipt := lookupReceipt(t, fixture, key)
		requireReceiptResult(t, receipt, response)
		if receipt.PrincipalID != fixture.principalID {
			t.Fatalf("Receipt changed its issuing principal: %s", receipt.PrincipalID)
		}
	}
	other := key
	other.PrincipalIDs = []string{"unrelated-principal"}
	if receipt := lookupReceipt(t, fixture, other); receipt != nil {
		t.Fatal("A different principal read the command receipt")
	}
	other.PrincipalIDs = []string{"replacement-principal", fixture.principalID}
	requireReceiptResult(t, lookupReceipt(t, fixture, other), response)
	other = key
	other.Operation = "workspace.archive"
	if receipt := lookupReceipt(t, fixture, other); receipt != nil {
		t.Fatal("A different operation reused the command receipt")
	}
	if auditCount(t, fixture, key.CommandID) != 1 || receiptCount(t, fixture) != 1 {
		t.Fatal("Reading a receipt changed its persisted identity or successful audit")
	}
}

func TestPostgresReceiptLookupRejectsChangedInputAndTarget(t *testing.T) {
	fixture := receiptDatabase(t)
	key := receiptKey(fixture, "command-conflict")
	insertReceipt(t, fixture, key, `{"value":"original"}`, retentionNow())
	changedInput := key
	changedInput.InputHash = "a-different-contract-input-hash"
	changedTarget := key
	changedTarget.TargetKey = "workflow:another"
	for _, input := range []commands.ReceiptQuery{changedInput, changedTarget} {
		receipt, err := commands.LookupReceipt(t.Context(), fixture.pool, input)
		requireReceiptFailure(t, err, "COMMAND_ID_CONFLICT")
		if receipt != nil {
			t.Fatal("A conflicting command received the saved response")
		}
	}
	requireReceiptResult(t, lookupReceipt(t, fixture, key), `{"value":"original"}`)
}

func TestPostgresReceiptLookupKeepsPrunedCommandsExpired(t *testing.T) {
	fixture := receiptDatabase(t)
	key := receiptKey(fixture, "command-expired")
	old := retentionNow().Add(-31 * 24 * time.Hour)
	insertReceipt(t, fixture, key, `{"value":"completed"}`, old)
	insertAudit(t, fixture, key, "succeeded", old)
	retention := commands.NewPostgresReceiptRetention(fixture.pool)
	removed, err := retention.Prune(t.Context(), retentionNow())
	if err != nil || removed != 1 {
		t.Fatalf("Expire completed retry response: removed=%d, error=%v", removed, err)
	}
	receipt, err := commands.LookupReceipt(t.Context(), fixture.pool, key)
	requireReceiptFailure(t, err, "COMMAND_RESULT_EXPIRED")
	if receipt != nil || receiptCount(t, fixture) != 0 || auditCount(t, fixture, key.CommandID) != 1 {
		t.Fatal("Pruning lost the completion fence or retained the expired response")
	}
}

func TestPostgresReceiptLookupDoesNotFenceFailedOrUnrelatedCommands(t *testing.T) {
	fixture := receiptDatabase(t)
	key := receiptKey(fixture, "command-new")
	insertAudit(t, fixture, key, "failed", retentionNow())
	insertAudit(t, fixture, key, "uncertain", retentionNow())
	other := key
	other.CommandID = "another-command"
	insertAudit(t, fixture, other, "succeeded", retentionNow())
	other = key
	other.Operation = "another.operation"
	insertAudit(t, fixture, other, "succeeded", retentionNow())
	other = key
	other.PrincipalIDs = []string{"another-principal"}
	insertAudit(t, fixture, other, "succeeded", retentionNow())
	if receipt := lookupReceipt(t, fixture, key); receipt != nil {
		t.Fatal("A command with no matching successful completion was treated as a replay")
	}
}

func TestPostgresReceiptLookupAndRetentionPreserveCallerCancellation(t *testing.T) {
	fixture := receiptDatabase(t)
	key := receiptKey(fixture, "command-cancelled")
	old := retentionNow().Add(-31 * 24 * time.Hour)
	insertReceipt(t, fixture, key, `{}`, old)
	insertAudit(t, fixture, key, "succeeded", old)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if receipt, err := commands.LookupReceipt(ctx, fixture.pool, key); !errors.Is(err, context.Canceled) || receipt != nil {
		t.Fatalf("Cancelled receipt lookup returned %v, %v", receipt, err)
	}
	retention := commands.NewPostgresReceiptRetention(fixture.pool)
	if removed, err := retention.Prune(ctx, retentionNow()); !errors.Is(err, context.Canceled) || removed != 0 {
		t.Fatalf("Cancelled receipt cleanup returned %d, %v", removed, err)
	}
	if receiptCount(t, fixture) != 1 || auditCount(t, fixture, key.CommandID) != 1 {
		t.Fatal("Cancellation changed the persisted receipt or audit")
	}
}
