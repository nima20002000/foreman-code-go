package jobs_test

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/jobs"
)

type runtimeLaunchRequest struct {
	argv    []string
	purpose string
	reply   chan runtimeLaunchResponse
}

type runtimeLaunchResponse struct {
	process jobs.RuntimeProcess
	err     error
}

type runtimeCloseRequest struct {
	id           string
	contextError error
	reply        chan error
}

type fakeGuardedRuntime struct {
	launches chan runtimeLaunchRequest
	closes   chan runtimeCloseRequest
	closed   chan struct{}
}

func newGuardedRuntime(t *testing.T) *fakeGuardedRuntime {
	t.Helper()
	port := &fakeGuardedRuntime{
		launches: make(chan runtimeLaunchRequest, 8),
		closes:   make(chan runtimeCloseRequest, 8),
		closed:   make(chan struct{}),
	}
	t.Cleanup(func() { close(port.closed) })
	return port
}

func (port *fakeGuardedRuntime) Launch(ctx context.Context, argv []string, purpose string) (jobs.RuntimeProcess, error) {
	request := runtimeLaunchRequest{argv: argv, purpose: purpose, reply: make(chan runtimeLaunchResponse, 1)}
	select {
	case port.launches <- request:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-port.closed:
		return nil, io.ErrClosedPipe
	}
	select {
	case result := <-request.reply:
		return result.process, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-port.closed:
		return nil, io.ErrClosedPipe
	}
}

func (port *fakeGuardedRuntime) CloseLaunch(ctx context.Context, id string) error {
	request := runtimeCloseRequest{id: id, contextError: ctx.Err(), reply: make(chan error, 1)}
	select {
	case port.closes <- request:
	case <-port.closed:
		return io.ErrClosedPipe
	}
	select {
	case err := <-request.reply:
		return err
	case <-port.closed:
		return io.ErrClosedPipe
	}
}

type fakeNativeExit struct {
	code *int
	err  error
}

type fakeRuntimeProcess struct {
	id        string
	stdout    io.ReadCloser
	stderr    io.ReadCloser
	exit      chan fakeNativeExit
	observing chan struct{}
}

func runtimeProcess(id, stdout, stderr string) *fakeRuntimeProcess {
	return &fakeRuntimeProcess{id: id,
		stdout:    io.NopCloser(strings.NewReader(stdout)),
		stderr:    io.NopCloser(strings.NewReader(stderr)),
		exit:      make(chan fakeNativeExit, 1),
		observing: make(chan struct{}),
	}
}

func (process *fakeRuntimeProcess) LaunchID() string      { return process.id }
func (process *fakeRuntimeProcess) Stdout() io.ReadCloser { return process.stdout }
func (process *fakeRuntimeProcess) Stderr() io.ReadCloser { return process.stderr }
func (process *fakeRuntimeProcess) Wait(ctx context.Context) (*int, error) {
	close(process.observing)
	select {
	case result := <-process.exit:
		return result.code, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type commandResult struct {
	value jobs.RuntimeCommandResult
	err   error
}

func startRuntimeCommand(run func() (jobs.RuntimeCommandResult, error)) <-chan commandResult {
	result := make(chan commandResult, 1)
	go func() {
		value, err := run()
		result <- commandResult{value: value, err: err}
	}()
	return result
}

func receiveRuntimeValue[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("runtime operation did not reach the expected public boundary")
		var zero T
		return zero
	}
}

func confirmRuntimeClosure(t *testing.T, port *fakeGuardedRuntime, id string, err error) {
	t.Helper()
	closeRequest := receiveRuntimeValue(t, port.closes)
	if closeRequest.id != id || closeRequest.contextError != nil {
		t.Fatalf("closure = (%q, %v), want original launch %q with cleanup context", closeRequest.id, closeRequest.contextError, id)
	}
	closeRequest.reply <- err
}

func TestRuntimeCommandReturnsNativeOutputAfterClosure(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	argv := []string{"inspect", "--format={{.State}}", "literal; $(unchanged)"}
	result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), argv)
	})
	launch := receiveRuntimeValue(t, port.launches)
	if launch.purpose != jobs.RuntimeControlPurpose || !reflect.DeepEqual(launch.argv, argv) {
		t.Fatalf("launch = (%q, %q), want exact control arguments", launch.purpose, launch.argv)
	}
	process := runtimeProcess("native-one", "native stdout\n", "not returned\n")
	code := 7
	process.exit <- fakeNativeExit{code: &code}
	launch.reply <- runtimeLaunchResponse{process: process}
	closing := receiveRuntimeValue(t, port.closes)
	select {
	case value := <-result:
		t.Fatalf("returned before original launch closure: %+v", value)
	default:
	}
	if closing.id != process.id {
		t.Fatalf("closed %q, want %q", closing.id, process.id)
	}
	closing.reply <- nil
	value := receiveRuntimeValue(t, result)
	if value.err != nil || value.value.ExitCode != 7 || value.value.Stdout != "native stdout\n" {
		t.Fatalf("native result = %+v", value)
	}
}

