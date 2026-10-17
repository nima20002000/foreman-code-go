//go:build integration

package database_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

func TestPostgresCancelledStatementLeavesThePoolUsable(t *testing.T) {
	pool, observer := transactionDatabase(t)
	ctx, cancel := context.WithCancelCause(t.Context())
	defer cancel(nil)
	cause := errors.New("the caller cancelled an active database statement")
	started := make(chan int, 1)
	finished := make(chan error, 1)
	go func() {
		finished <- database.WithTransaction(ctx, pool, func(ctx context.Context, transaction database.Querier) error {
			var pid int
			if err := transaction.QueryRow(ctx, "select pg_backend_pid()").Scan(&pid); err != nil {
				return err
			}
			if _, err := transaction.Exec(ctx, "insert into transaction_entries (id) values ($1)", "cancelled-statement"); err != nil {
				return err
			}
			started <- pid
			_, err := transaction.Exec(ctx, "select pg_sleep(30)")
			return err
		}, transactionOptions())
	}()

	observation, stopObservation := context.WithTimeout(t.Context(), 4*time.Second)
	defer stopObservation()
	select {
	case pid := <-started:
		if err := awaitPostgresSleep(observation, observer, pid); err != nil {
			t.Fatalf("Observe the fixture's active statement before cancellation: %v", err)
		}
	case err := <-finished:
		t.Fatalf("The transaction finished before its cancellable statement: %v", err)
	case <-observation.Done():
		t.Fatal("The transaction did not reach its cancellable statement")
	}
	cancel(cause)
	completion, stopCompletion := context.WithTimeout(t.Context(), 5*time.Second)
	defer stopCompletion()
	select {
	case err := <-finished:
		if !errors.Is(err, cause) {
			t.Fatalf("Active-statement cancellation lost the caller's cause: %v", err)
		}
	case <-completion.Done():
		t.Fatal("The cancelled statement did not release its transaction")
	}
	requireTransactionEntries(t, observer)
	err := database.WithTransaction(t.Context(), pool, func(ctx context.Context, transaction database.Querier) error {
		_, err := transaction.Exec(ctx, "insert into transaction_entries (id) values ($1)", "after-cancellation")
		return err
	}, transactionOptions())
	if err != nil {
		t.Fatalf("Use the pool after cancelling an active statement: %v", err)
	}
	requireTransactionEntries(t, observer, "after-cancellation")
}

func awaitPostgresSleep(ctx context.Context, observer *database.DB, pid int) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waitEvent string
		err := observer.QueryRow(ctx, "select coalesce(wait_event, '') from pg_stat_activity where pid=$1", pid).Scan(&waitEvent)
		if err != nil {
			return fmt.Errorf("observe the transaction's PostgreSQL backend: %w", err)
		}
		if waitEvent == "PgSleep" {
			return nil
		}
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-ticker.C:
		}
	}
}
