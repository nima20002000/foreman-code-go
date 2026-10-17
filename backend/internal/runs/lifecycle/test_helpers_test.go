package lifecycle_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/runs/lifecycle"
)

type stopPortFunc func(context.Context, string) (lifecycle.StopWork, error)

func (f stopPortFunc) PrepareStop(ctx context.Context, runID string) (lifecycle.StopWork, error) {
	return f(ctx, runID)
}

type stopWork struct {
	close  func(context.Context) error
	settle func(context.Context) (bool, error)
}

func (w stopWork) CloseNative(ctx context.Context) error { return w.close(ctx) }

func (w stopWork) Settle(ctx context.Context) (bool, error) { return w.settle(ctx) }

func gate(t *testing.T) chan struct{} {
	t.Helper()
	ready := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-ready:
		default:
			close(ready)
		}
	})
	return ready
}

func coordinator(t *testing.T, drive lifecycle.Drive, stops lifecycle.StopPort, limit int) *lifecycle.Coordinator {
	t.Helper()
	if stops == nil {
		stops = stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
			return nil, errors.New("unexpected Stop")
		})
	}
	c, err := lifecycle.New(drive, stops, limit)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func receive[T any](t *testing.T, values <-chan T) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("the expected public operation did not complete")
		var zero T
		return zero
	}
}

func pending(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Fatal("the operation finished before its required dependency")
	default:
	}
}

func waitTask(t *testing.T, task *lifecycle.Task) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return task.Wait(ctx)
}

func waitStop(t *testing.T, task *lifecycle.StopTask) (bool, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return task.Wait(ctx)
}

func errorCode(t *testing.T, err error, expected string) {
	t.Helper()
	domain, ok := domainerror.As(err)
	if !ok || domain.Code != expected {
		t.Fatalf("error = %v; want domain code %s", err, expected)
	}
}

func mustStart(t *testing.T, c *lifecycle.Coordinator, runID string) *lifecycle.Task {
	t.Helper()
	task, err := c.Start(runID)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func mustResume(t *testing.T, c *lifecycle.Coordinator, runID string) *lifecycle.Task {
	t.Helper()
	task, err := c.Resume(runID)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func mustStop(t *testing.T, c *lifecycle.Coordinator, ctx context.Context, runID string) *lifecycle.StopTask {
	t.Helper()
	task, err := c.Stop(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	return task
}