func TestRuntimeCommandReplyBudgetIncludesBothStreams(t *testing.T) {
	for _, test := range []struct {
		name     string
		stdout   string
		stderr   string
		overflow bool
	}{
		{"exact limit", strings.Repeat("o", 32768), strings.Repeat("e", 32768), false},
		{"combined overflow", strings.Repeat("o", 40000), strings.Repeat("e", 25537), true},
		{"stderr only overflow", "", strings.Repeat("e", jobs.RuntimeControlReplyBytes+1), true},
		{"multibyte bytes", strings.Repeat("é", 32768), "e", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			port := newGuardedRuntime(t)
			runner := jobs.NewRuntimeCommandRunner(port)
			result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
				return runner.Run(context.Background(), []string{"inspect"})
			})
			launch := receiveRuntimeValue(t, port.launches)
			process := runtimeProcess("budget", test.stdout, test.stderr)
			if !test.overflow {
				code := 0
				process.exit <- fakeNativeExit{code: &code}
			}
			launch.reply <- runtimeLaunchResponse{process: process}
			confirmRuntimeClosure(t, port, process.id, nil)
			value := receiveRuntimeValue(t, result)
			if test.overflow {
				if !errors.Is(value.err, jobs.ErrRuntimeControlReplyBudget) {
					t.Fatalf("overflow result = %+v", value)
				}
			} else if value.err != nil || value.value.Stdout != test.stdout {
				t.Fatalf("exact budget result = %+v", value)
			}
		})
	}
}

func TestRuntimeWaitDoesNotBlockControlCommands(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	waitResult := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"wait", "container-id"})
	})
	waitLaunch := receiveRuntimeValue(t, port.launches)
	waitProcess := runtimeProcess("wait-owner", "", "")
	waitLaunch.reply <- runtimeLaunchResponse{process: waitProcess}
	controlResult := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"stop", "container-id"})
	})
	controlLaunch := receiveRuntimeValue(t, port.launches)
	if waitLaunch.purpose != jobs.RuntimeWaitPurpose || controlLaunch.purpose != jobs.RuntimeControlPurpose {
		t.Fatalf("owner purposes = %q, %q", waitLaunch.purpose, controlLaunch.purpose)
	}
	controlProcess := runtimeProcess("control-owner", "stopped", "")
	code := 0
	controlProcess.exit <- fakeNativeExit{code: &code}
	controlLaunch.reply <- runtimeLaunchResponse{process: controlProcess}
	confirmRuntimeClosure(t, port, controlProcess.id, nil)
	if value := receiveRuntimeValue(t, controlResult); value.err != nil {
		t.Fatal(value.err)
	}
	waitProcess.exit <- fakeNativeExit{code: &code}
	confirmRuntimeClosure(t, port, waitProcess.id, nil)
	if value := receiveRuntimeValue(t, waitResult); value.err != nil {
		t.Fatal(value.err)
	}
}

