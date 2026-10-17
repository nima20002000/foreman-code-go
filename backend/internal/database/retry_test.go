package database_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

func retryOptions() database.RetryOptions {
	return database.RetryOptions{Logger: slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))}
}

func TestDatabaseDeadlineKeepsTheLastErrorAndAttemptCount(t *testing.T) {
	timeout := time.Nanosecond
	options := retryOptions()
	options.Timeout = &timeout
	failure := &database.ReadTimeoutError{}
	_, err := database.RetryTimeout(context.Background(), func(context.Context) (int, error) { return 0, failure }, options)
	var deadline *database.RetryDeadlineError
	if !errors.As(err, &deadline) || deadline.Attempts != 1 || !errors.Is(err, failure) || deadline.Elapsed < timeout {
		t.Fatalf("Unexpected retry deadline: %v", err)
	}
}

func TestDatabaseRetryRejectsAnExplicitNonpositiveTimeout(t *testing.T) {
	for _, timeout := range []time.Duration{0, -time.Second} {
		options := retryOptions()
		options.Timeout = &timeout
		_, err := database.RetryTimeout(context.Background(), func(context.Context) (int, error) {
			t.Fatal("An invalid retry timeout allowed work to start")
			return 0, nil
		}, options)
		if err == nil {
			t.Fatal("Expected invalid timeout to fail")
		}
		var invalid *database.InvalidRetryTimeoutError
		if !errors.As(err, &invalid) || invalid.Timeout != timeout {
			t.Fatalf("The retry error did not identify its rejected timeout: %v", err)
		}
		if err.Error() != "Database retry timeout must be positive." {
			t.Fatalf("The public TypeScript retry diagnostic changed: %q", err.Error())
		}
	}
}

func TestDatabaseRetryDoesNotRepeatAPermanentFailure(t *testing.T) {
	failure := &pgconn.PgError{Code: "28P01", Message: "authentication failed"}
	attempts := 0
	_, err := database.RetryTimeout(context.Background(), func(context.Context) (int, error) {
		attempts++
		return 0, failure
	}, retryOptions())
	if err != failure || attempts != 1 {
		t.Fatalf("A permanent failure was retried: attempts=%d, error=%v", attempts, err)
	}
}

func TestDatabaseRetryRechecksCancellationAfterSuccess(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("run was stopped")
	_, err := database.RetryTimeout(ctx, func(context.Context) (int, error) {
		cancel(cause)
		return 42, nil
	}, retryOptions())
	if err != cause {
		t.Fatalf("A successful query hid cancellation: %v", err)
	}
}

func TestDatabaseRetryChecksTheExecutionBeforeAndAfterWork(t *testing.T) {
	checks := 0
	options := retryOptions()
	options.Check = func() error { checks++; return nil }
	value, err := database.RetryTimeout(context.Background(), func(context.Context) (int, error) { return 42, nil }, options)
	if err != nil || value != 42 || checks != 2 {
		t.Fatalf("Execution checks were not applied: value=%d, checks=%d, error=%v", value, checks, err)
	}
}
