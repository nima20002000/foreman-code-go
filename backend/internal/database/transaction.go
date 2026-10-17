package database

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
)

// TransactionOptions controls one transaction. ConflictRetries is only for
// replay-safe callbacks; native submissions must not be retried here.
type TransactionOptions struct {
	Isolation       pgx.TxIsoLevel
	ReadOnly        bool
	ConflictRetries int
	Operation       string
	Logger          *slog.Logger
}

// WithTransaction commits successful work, rolls back failures without replacing
// their errors, always releases the session, and discards it if rollback fails.
// This module is the only application code that issues transaction controls.
func WithTransaction(ctx context.Context, pool Acquirer, perform func(context.Context, Querier) error, options TransactionOptions) error {
	begin, err := beginStatement(options)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		session, err := pool.Acquire(ctx)
		if err != nil {
			return err
		}
		err, rollbackFailed := runPooledTransaction(ctx, session, begin, perform, options)
		if err == nil || rollbackFailed || attempt >= options.ConflictRetries || !IsTransactionConflict(err) {
			return err
		}
	}
}

func runPooledTransaction(ctx context.Context, session Session, begin string, perform func(context.Context, Querier) error, options TransactionOptions) (error, bool) {
	var releaseError error
	defer func() { session.Release(releaseError) }()
	return runTransaction(ctx, session, begin, perform, options, true, func(rollbackError error) {
		releaseError = rollbackError
	})
}

// WithClientTransaction leaves session ownership with the caller. It does not
// roll back a failed BEGIN. Later failures preserve the original error and log
// rollback failure, matching the existing caller-owned transaction contract.
func WithClientTransaction(ctx context.Context, session Querier, perform func(context.Context, Querier) error, options TransactionOptions) error {
	begin, err := beginStatement(options)
	if err != nil {
		return err
	}
	err, _ = runTransaction(ctx, session, begin, perform, options, false, nil)
	return err
}

// InTransaction uses a supplied transaction without taking over its lifecycle.
func InTransaction(ctx context.Context, pool Acquirer, supplied Querier, perform func(context.Context, Querier) error) error {
	if supplied != nil {
		return perform(ctx, supplied)
	}
	return WithTransaction(ctx, pool, perform, TransactionOptions{})
}

func runTransaction(ctx context.Context, session Querier, begin string, perform func(context.Context, Querier) error, options TransactionOptions, rollbackFailedBegin bool, released func(error)) (err error, rollbackFailed bool) {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	timing := newTransactionTiming(logger, options.Operation)
	timed := &timedQuerier{Querier: session, timing: timing}
	began := false
	committed := false
	defer func() {
		if committed {
			timing.finish("committed")
			return
		}
		if !began {
			timing.finish("failed")
			if !rollbackFailedBegin {
				return
			}
		}
		rollbackQuery := Querier(timed)
		if !began {
			rollbackQuery = session
		}
		rollbackError := rollbackAfterFailure(ctx, rollbackQuery, logger)
		rollbackFailed = rollbackError != nil
		if released != nil {
			released(rollbackError)
		}
		if began {
			outcome := "rolled_back"
			if rollbackFailed {
				outcome = "failed"
			}
			timing.finish(outcome)
		}
	}()
	if _, err = timed.Exec(ctx, begin); err != nil {
		return err, false
	}
	began = true
	if err = perform(ctx, timed); err != nil {
		return err, false
	}
	if _, err = timed.Exec(ctx, "commit"); err != nil {
		return err, false
	}
	committed = true
	return nil, false
}

func beginStatement(options TransactionOptions) (string, error) {
	parts := []string{"begin"}
	if options.Isolation != "" {
		if options.Isolation != pgx.ReadCommitted && options.Isolation != pgx.RepeatableRead {
			return "", errors.New("transaction isolation must be read committed or repeatable read")
		}
		parts = append(parts, "isolation level", string(options.Isolation))
	}
	if options.ReadOnly {
		parts = append(parts, "read only")
	}
	return strings.Join(parts, " "), nil
}

func rollbackAfterFailure(ctx context.Context, session Querier, logger *slog.Logger) error {
	// A cancelled caller must not prevent transaction cleanup. The session's query
	// timeout still bounds cleanup, and failed cleanup discards a pooled session.
	cleanup := context.WithoutCancel(ctx)
	_, err := session.Exec(cleanup, "rollback")
	if err != nil {
		logger.ErrorContext(ctx, "Transaction rollback failed; discarding its connection",
			"component", "db", "operation", "transaction rollback", "err", err)
	}
	return err
}
