package jobs_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/jobs"
)

// This public compatibility guard is expected to pass on both the original
// implementation and the private failure renderer. It is not behavioral red.
func TestRuntimeCommandPreservesFailureDiagnostics(t *testing.T) {
	t.Run("control deadline", func(t *testing.T) {
		process := runtimeProcess("diagnostic-deadline", "", "")
		err := runtimeDiagnosticFromProcess(t, process, 0)
		assertRuntimeDiagnostic(t, err, jobs.ErrRuntimeControlDeadline, "Job runtime control deadline exceeded")
	})
	t.Run("reply budget", func(t *testing.T) {
		process := runtimeProcess("diagnostic-budget", strings.Repeat("x", jobs.RuntimeControlReplyBytes+1), "")
		err := runtimeDiagnosticFromProcess(t, process, jobs.DefaultRuntimeControlTimeout)
		assertRuntimeDiagnostic(t, err, jobs.ErrRuntimeControlReplyBudget, "Job control reply exceeded budget")
	})
	t.Run("unconfirmed exit", func(t *testing.T) {
		process := runtimeProcess("diagnostic-exit", "", "")
		process.exit <- fakeNativeExit{}
		err := runtimeDiagnosticFromProcess(t, process, jobs.DefaultRuntimeControlTimeout)
		assertRuntimeDiagnostic(t, err, jobs.ErrRuntimeExitUnconfirmed, "Original Job runtime exit unconfirmed")
	})
	t.Run("invalid argv", func(t *testing.T) {
		runner := jobs.NewRuntimeCommandRunner(newGuardedRuntime(t))
		_, err := runner.Run(context.Background(), []string{"inspect", "bad\x00argument"})
		assertRuntimeDiagnostic(t, err, jobs.ErrInvalidRuntimeArgv, "Invalid Job runtime argv")
	})
	t.Run("unavailable launch", func(t *testing.T) {
		_, err := jobs.NewRuntimeCommandRunner(nil).Run(context.Background(), []string{"inspect"})
		assertRuntimeDiagnostic(t, err, jobs.ErrRuntimeLaunchUnavailable, "Original guarded Job launch unavailable")
	})
}

func runtimeDiagnosticFromProcess(t *testing.T, process *fakeRuntimeProcess, timeout time.Duration) error {
	t.Helper()
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.RunWithin(context.Background(), []string{"inspect"}, timeout)
	})
	launch := receiveRuntimeValue(t, port.launches)
	launch.reply <- runtimeLaunchResponse{process: process}
	confirmRuntimeClosure(t, port, process.id, nil)
	return receiveRuntimeValue(t, result).err
}

func assertRuntimeDiagnostic(t *testing.T, err, want error, message string) {
	t.Helper()
	if err == nil || err.Error() != message || !errors.Is(err, want) {
		t.Fatalf("runtime diagnostic = %v, want original sentinel and %q", err, message)
	}
	for _, other := range []error{jobs.ErrRuntimeControlDeadline, jobs.ErrRuntimeControlReplyBudget,
		jobs.ErrRuntimeExitUnconfirmed, jobs.ErrInvalidRuntimeArgv, jobs.ErrRuntimeLaunchUnavailable} {
		if other != want && errors.Is(err, other) {
			t.Fatalf("runtime diagnostic also matches a different failure: %v", other)
		}
	}
}