func TestRuntimeControlCommandsRemainSerialUntilClosure(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	firstResult := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"start"})
	})
	firstLaunch := receiveRuntimeValue(t, port.launches)
	first := runtimeProcess("first-control", "", "")
	code := 0
	first.exit <- fakeNativeExit{code: &code}
	firstLaunch.reply <- runtimeLaunchResponse{process: first}
	firstClosure := receiveRuntimeValue(t, port.closes)
	secondResult := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect"})
	})
	select {
	case unexpected := <-port.launches:
		t.Fatalf("control launched before preceding closure: %q", unexpected.argv)
	case <-time.After(50 * time.Millisecond):
	}
	firstClosure.reply <- nil
	if value := receiveRuntimeValue(t, firstResult); value.err != nil {
		t.Fatal(value.err)
	}
	secondLaunch := receiveRuntimeValue(t, port.launches)
	second := runtimeProcess("second-control", "", "")
	second.exit <- fakeNativeExit{code: &code}
	secondLaunch.reply <- runtimeLaunchResponse{process: second}
	confirmRuntimeClosure(t, port, second.id, nil)
	if value := receiveRuntimeValue(t, secondResult); value.err != nil {
		t.Fatal(value.err)
	}
}

func TestRuntimeControlQueueCancellationDoesNotLaunch(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	firstResult := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect"})
	})
	firstLaunch := receiveRuntimeValue(t, port.launches)
	first := runtimeProcess("active-control", "", "")
	firstLaunch.reply <- runtimeLaunchResponse{process: first}
	queuedContext, cancelQueued := context.WithCancel(context.Background())
	defer cancelQueued()
	queuedResult := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(queuedContext, []string{"stop"})
	})
	cancelQueued()
	if value := receiveRuntimeValue(t, queuedResult); !errors.Is(value.err, context.Canceled) {
		t.Fatalf("canceled queue result = %+v", value)
	}
	code := 0
	first.exit <- fakeNativeExit{code: &code}
	confirmRuntimeClosure(t, port, first.id, nil)
	if value := receiveRuntimeValue(t, firstResult); value.err != nil {
		t.Fatal(value.err)
	}
	select {
	case unexpected := <-port.launches:
		t.Fatalf("canceled control launched: %q", unexpected.argv)
	default:
	}
}

func TestRuntimeCommandCancellationClosesOriginalLaunch(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(ctx, []string{"wait", "container"})
	})
	launch := receiveRuntimeValue(t, port.launches)
	process := runtimeProcess("cancel-original", "", "")
	launch.reply <- runtimeLaunchResponse{process: process}
	// Cancel only after the port has returned the owned process successfully.
	receiveRuntimeValue(t, process.observing)
	cancel()
	confirmRuntimeClosure(t, port, process.id, nil)
	if value := receiveRuntimeValue(t, result); !errors.Is(value.err, context.Canceled) {
		t.Fatalf("cancel result = %+v", value)
	}
}

func TestRuntimeCommandDeadlineAndClosureFailureRemainVisible(t *testing.T) {
	for _, closeFailure := range []error{nil, errors.New("original guarded closure unconfirmed")} {
		t.Run(fmtRuntimeFailure(closeFailure), func(t *testing.T) {
			port := newGuardedRuntime(t)
			runner := jobs.NewRuntimeCommandRunner(port)
			result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
				return runner.RunWithin(context.Background(), []string{"inspect"}, 0)
			})
			launch := receiveRuntimeValue(t, port.launches)
			process := runtimeProcess("deadline-original", "", "")
			launch.reply <- runtimeLaunchResponse{process: process}
			confirmRuntimeClosure(t, port, process.id, closeFailure)
			value := receiveRuntimeValue(t, result)
			if !errors.Is(value.err, jobs.ErrRuntimeControlDeadline) || closeFailure != nil && !errors.Is(value.err, closeFailure) {
				t.Fatalf("deadline/closure result = %+v", value)
			}
		})
	}
}

func fmtRuntimeFailure(err error) string {
	if err == nil {
		return "closure confirmed"
	}
	return "closure unconfirmed"
}

