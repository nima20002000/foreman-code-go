package jobs_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/jobs"
)

type runtimeAttachmentResult struct {
	process jobs.RuntimeProcess
	err     error
}

type runtimeAttachmentRead struct {
	data []byte
	err  error
}

func startRuntimeAttachment(runner *jobs.RuntimeCommandRunner, ctx context.Context, argv []string) <-chan runtimeAttachmentResult {
	result := make(chan runtimeAttachmentResult, 1)
	go func() {
		process, err := runner.Attach(ctx, argv)
		result <- runtimeAttachmentResult{process: process, err: err}
	}()
	return result
}

func acceptRuntimeAttachment(t *testing.T, runner *jobs.RuntimeCommandRunner, port *fakeGuardedRuntime,
	ctx context.Context, process *fakeRuntimeProcess) jobs.RuntimeProcess {
	t.Helper()
	result := startRuntimeAttachment(runner, ctx, []string{"start", "--attach", "--sig-proxy=false", "container"})
	launch := receiveRuntimeValue(t, port.launches)
	if launch.purpose != jobs.RuntimeAttachmentPurpose || !reflect.DeepEqual(launch.argv,
		[]string{"start", "--attach", "--sig-proxy=false", "container"}) {
		t.Fatalf("attachment launch changed: %+v", launch)
	}
	launch.reply <- runtimeLaunchResponse{process: process}
	value := receiveRuntimeValue(t, result)
	if value.err != nil || value.process == nil || value.process.LaunchID() != process.id {
		t.Fatalf("attachment result = %+v", value)
	}
	t.Cleanup(func() {
		_ = value.process.Stdout().Close()
		_ = value.process.Stderr().Close()
		select {
		case process.exit <- fakeNativeExit{}:
		default:
		}
	})
	receiveRuntimeValue(t, process.observing)
	return value.process
}

func readRuntimeAttachment(reader io.Reader) <-chan runtimeAttachmentRead {
	result := make(chan runtimeAttachmentRead, 1)
	go func() {
		data, err := io.ReadAll(reader)
		result <- runtimeAttachmentRead{data: data, err: err}
	}()
	return result
}

func waitRuntimeAttachment(process jobs.RuntimeProcess, ctx context.Context) <-chan fakeNativeExit {
	result := make(chan fakeNativeExit, 1)
	go func() {
		code, err := process.Wait(ctx)
		result <- fakeNativeExit{code: code, err: err}
	}()
	return result
}

func drainRuntimeAttachment(t *testing.T, attachment jobs.RuntimeProcess) {
	t.Helper()
	stdout, stderr := readRuntimeAttachment(attachment.Stdout()), readRuntimeAttachment(attachment.Stderr())
	for _, stream := range []<-chan runtimeAttachmentRead{stdout, stderr} {
		if value := receiveRuntimeValue(t, stream); value.err != nil {
			t.Fatal(value.err)
		}
	}
}

func expectRuntimeAttachmentPending(t *testing.T, attachment jobs.RuntimeProcess, port *fakeGuardedRuntime) {
	t.Helper()
	// The deliberately held native/stream condition cannot complete during this
	// observer budget. Its expiry does not stop or release the owned helper.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if code, err := attachment.Wait(ctx); code != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unfinished attachment returned completion: code=%v err=%v", code, err)
	}
	select {
	case request := <-port.closes:
		t.Fatalf("closed original launch before native and stream completion: %q", request.id)
	default:
	}
}

func TestRuntimeAttachmentStreamsBeyondControlReplyBudget(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	wantStdout := bytes.Repeat([]byte{'x', 0xff, 0, 0xc3}, jobs.RuntimeControlReplyBytes/2)
	wantStderr := bytes.Repeat([]byte("native stderr\n"), jobs.RuntimeControlReplyBytes/4)
	process := runtimeProcess("streamed-original", string(wantStdout), string(wantStderr))
	attachment := acceptRuntimeAttachment(t, runner, port, context.Background(), process)
	waited := waitRuntimeAttachment(attachment, context.Background())
	stdout, stderr := readRuntimeAttachment(attachment.Stdout()), readRuntimeAttachment(attachment.Stderr())
	code := 7
	process.exit <- fakeNativeExit{code: &code}
	for index, stream := range []<-chan runtimeAttachmentRead{stdout, stderr} {
		value := receiveRuntimeValue(t, stream)
		want := [][]byte{wantStdout, wantStderr}[index]
		if value.err != nil || !bytes.Equal(value.data, want) {
			t.Fatalf("attachment stream %d changed: bytes=%d want=%d err=%v", index, len(value.data), len(want), value.err)
		}
	}
	confirmRuntimeClosure(t, port, process.id, nil)
	if result := receiveRuntimeValue(t, waited); result.err != nil || result.code == nil || *result.code != code {
		t.Fatalf("native attachment completion = %+v", result)
	}
}

