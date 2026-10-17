package database_test

import (
	"context"
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

func TestReadAcquisitionRetriesOnceAndReturnsTheConnection(t *testing.T) {
	attempts := 0
	value, err := database.WithReadRetry(context.Background(), func(ctx context.Context) (string, error) {
		return database.AcquireConnection(ctx, func(context.Context) (string, error) {
			attempts++
			if attempts == 1 {
				return "", &database.PoolTimeoutError{}
			}
			return "acquired", nil
		})
	})
	if err != nil || value != "acquired" || attempts != 2 {
		t.Fatalf("Unexpected acquisition: value=%q, attempts=%d, error=%v", value, attempts, err)
	}
}

func TestReadAcquisitionBudgetIsSharedAcrossTheOperation(t *testing.T) {
	attempts := 0
	acquire := func(context.Context) (string, error) {
		attempts++
		if attempts == 2 {
			return "acquired", nil
		}
		return "", &database.PoolTimeoutError{}
	}
	_, err := database.WithReadRetry(context.Background(), func(ctx context.Context) (string, error) {
		if _, err := database.AcquireConnection(ctx, acquire); err != nil {
			return "", err
		}
		return database.AcquireConnection(ctx, acquire)
	})
	if !database.IsPoolTimeout(err) || attempts != 3 {
		t.Fatalf("Expected one shared acquisition retry, attempts=%d, error=%v", attempts, err)
	}
}

func TestWriteAcquisitionAndQueryFailuresDoNotRetry(t *testing.T) {
	attempts := 0
	_, err := database.AcquireConnection(context.Background(), func(context.Context) (int, error) {
		attempts++
		return 0, &database.PoolTimeoutError{}
	})
	if !database.IsPoolTimeout(err) || attempts != 1 {
		t.Fatalf("Write acquisition retried: attempts=%d, error=%v", attempts, err)
	}
	queryError := &database.ReadTimeoutError{}
	attempts = 0
	_, err = database.WithReadRetry(context.Background(), func(ctx context.Context) (int, error) {
		return database.AcquireConnection(ctx, func(context.Context) (int, error) {
			attempts++
			return 0, queryError
		})
	})
	if err != queryError || attempts != 1 {
		t.Fatalf("A query failure caused an acquisition retry: attempts=%d, error=%v", attempts, err)
	}
}

func TestCancelledReadDoesNotRetryAnAcquisition(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("read cancelled")
	attempts := 0
	_, err := database.WithReadRetry(ctx, func(ctx context.Context) (int, error) {
		return database.AcquireConnection(ctx, func(context.Context) (int, error) {
			attempts++
			cancel(cause)
			return 0, &database.PoolTimeoutError{}
		})
	})
	if err != cause || attempts != 1 {
		t.Fatalf("Cancelled read retried: attempts=%d, error=%v", attempts, err)
	}
}
