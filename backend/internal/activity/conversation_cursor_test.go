package activity_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/nima20002000/foreman-code-go/backend/internal/activity"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

type conversationCursorCheck func(context.Context, database.Querier, string, *string) error

func conversationCursorChecks() []struct {
	name  string
	check conversationCursorCheck
} {
	return []struct {
		name  string
		check conversationCursorCheck
	}{
		{"MESSAGE_HISTORY", activity.AssertConversationMessageCursor},
		{"TURN_HISTORY", activity.AssertConversationTurnCursor},
		{"ACTIVITY", activity.AssertConversationActivityCursor},
	}
}

func TestConversationCursorDistinguishesMissingAndForeignAnchors(t *testing.T) {
	before := "9223372036854775807"
	for _, source := range conversationCursorChecks() {
		t.Run(source.name, func(t *testing.T) {
			err := source.check(t.Context(), cursorDatabase{row: cursorRow{owner: "conversation-one"}},
				"conversation-one", &before)
			if err != nil {
				t.Fatalf("Reject the conversation's own anchor: %v", err)
			}
			err = source.check(t.Context(), cursorDatabase{row: cursorRow{owner: "conversation-two"}},
				"conversation-one", &before)
			requireConversationCursorError(t, err, source.name+"_CURSOR_SCOPE_CONFLICT", 409,
				"The cursor belongs to another conversation.")
			err = source.check(t.Context(), cursorDatabase{row: cursorRow{err: pgx.ErrNoRows}},
				"conversation-one", &before)
			requireConversationCursorError(t, err, source.name+"_CURSOR_EXPIRED", 410,
				"The cursor source is unavailable. Reload this conversation.")
		})
	}
}

func TestConversationFirstPageNeedsNoStoredAnchor(t *testing.T) {
	for _, source := range conversationCursorChecks() {
		t.Run(source.name, func(t *testing.T) {
			// A nil query would fail if a first-page request touched storage.
			if err := source.check(t.Context(), nil, "conversation-one", nil); err != nil {
				t.Fatalf("First page requires an anchor: %v", err)
			}
		})
	}
}

func TestConversationCursorPreservesReadFailures(t *testing.T) {
	before := "1"
	for _, source := range conversationCursorChecks() {
		t.Run(source.name, func(t *testing.T) {
			for _, cause := range []error{errors.New("read unavailable"), context.Canceled, context.DeadlineExceeded} {
				err := source.check(t.Context(), cursorDatabase{row: cursorRow{err: cause}}, "conversation-one", &before)
				if !errors.Is(err, cause) {
					t.Fatalf("Cursor read replaced its failure: got %v, want %v", err, cause)
				}
			}
		})
	}
}

// The fake supplies row results through the existing database port. Assertions
// inspect public outcomes; they never inspect the SQL or a private member.
type cursorDatabase struct {
	database.Querier
	row pgx.Row
}

func (query cursorDatabase) QueryRow(context.Context, string, ...any) pgx.Row {
	return query.row
}

type cursorRow struct {
	owner string
	err   error
}

func (row cursorRow) Scan(destinations ...any) error {
	if row.err != nil {
		return row.err
	}
	*destinations[0].(*string) = row.owner
	return nil
}

func requireConversationCursorError(t *testing.T, err error, code string, status int, message string) {
	t.Helper()
	found, ok := domainerror.As(err)
	if !ok || found.Code != code || found.Status != status || found.Message != message {
		t.Fatalf("Wrong public conversation cursor failure: %#v", err)
	}
}
