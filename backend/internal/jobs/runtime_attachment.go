package jobs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
)

// Attach supplies the streaming half of the frozen installed command runner.
// Attachment output has no control-reply budget or timer and does not hold the
// control lane. The caller must drain or close both streams concurrently.
//
// The returned Wait joins the helper's native observation, both output streams,
// and closure of its original registry identity. It reports only that helper,
// never the Job or container outcome: the supervisor separately runs wait and
// inspect and uses the original container owner to prove that the Job stopped.
// Canceling Wait stops only the observer. After launch, request cancellation
// does not replace the container owner's control or stop the attached helper.
func (r *RuntimeCommandRunner) Attach(ctx context.Context, argv []string) (RuntimeProcess, error) {
	if err := validateRuntimeLaunch(ctx, r.port, argv); err != nil {
		return nil, err
	}
	process, err := r.port.Launch(ctx, append([]string(nil), argv...), RuntimeAttachmentPurpose)
	if err != nil {
		return nil, err
	}
	if process == nil {
		return nil, ErrRuntimeLaunchUnavailable
	}
	id := process.LaunchID()
	stdout, stderr := process.Stdout(), process.Stderr()
	if id == "" || stdout == nil || stderr == nil {
		var stdoutError, stderrError, closeError error
		if stdout != nil {
			stdoutError = stdout.Close()
		}
		if stderr != nil {
			stderrError = stderr.Close()
		}
		if id != "" {
			closeError = r.port.CloseLaunch(context.WithoutCancel(ctx), id)
		}
		// A malformed success without a launch ID gives this adapter no safe
		// cleanup identity. Recovery remains the injected owner's responsibility;
		// closing available readers is not evidence that its process stopped.
		return nil, errors.Join(ErrRuntimeLaunchUnavailable, stdoutError, stderrError, closeError)
	}
	attachment := &runtimeAttachment{
		id: id, stdout: newRuntimeAttachmentStream(stdout), stderr: newRuntimeAttachmentStream(stderr),
		done: make(chan struct{}),
	}
	go attachment.observe(context.WithoutCancel(ctx), process, r.port)
	return attachment, nil
}

type runtimeAttachment struct {
	id string
	stdout *runtimeAttachmentStream
	stderr *runtimeAttachmentStream
	done chan struct{}
	exit runtimeExit
}

func (attachment *runtimeAttachment) LaunchID() string { return attachment.id }
func (attachment *runtimeAttachment) Stdout() io.ReadCloser { return attachment.stdout }
func (attachment *runtimeAttachment) Stderr() io.ReadCloser { return attachment.stderr }

func (attachment *runtimeAttachment) Wait(ctx context.Context) (*int, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-attachment.done:
		if attachment.exit.code == nil {
			return nil, attachment.exit.err
		}
		code := *attachment.exit.code
		return &code, attachment.exit.err
	}
}

func (attachment *runtimeAttachment) observe(ctx context.Context, process RuntimeProcess, port GuardedRuntimePort) {
	code, nativeError := process.Wait(ctx)
	if nativeError == nil && code != nil {
		// A provider exit can precede unread pipe data. An ordinary read error
		// ends that reader, not a live helper; only native observation reaches
		// this join. The caller still drains or closes the other stream.
		<-attachment.stdout.done
		<-attachment.stderr.done
	} else if nativeError == nil {
		nativeError = ErrRuntimeExitUnconfirmed
	}
	// Failed or absent native evidence is not closure. Release the readers and
	// ask the original registry to resolve that exact launch, preserving any
	// remaining uncertainty as an error. No PID, retry or fallback is invented.
	stdoutError := attachment.stdout.Close()
	stderrError := attachment.stderr.Close()
	closeError := port.CloseLaunch(ctx, attachment.id)
	if closeError != nil {
		closeError = fmt.Errorf("close Job runtime launch: %w", closeError)
		slog.ErrorContext(ctx, "close job helper launch", "component", "jobs", "launchId", attachment.id, "error", closeError)
	}
	if code != nil {
		value := *code
		code = &value
	}
	attachment.exit = runtimeExit{code: code, err: errors.Join(nativeError,
		attachment.stdout.err, attachment.stderr.err, stdoutError, stderrError, closeError)}
	close(attachment.done)
}

type runtimeAttachmentStream struct {
	reader io.ReadCloser
	done chan struct{}
	finishOnce sync.Once
	closeOnce sync.Once
	err error
	closeError error
}

func newRuntimeAttachmentStream(reader io.ReadCloser) *runtimeAttachmentStream {
	return &runtimeAttachmentStream{reader: reader, done: make(chan struct{})}
}

func (stream *runtimeAttachmentStream) Read(buffer []byte) (int, error) {
	n, err := stream.reader.Read(buffer)
	if err != nil {
		stream.finish(err)
	}
	return n, err
}

func (stream *runtimeAttachmentStream) Close() error {
	stream.closeOnce.Do(func() {
		stream.closeError = stream.reader.Close()
		stream.finish(nil)
	})
	return stream.closeError
}

func (stream *runtimeAttachmentStream) finish(err error) {
	stream.finishOnce.Do(func() {
		if !errors.Is(err, io.EOF) {
			stream.err = err
		}
		close(stream.done)
	})
}
