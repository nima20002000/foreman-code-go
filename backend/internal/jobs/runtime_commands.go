// Package jobs implements Job execution adapters. Domain records remain owned
// by the generated shared contracts; these types are internal runtime ports.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/encoding/unicode"
)

const (
	RuntimeAttachmentPurpose = "attachment"
	RuntimeControlPurpose = "control"
	RuntimeWaitPurpose = "wait"
	RuntimeControlReplyBytes = 65536
	DefaultRuntimeControlTimeout = 30 * time.Second
)

var (
	ErrRuntimeControlDeadline = errors.New("Job runtime control deadline exceeded")
	ErrRuntimeControlReplyBudget = errors.New("Job control reply exceeded budget")
	ErrRuntimeExitUnconfirmed = errors.New("Original Job runtime exit unconfirmed")
	ErrInvalidRuntimeArgv = errors.New("Invalid Job runtime argv")
	ErrRuntimeLaunchUnavailable = errors.New("Original guarded Job launch unavailable")
)

// RuntimeProcess is the process view returned by a guarded launch. Wait reports
// the actual native provider exit, never a guardian/wrapper exit. A missing exit
// receipt is a nil exit code. Canceling Wait stops only that observation.
//
// The streams belong to the caller. Closing a stream is not process-closure
// evidence. The native registry retains the launch until CloseLaunch confirms
// closure of the exact registered launch and all its descendants.
// Each Read supplies an observed native chunk; stdout UTF-8 decoding is per
// chunk, as in the TS data-event handler. Adapters must not coalesce chunks when
// malformed-byte replacement parity is required.
type RuntimeProcess interface {
	LaunchID() string
	Stdout() io.ReadCloser
	Stderr() io.ReadCloser
	Wait(context.Context) (*int, error)
}

// GuardedRuntimePort is the native launch/close boundary used by the frozen
// TypeScript jobCommandRunner in jobs/executorInstalled.ts. Its implementation
// owns the already-authorized binary, cwd, environment and durable registration.
// Launch must preserve argv without shell interpretation and must clean up or
// retain recoverable ownership when it returns a launch error.
//
// CloseLaunch must use the original native registry identity. A returned nil
// error means physical closure was confirmed. A PID, process group, wrapper exit
// or missing receipt must not substitute for that proof. No unguarded fallback
// is supplied here. CloseLaunch owns its existing bounded recovery policy.
type GuardedRuntimePort interface {
	Launch(context.Context, []string, string) (RuntimeProcess, error)
	CloseLaunch(context.Context, string) error
}

// RuntimeCommandResult is an internal command-port result, not a Job DTO.
// A nonzero native exit is a command result; transport and closure failures are
// returned separately as errors.
type RuntimeCommandResult struct {
	ExitCode int
	Stdout string
}

// RuntimeCommandRunner serializes control commands through physical closure.
// A long-running wait has its own native owner and does not block controls.
type RuntimeCommandRunner struct {
	port GuardedRuntimePort
	control chan struct{}
}

func NewRuntimeCommandRunner(port GuardedRuntimePort) *RuntimeCommandRunner {
	return &RuntimeCommandRunner{port: port, control: make(chan struct{}, 1)}
}

func (r *RuntimeCommandRunner) Run(ctx context.Context, argv []string) (RuntimeCommandResult, error) {
	return r.RunWithin(ctx, argv, DefaultRuntimeControlTimeout)
}

