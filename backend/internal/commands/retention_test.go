package commands_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/commands"
)

type memoryRetentionStore struct {
	rows          []commands.ExpiringReceipt
	removed       []string
	limits        []int
	changed       map[string]bool
	candidatesErr error
	removeErr     error
}

func (store *memoryRetentionStore) Candidates(_ context.Context, limit int) ([]commands.ExpiringReceipt, error) {
	store.limits = append(store.limits, limit)
	if store.candidatesErr != nil {
		return nil, store.candidatesErr
	}
	return append([]commands.ExpiringReceipt(nil), store.rows[:min(limit, len(store.rows))]...), nil
}

func (store *memoryRetentionStore) Remove(_ context.Context, row commands.ExpiringReceipt) (bool, error) {
	if store.removeErr != nil {
		return false, store.removeErr
	}
	if store.changed[row.CommandID] {
		return false, nil
	}
	for index, current := range store.rows {
		if current.CommandID == row.CommandID {
			store.rows = slices.Delete(store.rows, index, index+1)
			store.removed = append(store.removed, row.CommandID)
			return true, nil
		}
	}
	return false, nil
}

func retentionNow() time.Time { return time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC) }

func oldReceipt(id string) commands.ExpiringReceipt {
	return commands.ExpiringReceipt{
		PrincipalID: "operator", Operation: "workflow.update", CommandID: id,
		CreatedAt: retentionNow().Add(-31 * 24 * time.Hour),
	}
}

func textPointer(value string) *string { return &value }

func TestRetentionKeepsUnresolvedAndPermanentReceipts(t *testing.T) {
	now := retentionNow()
	recentCompletion := now.Add(-24 * time.Hour)
	kept := []commands.ExpiringReceipt{
		{CommandID: "fresh", Operation: "workflow.update", CreatedAt: now.Add(-29 * 24 * time.Hour)},
		{CommandID: "boundary", Operation: "workflow.update", CreatedAt: now.Add(-30 * 24 * time.Hour)},
		{CommandID: "recently-completed", Operation: "workflow.update", CreatedAt: now.Add(-31 * 24 * time.Hour), CompletedAt: &recentCompletion},
		{CommandID: "pending", Operation: "agent_chat_control", Status: textPointer("pending")},
		{CommandID: "uncertain", Operation: "operator_chat_control", Status: textPointer("uncertain")},
		{CommandID: "unacknowledged", Operation: "agent_chat_control", Status: textPointer("completed"), HasAcceptedControl: true},
		{CommandID: "control-without-status", Operation: "operator_chat_control"},
		{CommandID: "pending-workflow", Operation: "workflow.update", Status: textPointer("pending")},
		{CommandID: "binding", Operation: "job.inputs.bind"},
		{CommandID: "artifact", Operation: "remote.native-artifact.output"},
		{CommandID: "workflow-version", Operation: "workflow.save.v3"},
		{CommandID: "repository-recovery", Operation: "workspace.location.set"},
		{CommandID: "future-operation", Operation: "unrecognized"},
	}
	expired := []commands.ExpiringReceipt{
		oldReceipt("ordinary"),
		{CommandID: "acknowledged", Operation: "agent_chat_control", Status: textPointer("completed"), HasAcceptedControl: true, HasAcknowledgment: true},
		{CommandID: "completed-without-control", Operation: "operator_chat_control", Status: textPointer("completed")},
		{CommandID: "succeeded", Operation: "workflow.update", Status: textPointer("succeeded")},
	}
	store := &memoryRetentionStore{rows: append(append([]commands.ExpiringReceipt(nil), kept...), expired...)}
	removed, err := commands.PruneCompletedCommandReceipts(t.Context(), store, now)
	if err != nil || removed != len(expired) {
		t.Fatalf("Cleanup removed %d receipts with error %v, want %d", removed, err, len(expired))
	}
	if !slices.EqualFunc(store.rows, kept, func(a, b commands.ExpiringReceipt) bool { return a.CommandID == b.CommandID }) {
		t.Fatal("Cleanup removed a fresh, unresolved, or permanent receipt")
	}
	if !slices.Equal(store.removed, []string{"ordinary", "acknowledged", "completed-without-control", "succeeded"}) {
		t.Fatalf("Cleanup removed unexpected receipts: %v", store.removed)
	}
}

func TestRetentionLimitsEachSweepToOneHundredReceipts(t *testing.T) {
	store := &memoryRetentionStore{}
	for index := 0; index < 105; index++ {
		store.rows = append(store.rows, oldReceipt(fmt.Sprintf("command-%03d", index)))
	}
	removed, err := commands.PruneCompletedCommandReceipts(t.Context(), store, retentionNow())
	if err != nil || removed != 100 || len(store.rows) != 5 {
		t.Fatalf("First bounded sweep: removed=%d, retained=%d, error=%v", removed, len(store.rows), err)
	}
	removed, err = commands.PruneCompletedCommandReceipts(t.Context(), store, retentionNow())
	if err != nil || removed != 5 || len(store.rows) != 0 || !slices.Equal(store.limits, []int{100, 100}) {
		t.Fatalf("Second bounded sweep: removed=%d, retained=%d, limits=%v, error=%v", removed, len(store.rows), store.limits, err)
	}
}

func TestRetentionDoesNotCountConcurrentRevisionChanges(t *testing.T) {
	store := &memoryRetentionStore{
		rows:    []commands.ExpiringReceipt{oldReceipt("changed"), oldReceipt("unchanged")},
		changed: map[string]bool{"changed": true},
	}
	removed, err := commands.PruneCompletedCommandReceipts(t.Context(), store, retentionNow())
	if err != nil || removed != 1 || len(store.rows) != 1 || store.rows[0].CommandID != "changed" {
		t.Fatalf("Concurrent change was not retained: removed=%d, rows=%v, error=%v", removed, store.rows, err)
	}
}

func TestRetentionPropagatesStorageFailures(t *testing.T) {
	for _, operation := range []string{"candidates", "remove"} {
		t.Run(operation, func(t *testing.T) {
			cause := errors.New("receipt storage unavailable")
			store := &memoryRetentionStore{rows: []commands.ExpiringReceipt{oldReceipt("retained")}}
			if operation == "candidates" {
				store.candidatesErr = cause
			} else {
				store.removeErr = cause
			}
			removed, err := commands.PruneCompletedCommandReceipts(t.Context(), store, retentionNow())
			if !errors.Is(err, cause) || removed != 0 || len(store.rows) != 1 || len(store.removed) != 0 {
				t.Fatalf("Failed cleanup reported success: removed=%d, retained=%d, error=%v", removed, len(store.rows), err)
			}
		})
	}
}
