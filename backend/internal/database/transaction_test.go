package database_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

type transactionSession struct {
	database.Querier
	failures       map[int]error
	executions     int
	releases       int
	discardCause   error
	lastContextErr error
}

func (session *transactionSession) Exec(ctx context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
	session.executions++
	session.lastContextErr = context.Cause(ctx)
	return pgconn.CommandTag{}, session.failures[session.executions]
}

func (session *transactionSession) Release(cause error) {
	session.releases++
	session.discardCause = cause
}

type transactionPool struct {
	sessions []*transactionSession
	acquired int
}

func (pool *transactionPool) Acquire(context.Context) (database.Session, error) {
	if pool.acquired >= len(pool.sessions) {
		return nil, errors.New("unexpected additional connection acquisition")
	}
	session := pool.sessions[pool.acquired]
	pool.acquired++
	return session, nil
}

func transactionOptions() database.TransactionOptions {
	return database.TransactionOptions{Logger: slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))}
}

func TestTransactionSuccessReleasesItsSession(t *testing.T) {
	session := &transactionSession{}
	pool := &transactionPool{sessions: []*transactionSession{session}}
	called := false
	err := database.WithTransaction(context.Background(), pool, func(context.Context, database.Querier) error {
		called = true
		return nil
	}, transactionOptions())
	if err != nil || !called || session.releases != 1 || session.discardCause != nil {
		t.Fatalf("Unexpected successful transaction cleanup: called=%v, releases=%d, discard=%v, error=%v",
			called, session.releases, session.discardCause, err)
	}
}

func TestTransactionFailurePreservesTheOriginalError(t *testing.T) {
	failure := errors.New("work failed")
	session := &transactionSession{}
	pool := &transactionPool{sessions: []*transactionSession{session}}
	err := database.WithTransaction(context.Background(), pool, func(context.Context, database.Querier) error {
		return failure
	}, transactionOptions())
	if err != failure || session.releases != 1 || session.discardCause != nil {
		t.Fatalf("Unexpected failed transaction cleanup: releases=%d, discard=%v, error=%v",
			session.releases, session.discardCause, err)
	}
}

func TestRollbackFailureDiscardsWithoutReplacingTheWorkError(t *testing.T) {
	failure := &pgconn.PgError{Code: "40001", Message: "serialization conflict"}
	rollbackFailure := errors.New("rollback connection failed")
	session := &transactionSession{failures: map[int]error{2: rollbackFailure}}
	pool := &transactionPool{sessions: []*transactionSession{session}}
	var log bytes.Buffer
	options := transactionOptions()
	options.Logger = slog.New(slog.NewJSONHandler(&log, nil))
	options.ConflictRetries = 2
	err := database.WithTransaction(context.Background(), pool, func(context.Context, database.Querier) error {
		return failure
	}, options)
	if err != failure || session.releases != 1 || session.discardCause != rollbackFailure || pool.acquired != 1 || log.Len() == 0 {
		t.Fatalf("Rollback failure was not preserved and discarded: releases=%d, acquired=%d, discard=%v, error=%v",
			session.releases, pool.acquired, session.discardCause, err)
	}
}

func TestTransactionConflictRetriesWithAFreshSession(t *testing.T) {
	first, second := &transactionSession{}, &transactionSession{}
	pool := &transactionPool{sessions: []*transactionSession{first, second}}
	options := transactionOptions()
	options.ConflictRetries = 1
	attempts := 0
	err := database.WithTransaction(context.Background(), pool, func(context.Context, database.Querier) error {
		attempts++
		if attempts == 1 {
			return &pgconn.PgError{Code: "40P01", Message: "deadlock"}
		}
		return nil
	}, options)
	if err != nil || attempts != 2 || pool.acquired != 2 || first.releases != 1 || second.releases != 1 {
		t.Fatalf("Unexpected replay-safe retry: attempts=%d, acquired=%d, releases=%d/%d, error=%v",
			attempts, pool.acquired, first.releases, second.releases, err)
	}
}

func TestCommitFailureRollsBackAndKeepsTheCommitError(t *testing.T) {
	failure := errors.New("commit acknowledgment failed")
	rollbackFailure := errors.New("rollback socket closed")
	session := &transactionSession{failures: map[int]error{2: failure, 3: rollbackFailure}}
	pool := &transactionPool{sessions: []*transactionSession{session}}
	err := database.WithTransaction(context.Background(), pool, func(context.Context, database.Querier) error {
		return nil
	}, transactionOptions())
	if err != failure || session.discardCause != rollbackFailure || session.releases != 1 {
		t.Fatalf("Commit failure cleanup lost its error: releases=%d, discard=%v, error=%v", session.releases, session.discardCause, err)
	}
}

func TestBeginFailureDoesNotRunWorkAndAlwaysReleases(t *testing.T) {
	failure := errors.New("begin failed")
	session := &transactionSession{failures: map[int]error{1: failure}}
	pool := &transactionPool{sessions: []*transactionSession{session}}
	err := database.WithTransaction(context.Background(), pool, func(context.Context, database.Querier) error {
		t.Fatal("Work ran after BEGIN failed")
		return nil
	}, transactionOptions())
	if err != failure || session.releases != 1 {
		t.Fatalf("Failed BEGIN did not release its session: releases=%d, error=%v", session.releases, err)
	}
}

func TestRollbackRunsAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("request cancelled")
	session := &transactionSession{}
	pool := &transactionPool{sessions: []*transactionSession{session}}
	err := database.WithTransaction(ctx, pool, func(context.Context, database.Querier) error {
		cancel(cause)
		return cause
	}, transactionOptions())
	if err != cause || session.lastContextErr != nil || session.releases != 1 {
		t.Fatalf("Cancellation prevented cleanup: cleanup context=%v, releases=%d, error=%v", session.lastContextErr, session.releases, err)
	}
}

func TestCallerOwnedTransactionDoesNotReleaseTheSession(t *testing.T) {
	session := &transactionSession{}
	err := database.WithClientTransaction(context.Background(), session, func(context.Context, database.Querier) error {
		return nil
	}, transactionOptions())
	if err != nil || session.releases != 0 {
		t.Fatalf("Caller-owned session was released: releases=%d, error=%v", session.releases, err)
	}
}

func TestTransactionPanicStillReleasesTheSession(t *testing.T) {
	session := &transactionSession{}
	pool := &transactionPool{sessions: []*transactionSession{session}}
	defer func() {
		if recovered := recover(); recovered != "work panic" || session.releases != 1 {
			t.Fatalf("Panic cleanup failed: panic=%v, releases=%d", recovered, session.releases)
		}
	}()
	_ = database.WithTransaction(context.Background(), pool, func(context.Context, database.Querier) error {
		panic("work panic")
	}, transactionOptions())
}