func TestRuntimeAttachmentRemainsIndependentOfControlLane(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	control := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect", "before-attachment"})
	})
	firstLaunch := receiveRuntimeValue(t, port.launches)
	first := runtimeProcess("held-control", "first", "")
	firstLaunch.reply <- runtimeLaunchResponse{process: first}
	receiveRuntimeValue(t, first.observing)
	process := runtimeProcess("independent-attachment", "output", "")
	attachment := acceptRuntimeAttachment(t, runner, port, context.Background(), process)
	code := 0
	first.exit <- fakeNativeExit{code: &code}
	confirmRuntimeClosure(t, port, first.id, nil)
	if value := receiveRuntimeValue(t, control); value.err != nil || value.value.Stdout != "first" {
		t.Fatalf("first control result = %+v", value)
	}
	control = startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
		return runner.Run(context.Background(), []string{"inspect", "during-attachment"})
	})
	secondLaunch := receiveRuntimeValue(t, port.launches)
	if secondLaunch.purpose != jobs.RuntimeControlPurpose {
		t.Fatalf("control command used purpose %q", secondLaunch.purpose)
	}
	second := runtimeProcess("later-control", "second", "")
	second.exit <- fakeNativeExit{code: &code}
	secondLaunch.reply <- runtimeLaunchResponse{process: second}
	confirmRuntimeClosure(t, port, second.id, nil)
	if value := receiveRuntimeValue(t, control); value.err != nil || value.value.Stdout != "second" {
		t.Fatalf("second control result = %+v", value)
	}
	drainRuntimeAttachment(t, attachment)
	process.exit <- fakeNativeExit{code: &code}
	confirmRuntimeClosure(t, port, process.id, nil)
	if _, err := attachment.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeAttachmentJoinsNativeExitStreamsAndOriginalClosure(t *testing.T) {
	for _, first := range []string{"native exit", "stream completion"} {
		t.Run(first, func(t *testing.T) {
			port := newGuardedRuntime(t)
			runner := jobs.NewRuntimeCommandRunner(port)
			process := runtimeProcess("joined-original", "", "")
			reader, writer := io.Pipe()
			t.Cleanup(func() { _ = writer.Close() })
			process.stdout = reader
			attachment := acceptRuntimeAttachment(t, runner, port, context.Background(), process)
			stdout, stderr := readRuntimeAttachment(attachment.Stdout()), readRuntimeAttachment(attachment.Stderr())
			code := 3
			if first == "native exit" {
				process.exit <- fakeNativeExit{code: &code}
				if _, err := writer.Write([]byte("tail after native exit")); err != nil {
					t.Fatal(err)
				}
				expectRuntimeAttachmentPending(t, attachment, port)
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
				if value := receiveRuntimeValue(t, stdout); value.err != nil {
					t.Fatal(value.err)
				}
				stdout = nil
				if value := receiveRuntimeValue(t, stderr); value.err != nil {
					t.Fatal(value.err)
				}
				stderr = nil
				expectRuntimeAttachmentPending(t, attachment, port)
				process.exit <- fakeNativeExit{code: &code}
			}
			if stdout != nil {
				value := receiveRuntimeValue(t, stdout)
				if value.err != nil || string(value.data) != "tail after native exit" {
					t.Fatalf("unread native tail changed: %+v", value)
				}
			}
			if stderr != nil {
				if value := receiveRuntimeValue(t, stderr); value.err != nil {
					t.Fatal(value.err)
				}
			}
			closing := receiveRuntimeValue(t, port.closes)
			if closing.id != process.id || closing.contextError != nil {
				t.Fatalf("joined cleanup changed original scope: %+v", closing)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			if result, err := attachment.Wait(ctx); result != nil || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("native/streams alone substituted for registry closure: code=%v err=%v", result, err)
			}
			closing.reply <- nil
			if result, err := attachment.Wait(context.Background()); err != nil || result == nil || *result != code {
				t.Fatalf("joined completion = (%v, %v)", result, err)
			}
		})
	}
}

