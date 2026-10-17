package database

import (
	"context"
	"log/slog"
	"time"
)

// RetryOptions bounds retries of replay-safe database bookkeeping. Nil Timeout
// uses 30 seconds; an explicitly nonpositive timeout is rejected.
type RetryOptions struct {
	Timeout *time.Duration
	Check   func() error
	Logger  *slog.Logger
}

// InvalidRetryTimeoutError identifies an invalid retry budget while preserving
// the public TypeScript diagnostic returned before any work is attempted.
type InvalidRetryTimeoutError struct {
	Timeout time.Duration
}

func (err *InvalidRetryTimeoutError) Error() string {
	return "Database retry timeout must be positive."
}

// RetryTimeout retries replay-safe bookkeeping only. Never pass native submissions here.
func RetryTimeout[T any](ctx context.Context, work func(context.Context) (T, error), options RetryOptions) (T, error) {
	return RetryOperation(ctx, work, IsTimeout, options)
}

// RetryOperation uses the existing 100ms exponential backoff, capped at one second.
// Cancellation and Check run before work and after both successful and failed work.
func RetryOperation[T any](ctx context.Context, work func(context.Context) (T, error), retryable func(error) bool, options RetryOptions) (T, error) {
	var zero T
	timeout := 30 * time.Second
	if options.Timeout != nil {
		timeout = *options.Timeout
	}
	if timeout <= 0 {
		return zero, &InvalidRetryTimeoutError{Timeout: timeout}
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	started := time.Now()
	delay := 100 * time.Millisecond
	attempts := 0
	for {
		if err := checkRetry(ctx, options.Check); err != nil {
			return zero, err
		}
		result, err := work(ctx)
		if checkError := checkRetry(ctx, options.Check); checkError != nil {
			return zero, checkError
		}
		if err == nil {
			return result, nil
		}
		if !retryable(err) {
			return zero, err
		}
		attempts++
		elapsed := time.Since(started)
		nextDelay := min(delay, max(0, timeout-elapsed))
		logger.WarnContext(ctx, "Database operation is temporarily unavailable; retrying.",
			"component", "engine", "operation", "retry database operation", "err", err,
			"attempt", attempts, "elapsedMs", elapsed.Milliseconds(), "nextRetryMs", nextDelay.Milliseconds())
		if elapsed >= timeout {
			return zero, &RetryDeadlineError{Attempts: attempts, Elapsed: elapsed, Cause: err}
		}
		if err := wait(ctx, nextDelay); err != nil {
			return zero, err
		}
		delay = min(time.Second, delay*2)
	}
}

func checkRetry(ctx context.Context, check func() error) error {
	if err := context.Cause(ctx); err != nil {
		return err
	}
	if check != nil {
		return check()
	}
	return nil
}