// RunWithin starts the command deadline after admission to the control lane and
// successful launch, matching the TS helper. A zero duration expires immediately.
func (r *RuntimeCommandRunner) RunWithin(ctx context.Context, argv []string, timeout time.Duration) (RuntimeCommandResult, error) {
	if err := validateRuntimeLaunch(ctx, r.port, argv); err != nil {
		return RuntimeCommandResult{}, err
	}
	purpose := RuntimeControlPurpose
	if len(argv) > 0 && argv[0] == "wait" {
		purpose = RuntimeWaitPurpose
	}
	if purpose == RuntimeControlPurpose {
		select {
		case r.control <- struct{}{}:
			defer func() { <-r.control }()
		case <-ctx.Done():
			return RuntimeCommandResult{}, ctx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return RuntimeCommandResult{}, err
	}
	process, err := r.port.Launch(ctx, append([]string(nil), argv...), purpose)
	if err != nil {
		return RuntimeCommandResult{}, err
	}
	if process == nil || process.LaunchID() == "" {
		return RuntimeCommandResult{}, ErrRuntimeLaunchUnavailable
	}
	return r.collectCommand(ctx, process, timeout)
}

func validateRuntimeLaunch(ctx context.Context, port GuardedRuntimePort, argv []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if port == nil {
		return ErrRuntimeLaunchUnavailable
	}
	for _, argument := range argv {
		if strings.IndexByte(argument, 0) >= 0 {
			return ErrInvalidRuntimeArgv
		}
	}
	return nil
}

type runtimeExit struct {
	code *int
	err error
}

type runtimeReply struct {
	mu sync.Mutex
	bytes int
	stdout strings.Builder
}

func (reply *runtimeReply) append(data []byte, stdout bool) error {
	reply.mu.Lock()
	defer reply.mu.Unlock()
	// Check before adding, so an oversized stream cannot overflow the counter
	// or allocate an unbounded stdout buffer.
	if len(data) > RuntimeControlReplyBytes-reply.bytes {
		return ErrRuntimeControlReplyBudget
	}
	reply.bytes += len(data)
	if stdout {
		// Buffer.toString('utf8') replaces each maximal malformed subsequence
		// within the observed chunk. strings.ToValidUTF8 incorrectly merges
		// consecutive malformed subsequences into one replacement character.
		text, err := unicode.UTF8.NewDecoder().Bytes(data)
		if err != nil {
			return err
		}
		_, _ = reply.stdout.Write(text)
	}
	return nil
}

func (reply *runtimeReply) text() string {
	reply.mu.Lock()
	defer reply.mu.Unlock()
	return reply.stdout.String()
}

func drainRuntimeReply(reader io.Reader, reply *runtimeReply, stdout bool) error {
	// A successful reply cannot contain a larger chunk than its total budget.
	// Avoid introducing smaller artificial UTF-8 boundaries in that reply.
	buffer := make([]byte, RuntimeControlReplyBytes)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			if appendError := reply.append(buffer[:n], stdout); appendError != nil {
				return appendError
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func observeRuntimeExit(ctx context.Context, process RuntimeProcess) <-chan runtimeExit {
	done := make(chan runtimeExit, 1)
	go func() {
		code, err := process.Wait(ctx)
		done <- runtimeExit{code: code, err: err}
	}()
	return done
}

func (r *RuntimeCommandRunner) collectCommand(ctx context.Context, process RuntimeProcess, timeout time.Duration) (RuntimeCommandResult, error) {
	observation, cancelObservation := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelObservation()
	stdout, stderr := process.Stdout(), process.Stderr()
	if stdout != nil {
		defer stdout.Close()
	}
	if stderr != nil {
		defer stderr.Close()
	}
	if stdout == nil || stderr == nil {
		return RuntimeCommandResult{}, errors.Join(ErrRuntimeLaunchUnavailable,
			r.port.CloseLaunch(context.WithoutCancel(ctx), process.LaunchID()))
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	exited := observeRuntimeExit(observation, process)
	reply := &runtimeReply{}
	streams := make(chan error, 2)
	go func() { streams <- drainRuntimeReply(stdout, reply, true) }()
	go func() { streams <- drainRuntimeReply(stderr, reply, false) }()
	code, err := awaitRuntimeCommand(ctx, deadline.C, exited, streams)
	// Cancellation ends execution, not cleanup. Retain values but remove the
	// canceled request deadline while the original registry proves closure.
	closeError := r.port.CloseLaunch(context.WithoutCancel(ctx), process.LaunchID())
	if closeError != nil {
		closeError = fmt.Errorf("close Job runtime launch: %w", closeError)
	}
	if err != nil || closeError != nil {
		return RuntimeCommandResult{}, errors.Join(err, closeError)
	}
	return RuntimeCommandResult{ExitCode: *code, Stdout: reply.text()}, nil
}

func awaitRuntimeCommand(ctx context.Context, deadline <-chan time.Time, exited <-chan runtimeExit, streams <-chan error) (*int, error) {
	var code *int
	remaining := 2
	for remaining > 0 || exited != nil {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline:
			return nil, ErrRuntimeControlDeadline
		case result := <-exited:
			if result.err != nil {
				return nil, result.err
			}
			code = result.code
			exited = nil
		case err := <-streams:
			remaining--
			if err != nil {
				return nil, err
			}
		}
	}
	if code == nil {
		return nil, ErrRuntimeExitUnconfirmed
	}
	return code, nil
}
