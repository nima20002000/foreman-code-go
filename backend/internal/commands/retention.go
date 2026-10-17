package commands

import (
	"context"
	"slices"
	"time"
)

const CommandReceiptRetention = 30 * 24 * time.Hour
const receiptBatchSize = 100

// These operations contain retry snapshots. Other operations retain live
// bindings, workflow publication facts, or resumable external work permanently.
var retrySnapshotOperations = []string{
	"agent_chat_control", "operator_chat_control", "operator_chat_create",
	"workflow.create", "workflow.update", "workflow.reorder", "workflow.archive",
	"workflow.batch_archive", "workflow.restore",
	"workspace.archive", "workspace.batch_archive", "workspace.restore",
	"agent.create", "agent.update", "agent.archive", "agent.restore", "agent.clone", "agent.configuration.restore",
	"harness.defaults.update", "harness.instance.save", "harness.instance.check",
	"workspace.location.clear", "workspace.location.provision",
	"workspace.root.configuration.adopt", "workspace.root.managed.bind",
	"computer_sync_update", "ci_enrollment_update",
}

// ExpiringReceipt is an internal persistence projection used by retention.
// Status and completion may be absent; neither creates a new public DTO.
type ExpiringReceipt struct {
	PrincipalID        string
	Operation          string
	CommandID          string
	CreatedAt          time.Time
	CompletedAt        *time.Time
	Revision           int64
	Status             *string
	HasAcceptedControl bool
	HasAcknowledgment  bool
}

// ReceiptRetentionStore returns only candidates with a successful completion
// audit. Remove deletes the selected revision and leaves that audit intact.
type ReceiptRetentionStore interface {
	Candidates(context.Context, int) ([]ExpiringReceipt, error)
	Remove(context.Context, ExpiringReceipt) (bool, error)
}

// PruneCompletedCommandReceipts processes one bounded batch. A failed storage
// operation returns an error without presenting the cleanup as successful.
func PruneCompletedCommandReceipts(ctx context.Context, store ReceiptRetentionStore, now time.Time) (int, error) {
	rows, err := store.Candidates(ctx, receiptBatchSize)
	if err != nil {
		return 0, err
	}
	cutoff := now.Add(-CommandReceiptRetention)
	removed := 0
	for _, row := range rows {
		latest := row.CreatedAt
		if row.CompletedAt != nil && row.CompletedAt.After(latest) {
			latest = *row.CompletedAt
		}
		if !slices.Contains(retrySnapshotOperations, row.Operation) || !latest.Before(cutoff) || !receiptCompleted(row) {
			continue
		}
		deleted, err := store.Remove(ctx, row)
		if err != nil {
			return 0, err
		}
		if deleted {
			removed++
		}
	}
	return removed, nil
}

func receiptCompleted(row ExpiringReceipt) bool {
	chat := row.Operation == "agent_chat_control" || row.Operation == "operator_chat_control"
	if chat {
		return row.Status != nil && *row.Status == "completed" && (!row.HasAcceptedControl || row.HasAcknowledgment)
	}
	return row.Status == nil || *row.Status == "completed" || *row.Status == "succeeded"
}
