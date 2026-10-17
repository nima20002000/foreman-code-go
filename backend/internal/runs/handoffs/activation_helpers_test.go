package handoffs_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/handoffs"
)

type activationPort struct {
	entry   func(context.Context) (string, error)
	execute func(context.Context, string) ([]string, error)
}

func (p activationPort) EnsureEntryActivation(ctx context.Context) (string, error) {
	return p.entry(ctx)
}

func (p activationPort) ExecuteActivation(ctx context.Context, id string) ([]string, error) {
	return p.execute(ctx, id)
}

func activationRunner(t *testing.T, port activationPort, limit int) *handoffs.ActivationRunner {
	t.Helper()
	runner, err := handoffs.NewActivationRunner("run", port, limit)
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func activationGate(t *testing.T) chan struct{} {
	t.Helper()
	gate := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-gate:
		default:
			close(gate)
		}
	})
	return gate
}

func activationReceive(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-signal:
	case <-timer.C:
		t.Fatal("activation callback did not reach its gate")
	}
}

func activationPending(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
		t.Fatal("activation signal closed before the required callback returned")
	default:
	}
}

func activationWait(t *testing.T, task *handoffs.ActivationTask) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := task.Wait(ctx)
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("activation invocation did not return")
	}
	return err
}

func activationDrain(t *testing.T, task *handoffs.ActivationTask) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := task.WaitDrained(ctx); err != nil {
		t.Fatalf("activation callbacks did not drain: %v", err)
	}
}

func activationError(t *testing.T, task *handoffs.ActivationTask, message string) {
	t.Helper()
	err := activationWait(t, task)
	if err == nil || err.Error() != message {
		t.Fatalf("invocation error = %v, want %s", err, message)
	}
	activationDrain(t, task)
}