func TestRuntimeCommandMissingNativeExitNeverSucceeds(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect"})
	})
	launch := receiveRuntimeValue(t, port.launches)
	process := runtimeProcess("missing-native-receipt", "wrapper output", "")
	process.exit <- fakeNativeExit{}
	launch.reply <- runtimeLaunchResponse{process: process}
	confirmRuntimeClosure(t, port, process.id, nil)
	if value := receiveRuntimeValue(t, result); !errors.Is(value.err, jobs.ErrRuntimeExitUnconfirmed) {
		t.Fatalf("missing native exit result = %+v", value)
	}
}

func TestRuntimeCommandClosureFailureDoesNotBecomeSuccess(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect"})
	})
	launch := receiveRuntimeValue(t, port.launches)
	process := runtimeProcess("closure-failure", "output", "")
	code := 0
	process.exit <- fakeNativeExit{code: &code}
	launch.reply <- runtimeLaunchResponse{process: process}
	closeFailure := errors.New("retained owner still has descendants")
	confirmRuntimeClosure(t, port, process.id, closeFailure)
	if value := receiveRuntimeValue(t, result); !errors.Is(value.err, closeFailure) || value.value.Stdout != "" {
		t.Fatalf("unconfirmed closure result = %+v", value)
	}
}

func TestRuntimeCommandLaunchFailureDoesNotInventClosure(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect"})
	})
	launch := receiveRuntimeValue(t, port.launches)
	failure := errors.New("guarded launch unavailable")
	launch.reply <- runtimeLaunchResponse{err: failure}
	if value := receiveRuntimeValue(t, result); !errors.Is(value.err, failure) {
		t.Fatalf("launch failure = %+v", value)
	}
	select {
	case closeRequest := <-port.closes:
		t.Fatalf("invented closure of %q", closeRequest.id)
	default:
	}
}

func TestRuntimeCommandRejectsCanceledAndInvalidArgumentsBeforeLaunch(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runner.Run(canceled, []string{"inspect"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request error = %v", err)
	}
	if _, err := runner.Run(context.Background(), []string{"inspect", "bad\x00argument"}); !errors.Is(err, jobs.ErrInvalidRuntimeArgv) {
		t.Fatalf("invalid argv error = %v", err)
	}
	if _, err := jobs.NewRuntimeCommandRunner(nil).Run(context.Background(), []string{"inspect"}); !errors.Is(err, jobs.ErrRuntimeLaunchUnavailable) {
		t.Fatalf("missing runtime error = %v", err)
	}
	select {
	case launch := <-port.launches:
		t.Fatalf("invalid/canceled request launched: %q", launch.argv)
	default:
	}
}

type failingRuntimeReader struct{ failure error }

func (reader failingRuntimeReader) Read([]byte) (int, error) { return 0, reader.failure }

func TestRuntimeCommandReadFailureWaitsForClosure(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect"})
	})
	launch := receiveRuntimeValue(t, port.launches)
	process := runtimeProcess("broken-stream", "", "")
	failure := errors.New("native output transport lost")
	process.stderr = io.NopCloser(failingRuntimeReader{failure: failure})
	launch.reply <- runtimeLaunchResponse{process: process}
	confirmRuntimeClosure(t, port, process.id, nil)
	if value := receiveRuntimeValue(t, result); !errors.Is(value.err, failure) {
		t.Fatalf("read failure = %+v", value)
	}
}

func TestRuntimeCommandDrainsStreamsAfterNativeExit(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect"})
	})
	launch := receiveRuntimeValue(t, port.launches)
	process := runtimeProcess("draining-stream", "", "")
	reader, writer := io.Pipe()
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})
	process.stdout = reader
	code := 0
	process.exit <- fakeNativeExit{code: &code}
	launch.reply <- runtimeLaunchResponse{process: process}
	writeResult := make(chan error, 1)
	go func() {
		_, err := io.WriteString(writer, "last native output")
		writeResult <- errors.Join(err, writer.Close())
	}()
	if err := receiveRuntimeValue(t, writeResult); err != nil {
		t.Fatal(err)
	}
	confirmRuntimeClosure(t, port, process.id, nil)
	value := receiveRuntimeValue(t, result)
	if value.err != nil || value.value.Stdout != "last native output" {
		t.Fatalf("drained result = %+v", value)
	}
}
