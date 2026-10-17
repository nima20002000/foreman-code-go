//go:build integration

package activity_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

func TestPostgresConversationCursorUsesItsPersistedSource(t *testing.T) {
	reader, _ := conversationCursorDatabase(t)
	before := "9223372036854775807"
	missing := "9223372036854775806"
	for _, source := range persistedConversationSources() {
		t.Run(source.name, func(t *testing.T) {
			if _, err := reader.Exec(t.Context(), source.insert, before, source.owner); err != nil {
				t.Fatalf("Persist the source anchor: %v", err)
			}
			if err := source.check(t.Context(), reader, source.owner, &before); err != nil {
				t.Fatalf("Read the persisted source anchor: %v", err)
			}
			requireConversationCursorError(t, source.check(t.Context(), reader, "other-conversation", &before),
				source.name+"_CURSOR_SCOPE_CONFLICT", 409, "The cursor belongs to another conversation.")
			requireConversationCursorError(t, source.check(t.Context(), reader, source.owner, &missing),
				source.name+"_CURSOR_EXPIRED", 410, "The cursor source is unavailable. Reload this conversation.")
		})
	}
}

func TestPostgresConversationCursorRetainsThePageSnapshotDuringWrites(t *testing.T) {
	reader, writer := conversationCursorDatabase(t)
	before := "7"
	for _, source := range persistedConversationSources() {
		t.Run(source.name, func(t *testing.T) {
			if _, err := writer.Exec(t.Context(), source.insert, before, source.owner); err != nil {
				t.Fatalf("Persist the initial source anchor: %v", err)
			}
			err := database.WithTransaction(t.Context(), reader, func(ctx context.Context, snapshot database.Querier) error {
				if err := source.check(ctx, snapshot, source.owner, &before); err != nil {
					return fmt.Errorf("read the initial page anchor: %w", err)
				}
				if _, err := writer.Exec(ctx, source.update, before, "replacement-owner"); err != nil {
					return fmt.Errorf("commit a concurrent owner change: %w", err)
				}
				if err := expectPersistedCursorFailure(source.check(ctx, writer, source.owner, &before),
					source.name+"_CURSOR_SCOPE_CONFLICT", 409); err != nil {
					return err
				}
				if err := source.check(ctx, snapshot, source.owner, &before); err != nil {
					return fmt.Errorf("owner changed inside the existing page snapshot: %w", err)
				}
				if _, err := writer.Exec(ctx, source.remove, before); err != nil {
					return fmt.Errorf("commit a concurrent anchor deletion: %w", err)
				}
				if err := expectPersistedCursorFailure(source.check(ctx, writer, source.owner, &before),
					source.name+"_CURSOR_EXPIRED", 410); err != nil {
					return err
				}
				return source.check(ctx, snapshot, source.owner, &before)
			}, database.TransactionOptions{Isolation: pgx.RepeatableRead, ReadOnly: true})
			if err != nil {
				t.Fatalf("The page lost its consistent source snapshot: %v", err)
			}
			requireConversationCursorError(t, source.check(t.Context(), reader, source.owner, &before),
				source.name+"_CURSOR_EXPIRED", 410, "The cursor source is unavailable. Reload this conversation.")
		})
	}
}

func conversationCursorDatabase(t *testing.T) (*database.DB, *database.DB) {
	t.Helper()
	fixture := testdb.New(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	reader, err := database.Open(t.Context(), fixture.Config(), logger)
	if err != nil {
		t.Fatalf("Open the owned cursor reader (%T)", err)
	}
	t.Cleanup(reader.Close)
	writer, err := database.Open(t.Context(), fixture.Config(), logger)
	if err != nil {
		t.Fatalf("Open the independent owned cursor writer (%T)", err)
	}
	t.Cleanup(writer.Close)
	// Only the physical anchor columns used by this read interface are needed.
	// Every table lives in the fixture's new, disposable PostgreSQL database.
	for _, statement := range []string{
		"create table operator_conversation_messages (sequence bigint primary key, conversation_id text not null)",
		"create table operator_conversation_turns (turn_sequence bigint primary key, conversation_id text not null)",
		"create table operator_conversation_activity (sequence bigint primary key, conversation_id text not null)",
	} {
		if _, err := reader.Exec(t.Context(), statement); err != nil {
			t.Fatalf("Create the owned cursor source: %v", err)
		}
	}
	return reader, writer
}

func persistedConversationSources() []struct {
	name   string
	owner  string
	check  conversationCursorCheck
	insert string
	update string
	remove string
} {
	checks := conversationCursorChecks()
	return []struct {
		name   string
		owner  string
		check  conversationCursorCheck
		insert string
		update string
		remove string
	}{
		{checks[0].name, "message-owner", checks[0].check,
			"insert into operator_conversation_messages (sequence, conversation_id) values ($1::bigint, $2)",
			"update operator_conversation_messages set conversation_id=$2 where sequence=$1::bigint",
			"delete from operator_conversation_messages where sequence=$1::bigint"},
		{checks[1].name, "turn-owner", checks[1].check,
			"insert into operator_conversation_turns (turn_sequence, conversation_id) values ($1::bigint, $2)",
			"update operator_conversation_turns set conversation_id=$2 where turn_sequence=$1::bigint",
			"delete from operator_conversation_turns where turn_sequence=$1::bigint"},
		{checks[2].name, "activity-owner", checks[2].check,
			"insert into operator_conversation_activity (sequence, conversation_id) values ($1::bigint, $2)",
			"update operator_conversation_activity set conversation_id=$2 where sequence=$1::bigint",
			"delete from operator_conversation_activity where sequence=$1::bigint"},
	}
}

func expectPersistedCursorFailure(err error, code string, status int) error {
	found, ok := domainerror.As(err)
	if !ok || found.Code != code || found.Status != status {
		return errors.New("the independent reader did not observe the committed cursor change")
	}
	return nil
}
