package database

import (
	"context"
	"sync/atomic"
	"time"
)

type readRetryKey struct{}
type readRetryBudget struct{ retried atomic.Bool }

// WithReadRetry creates one shared acquisition retry budget for a read operation.
// Pass the supplied context to every acquisition in that operation. It never
// repeats queries or grants a write operation permission to retry.
func WithReadRetry[T any](ctx context.Context, work func(context.Context) (T, error)) (T, error) {
	readContext := context.WithValue(ctx, readRetryKey{}, &readRetryBudget{})
	return work(readContext)
}

// AcquireConnection retries only a timed-out connection acquisition in an
// explicit read scope. The retry waits 50ms and shares its budget across callers.
func AcquireConnection[T any](ctx context.Context, acquire func(context.Context) (T, error)) (T, error) {
	var zero T
	if err := context.Cause(ctx); err != nil {
		return zero, err
	}
	result, err := acquire(ctx)
	if err == nil {
		return result, nil
	}
	read, _ := ctx.Value(readRetryKey{}).(*readRetryBudget)
	if read == nil || !IsPoolTimeout(err) {
		return zero, err
	}
	if cancellation := context.Cause(ctx); cancellation != nil {
		return zero, cancellation
	}
	if !read.retried.CompareAndSwap(false, true) {
		return zero, err
	}
	if err := wait(ctx, 50*time.Millisecond); err != nil {
		return zero, err
	}
	return acquire(ctx)
}

func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-timer.C:
		return nil
	}
}
