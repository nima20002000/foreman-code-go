// Package commands persists management command retry records.
package commands

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// ReceiptQuery is database lookup metadata, not a management command contract.
// The command coordinator supplies authorized receipt principals and the hash
// produced by the shared contracts' command identity implementation.
type ReceiptQuery struct {
	PrincipalIDs []string
	Operation    string
	CommandID    string
	TargetKey    string
	InputHash    string
}

// Receipt holds the issuing principal and the original persisted response bytes.
// Decoding the response belongs to the caller's generated contract adapter.
type Receipt struct {
	PrincipalID string
	Result      json.RawMessage
}

// LookupReceipt reads a retry response or its durable completion fence. It must
// run after live authorization under the coordinator's command lock, including
// retries. It does not authorize callers, acquire locks, or perform mutations.
func LookupReceipt(ctx context.Context, sql database.Querier, input ReceiptQuery) (*Receipt, error) {
	var receipt Receipt
	var inputHash, targetKey string
	err := sql.QueryRow(ctx, `select principal_id, input_hash, target_key, result
		from management_command_receipts
		where principal_id = any($1::text[]) and operation = $2 and command_id = $3
		order by principal_id limit 1`,
		input.PrincipalIDs, input.Operation, input.CommandID).
		Scan(&receipt.PrincipalID, &inputHash, &targetKey, &receipt.Result)
	if err == nil {
		if inputHash != input.InputHash || targetKey != input.TargetKey {
			return nil, domainerror.New("COMMAND_ID_CONFLICT",
				"This command ID was already used with different input.", 409, nil)
		}
		return &receipt, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var commandID string
	err = sql.QueryRow(ctx, `select details->>'commandId'
		from management_audit where principal_id = any($1::text[]) and action = $2
		and details->>'commandId' = $3 and outcome = 'succeeded' limit 1`,
		input.PrincipalIDs, input.Operation, input.CommandID).Scan(&commandID)
	if err == nil {
		return nil, ExpiredCommandResult()
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return nil, err
}

// ExpiredCommandResult preserves the frozen public failure for a response that
// was pruned after its command completed. The command must never run again.
func ExpiredCommandResult() *domainerror.Error {
	return domainerror.New("COMMAND_RESULT_EXPIRED",
		"This command already completed, but its saved response has expired. Read the current state before sending a new command.",
		409, nil)
}
