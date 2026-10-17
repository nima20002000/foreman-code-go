// Package activity supplies cursor ownership checks for conversation read pages.
package activity

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// AssertConversationMessageCursor checks that the stored message anchor belongs
// to this conversation. Run it inside the page's shared repeatable-read transaction.
func AssertConversationMessageCursor(ctx context.Context, query database.Querier, conversationID string, before *string) error {
	return assertConversationCursor(ctx, query, conversationID, before,
		"select conversation_id from operator_conversation_messages where sequence=$1::bigint", "MESSAGE_HISTORY")
}

// AssertConversationTurnCursor checks the stored turn-sequence anchor inside the
// page's shared repeatable-read transaction.
func AssertConversationTurnCursor(ctx context.Context, query database.Querier, conversationID string, before *string) error {
	return assertConversationCursor(ctx, query, conversationID, before,
		"select conversation_id from operator_conversation_turns where turn_sequence=$1::bigint", "TURN_HISTORY")
}

// AssertConversationActivityCursor checks the stored activity anchor inside the
// page's shared repeatable-read transaction. It does not grant conversation access.
func AssertConversationActivityCursor(ctx context.Context, query database.Querier, conversationID string, before *string) error {
	return assertConversationCursor(ctx, query, conversationID, before,
		"select conversation_id from operator_conversation_activity where sequence=$1::bigint", "ACTIVITY")
}

func assertConversationCursor(ctx context.Context, query database.Querier, conversationID string, before *string, statement, prefix string) error {
	if before == nil {
		return nil
	}
	var owner string
	err := query.QueryRow(ctx, statement, *before).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return domainerror.New(prefix+"_CURSOR_EXPIRED",
			"The cursor source is unavailable. Reload this conversation.", 410, nil)
	}
	if err != nil {
		return err
	}
	if owner != conversationID {
		return domainerror.New(prefix+"_CURSOR_SCOPE_CONFLICT",
			"The cursor belongs to another conversation.", 409, nil)
	}
	return nil
}
