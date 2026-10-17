//go:build integration

package database_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

func TestPostgresTransactionCommitsPersistedWrites(t *testing.T) {
	pool, observer := transactionDatabase(t)
	err := database.WithTransaction(t.Context(), pool, func(ctx context.Context, transaction database.Querier) error {
		_, err := transaction.Exec(ctx, "insert into transaction_entries (id) values ($1)", "committed")
		return err
	}, transactionOptions())
	if err != nil {
		t.Fatalf("Commit the transaction: %v", err)
	}
	requireTransactionEntries(t, observer, "committed")
	if err := pool.Ping(t.Context()); err != nil {
		t.Fatalf("The single-connection pool was not released after commit: %v", err)
	}
}

func TestPostgresTransactionRollsBackAndReusesItsConnection(t *testing.T) {
	pool, observer := transactionDatabase(t)
	cause := errors.New("transaction work failed")
	var originalPID, nextPID int
	err := database.WithTransaction(t.Context(), pool, func(ctx context.Context, transaction database.Querier) error {
		if err := transaction.QueryRow(ctx, "select pg_backend_pid()").Scan(&originalPID); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, "insert into transaction_entries (id) values ($1)", "rolled-back"); err != nil {
			return err
		}
		return cause
	}, transactionOptions())
	if !errors.Is(err, cause) {
		t.Fatalf("Rollback must preserve the callback error: %v", err)
	}
	requireTransactionEntries(t, observer)
	err = database.WithTransaction(t.Context(), pool, func(ctx context.Context, transaction database.Querier) error {
		if err := transaction.QueryRow(ctx, "select pg_backend_pid()").Scan(&nextPID); err != nil {
			return err
		}
		_, err := transaction.Exec(ctx, "insert into transaction_entries (id) values ($1)", "after-rollback")
		return err
	}, transactionOptions())
	if err != nil {
		t.Fatalf("Use the pool after rollback: %v", err)
	}
	if originalPID != nextPID {
		t.Fatal("A successful rollback discarded the reusable PostgreSQL connection")
	}
	requireTransactionEntries(t, observer, "after-rollback")
}

func TestPostgresTransactionCallerCancellationPreventsCommit(t *testing.T) {
	pool, observer := transactionDatabase(t)
	ctx, cancel := context.WithCancelCause(t.Context())
	defer cancel(nil)
	cause := errors.New("the caller cancelled the transaction")
	err := database.WithTransaction(ctx, pool, func(ctx context.Context, transaction database.Querier) error {
		if _, err := transaction.Exec(ctx, "insert into transaction_entries (id) values ($1)", "cancelled"); err != nil {
			return err
		}
		cancel(cause)
		return nil
	}, transactionOptions())
	if !errors.Is(err, cause) {
		t.Fatalf("The transaction did not preserve caller cancellation: %v", err)
	}
	requireTransactionEntries(t, observer)
	if err := pool.Ping(t.Context()); err != nil {
		t.Fatalf("Caller cancellation prevented connection cleanup: %v", err)
	}
}

func TestPostgresRollbackFailureDiscardsOnlyTheLostConnection(t *testing.T) {
	pool, observer := transactionDatabase(t)
	cause := errors.New("transaction work failed after losing its connection")
	var lostPID, replacementPID int
	err := database.WithTransaction(t.Context(), pool, func(ctx context.Context, transaction database.Querier) error {
		if err := transaction.QueryRow(ctx, "select pg_backend_pid()").Scan(&lostPID); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, "insert into transaction_entries (id) values ($1)", "lost"); err != nil {
			return err
		}
		var terminated bool
		if err := observer.QueryRow(ctx, "select pg_terminate_backend($1)", lostPID).Scan(&terminated); err != nil {
			return err
		}
		if !terminated {
			return errors.New("the fixture's transaction connection was not terminated")
		}
		return cause
	}, transactionOptions())
	if !errors.Is(err, cause) {
		t.Fatalf("Failed rollback replaced the callback error: %v", err)
	}
	requireTransactionEntries(t, observer)
	err = database.WithTransaction(t.Context(), pool, func(ctx context.Context, transaction database.Querier) error {
		if err := transaction.QueryRow(ctx, "select pg_backend_pid()").Scan(&replacementPID); err != nil {
			return err
		}
		_, err := transaction.Exec(ctx, "insert into transaction_entries (id) values ($1)", "replacement")
		return err
	}, transactionOptions())
	if err != nil {
		t.Fatalf("The pool could not replace the lost connection: %v", err)
	}
	if replacementPID == lostPID {
		t.Fatal("The pool reused a terminated PostgreSQL connection")
	}
	requireTransactionEntries(t, observer, "replacement")
}

func transactionDatabase(t *testing.T) (*database.DB, *database.DB) {
	t.Helper()
	fixture := testdb.New(t)
	options := fixture.Config()
	options.MaxConnections = 1
	pool, err := database.Open(t.Context(), options, transactionOptions().Logger)
	if err != nil {
		t.Fatalf("Open the fixture transaction pool (%T)", err)
	}
	t.Cleanup(pool.Close)
	observer, err := database.Open(t.Context(), options, transactionOptions().Logger)
	if err != nil {
		t.Fatalf("Open the independent fixture observer (%T)", err)
	}
	t.Cleanup(observer.Close)
	if _, err := pool.Exec(t.Context(), "create table transaction_entries (id text primary key)"); err != nil {
		t.Fatalf("Create the transaction fixture table: %v", err)
	}
	return pool, observer
}

func requireTransactionEntries(t *testing.T, observer *database.DB, want ...string) {
	t.Helper()
	rows, err := observer.Query(t.Context(), "select id from transaction_entries order by id")
	if err != nil {
		t.Fatalf("Read committed transaction entries: %v", err)
	}
	defer rows.Close()
	var found []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("Read a transaction entry: %v", err)
		}
		found = append(found, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("Read the transaction result: %v", err)
	}
	if !slices.Equal(found, want) {
		t.Fatalf("Committed transaction entries = %v, want %v", found, want)
	}
}