func TestRuntimeAttachmentWaitCancellationPreservesOwnership(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	process := runtimeProcess("retained-after-observer", "stdout", "stderr")
	attachment := acceptRuntimeAttachment(t, runner, port, ctx, process)
	cancel()
	if code, err := attachment.Wait(ctx); code != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled observer = (%v, %v)", code, err)
	}
	first := waitRuntimeAttachment(attachment, context.Background())
	second := waitRuntimeAttachment(attachment, context.Background())
	drainRuntimeAttachment(t, attachment)
	expectRuntimeAttachmentPending(t, attachment, port)
	code := 9
	process.exit <- fakeNativeExit{code: &code}
	confirmRuntimeClosure(t, port, process.id, nil)
	for _, result := range []<-chan fakeNativeExit{first, second} {
		value := receiveRuntimeValue(t, result)
		if value.err != nil || value.code == nil || *value.code != code {
			t.Fatalf("shared original observation = %+v", value)
		}
		*value.code = 99
	}
	value, err := attachment.Wait(context.Background())
	if err != nil || value == nil || *value != code {
		t.Fatalf("observer mutated shared native result: (%v, %v)", value, err)
	}
}

func TestRuntimeAttachmentReaderFailureRetainsLiveOwnership(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	failure := errors.New("attachment output transport failed")
	process := runtimeProcess("live-after-reader-error", "", "remaining stderr")
	process.stdout = io.NopCloser(failingRuntimeReader{failure: failure})
	attachment := acceptRuntimeAttachment(t, runner, port, context.Background(), process)
	if _, err := io.ReadAll(attachment.Stdout()); !errors.Is(err, failure) {
		t.Fatalf("native read failure hidden: %v", err)
	}
	if data, err := io.ReadAll(attachment.Stderr()); err != nil || string(data) != "remaining stderr" {
		t.Fatalf("peer output changed: %q %v", data, err)
	}
	expectRuntimeAttachmentPending(t, attachment, port)
	code := 1
	process.exit <- fakeNativeExit{code: &code}
	confirmRuntimeClosure(t, port, process.id, nil)
	if result, err := attachment.Wait(context.Background()); result == nil || *result != code || !errors.Is(err, failure) {
		t.Fatalf("joined reader failure = (%v, %v)", result, err)
	}
}

func TestRuntimeAttachmentNativeUncertaintyUsesOriginalCleanup(t *testing.T) {
	failure := errors.New("original native observation unavailable")
	for _, fixture := range []struct {
		name        string
		nativeError error
		want        error
	}{
		{"missing receipt", nil, jobs.ErrRuntimeExitUnconfirmed},
		{"failed observation", failure, failure},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			port := newGuardedRuntime(t)
			runner := jobs.NewRuntimeCommandRunner(port)
			process := runtimeProcess("unconfirmed-original", "", "")
			stdoutReader, stdoutWriter := io.Pipe()
			stderrReader, stderrWriter := io.Pipe()
			t.Cleanup(func() { _ = stdoutWriter.Close(); _ = stderrWriter.Close() })
			process.stdout, process.stderr = stdoutReader, stderrReader
			attachment := acceptRuntimeAttachment(t, runner, port, context.Background(), process)
			stdout, stderr := readRuntimeAttachment(attachment.Stdout()), readRuntimeAttachment(attachment.Stderr())
			process.exit <- fakeNativeExit{err: fixture.nativeError}
			closing := receiveRuntimeValue(t, port.closes)
			if closing.id != process.id || closing.contextError != nil {
				t.Fatalf("unconfirmed cleanup changed original scope: %+v", closing)
			}
			for _, stream := range []<-chan runtimeAttachmentRead{stdout, stderr} {
				if value := receiveRuntimeValue(t, stream); !errors.Is(value.err, io.ErrClosedPipe) {
					t.Fatalf("uncertain native helper left reader blocked: %+v", value)
				}
			}
			closing.reply <- nil
			if code, err := attachment.Wait(context.Background()); code != nil || !errors.Is(err, fixture.want) {
				t.Fatalf("unconfirmed native evidence became an exit result: (%v, %v)", code, err)
			}
		})
	}
}

