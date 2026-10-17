package worker_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/command"
	"github.com/nima20002000/foreman-code-go/backend/internal/worker"
)

func TestWorkerCommandRegistersWithoutStartingOrCreatingState(t *testing.T) {
	state := filepath.Join(t.TempDir(), "not-created")
	var output bytes.Buffer
	calls := 0
	registry := command.Registry{}
	worker.RegisterCommand(registry, worker.CommandOptions{Output: &output, Handlers: map[worker.Action]worker.Handler{
		worker.Run: func(context.Context, worker.Invocation) error { calls++; return nil },
	}})
	err := command.Run(context.Background(), []string{"worker", "run", "--state", state, "--help"}, registry)
	if err != nil || calls != 0 || !strings.Contains(output.String(), "foreman worker") {
		t.Fatalf("help error=%v handler calls=%d output=%q", err, calls, output.String())
	}
	if _, err := os.Stat(state); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("help touched state: %v", err)
	}
}

func TestWorkerCommandPassesValidatedInvocationAndFailure(t *testing.T) {
	state := t.TempDir()
	failure := errors.New("transport is not connected")
	var received worker.Invocation
	registry := command.Registry{}
	worker.RegisterCommand(registry, worker.CommandOptions{Handlers: map[worker.Action]worker.Handler{
		worker.Run: func(_ context.Context, invocation worker.Invocation) error {
			received = invocation
			return failure
		},
	}})
	err := command.Run(context.Background(), []string{"worker", "run", "--state", state}, registry)
	if !errors.Is(err, failure) || received != (worker.Invocation{Action: worker.Run, StateDirectory: state}) {
		t.Fatalf("invocation=%+v error=%v", received, err)
	}
}

func TestWorkerCommandUnavailableAndCancelledHaveNoEffects(t *testing.T) {
	state := filepath.Join(t.TempDir(), "not-created")
	err := worker.Execute(context.Background(), []string{"run", "--state", state}, worker.CommandOptions{})
	requireWorkerError(t, err, "worker_command_unavailable")
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("caller is finished")
	cancel(cause)
	err = worker.Execute(ctx, []string{"run", "--state", state}, worker.CommandOptions{Handlers: map[worker.Action]worker.Handler{
		worker.Run: func(context.Context, worker.Invocation) error { t.Fatal("cancelled command started"); return nil },
	}})
	if !errors.Is(err, cause) {
		t.Fatalf("cancellation error=%v", err)
	}
	if _, err := os.Stat(state); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unavailable command touched state: %v", err)
	}
}

func TestWorkerCommandHelpReportsOutputFailure(t *testing.T) {
	err := worker.Execute(context.Background(), nil, worker.CommandOptions{Output: rejectedWriter{}})
	if !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("output failure=%v", err)
	}
}

type rejectedWriter struct{}

func (rejectedWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