func TestRuntimeAttachmentClosureFailureRemainsVisible(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	process := runtimeProcess("unclosed-original", "", "")
	attachment := acceptRuntimeAttachment(t, runner, port, context.Background(), process)
	drainRuntimeAttachment(t, attachment)
	code := 0
	process.exit <- fakeNativeExit{code: &code}
	failure := errors.New("original attachment descendants still active")
	confirmRuntimeClosure(t, port, process.id, failure)
	if _, err := attachment.Wait(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("registry uncertainty became attachment success: %v", err)
	}
}

func TestRuntimeAttachmentRejectsMalformedLaunch(t *testing.T) {
	for _, missing := range []string{"process", "launch ID", "stdout", "stderr"} {
		t.Run(missing, func(t *testing.T) {
			port := newGuardedRuntime(t)
			runner := jobs.NewRuntimeCommandRunner(port)
			stdout := &observedRuntimeReader{Reader: strings.NewReader("stdout")}
			stderr := &observedRuntimeReader{Reader: strings.NewReader("stderr")}
			process := runtimeProcess("malformed-original", "", "")
			process.stdout, process.stderr = stdout, stderr
			var native jobs.RuntimeProcess = process
			switch missing {
			case "process":
				native = nil
			case "launch ID":
				process.id = ""
			case "stdout":
				process.stdout = nil
			case "stderr":
				process.stderr = nil
			}
			result := startRuntimeAttachment(runner, context.Background(), []string{"start", "--attach", "container"})
			launch := receiveRuntimeValue(t, port.launches)
			launch.reply <- runtimeLaunchResponse{process: native}
			if missing == "stdout" || missing == "stderr" {
				closing := receiveRuntimeValue(t, port.closes)
				if closing.id != process.id || closing.contextError != nil {
					t.Fatalf("malformed attachment borrowed cleanup identity: %+v", closing)
				}
				closing.reply <- nil
			}
			value := receiveRuntimeValue(t, result)
			if value.process != nil || !errors.Is(value.err, jobs.ErrRuntimeLaunchUnavailable) {
				t.Fatalf("malformed attachment result = %+v", value)
			}
			if missing != "process" {
				if missing != "stdout" && !stdout.closed.Load() || missing != "stderr" && !stderr.closed.Load() {
					t.Fatal("malformed attachment retained a caller-owned reader")
				}
			}
			select {
			case request := <-port.closes:
				t.Fatalf("invented or repeated original cleanup: %q", request.id)
			default:
			}
		})
	}
}

func TestRuntimeAttachmentRejectsCanceledAndInvalidArgumentsBeforeLaunch(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if process, err := runner.Attach(ctx, []string{"start"}); process != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled attachment result = (%v, %v)", process, err)
	}
	if process, err := runner.Attach(context.Background(), []string{"start", "bad\x00argument"}); process != nil || !errors.Is(err, jobs.ErrInvalidRuntimeArgv) {
		t.Fatalf("invalid attachment result = (%v, %v)", process, err)
	}
	if process, err := jobs.NewRuntimeCommandRunner(nil).Attach(context.Background(), []string{"start"}); process != nil || !errors.Is(err, jobs.ErrRuntimeLaunchUnavailable) {
		t.Fatalf("unavailable attachment result = (%v, %v)", process, err)
	}
	select {
	case launch := <-port.launches:
		t.Fatalf("unlaunchable attachment reached native port: %q", launch.argv)
	default:
	}
}

func TestRuntimeAttachmentLaunchFailurePreservesNativeError(t *testing.T) {
	port := newGuardedRuntime(t)
	runner := jobs.NewRuntimeCommandRunner(port)
	argv := []string{"start", "--attach", "original-container"}
	result := startRuntimeAttachment(runner, context.Background(), argv)
	launch := receiveRuntimeValue(t, port.launches)
	argv[2] = "changed-after-request"
	if launch.argv[2] != "original-container" || launch.purpose != jobs.RuntimeAttachmentPurpose {
		t.Fatalf("attachment launch input was borrowed: %+v", launch)
	}
	failure := errors.New("native registry rejected original attachment")
	launch.reply <- runtimeLaunchResponse{err: failure}
	if value := receiveRuntimeValue(t, result); value.process != nil || value.err != failure {
		t.Fatalf("native launch failure identity changed: %+v", value)
	}
	select {
	case request := <-port.closes:
		t.Fatalf("invented closure without an original launch: %q", request.id)
	default:
	}
}
