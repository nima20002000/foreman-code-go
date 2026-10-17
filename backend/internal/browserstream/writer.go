// Package browserstream owns the bounded HTTP writer shared by browser event streams.
package browserstream

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

var (
	ErrClosed = errors.New("browser stream is closed")
	ErrAccessExpired = errors.New("browser stream access is no longer allowed")
	ErrFrameTooLarge = errors.New("browser stream frame exceeds the byte limit")
	ErrQueueFull = errors.New("browser stream queue exceeds the allowed size")
	ErrAlreadyRunning = errors.New("browser stream writer has already run")
)

// Limits preserves the frozen TypeScript SSE transport bounds. Zero selects each default.
type Limits struct {
	FrameBytes int
	QueuedBytes int
	QueuedFrames int
	DrainTimeout time.Duration
}

// Options leaves principal expiry and domain stream cleanup with the owning lane.
// Allowed and OnStopped may run on a publishing goroutine and must be concurrency-safe.
// OnStopped is called once for failure; Close never calls it.
type Options struct {
	Limits Limits
	Allowed func() bool
	OnStopped func(error)
}

// Writer accepts complete, already-encoded SSE frames without changing their bytes.
// Run owns response writes; publishers can call Write concurrently without blocking on a client.
type Writer struct {
	options Options
	mu sync.Mutex
	current *string
	queue []string
	queuedBytes int
	running bool
	closed bool
	err error
	wake chan struct{}
	done chan struct{}
	interrupt func() error
}

// New creates a stream queue without committing HTTP headers or starting a goroutine.
// Call Run only after the lane has completed access checks and prepared its initial frame.
func New(options Options) (*Writer, error) {
	limits := &options.Limits
	if limits.FrameBytes == 0 {
		limits.FrameBytes = 8 * 1024 * 1024
	}
	if limits.QueuedBytes == 0 {
		limits.QueuedBytes = 256 * 1024
	}
	if limits.QueuedFrames == 0 {
		limits.QueuedFrames = 128
	}
	if limits.DrainTimeout == 0 {
		limits.DrainTimeout = 15 * time.Second
	}
	if limits.FrameBytes < 0 || limits.QueuedBytes < 0 || limits.QueuedFrames < 0 || limits.DrainTimeout < 0 {
		return nil, fmt.Errorf("browser stream limits must be positive")
	}
	return &Writer{options: options, wake: make(chan struct{}, 1), done: make(chan struct{})}, nil
}

// Write accepts a frame once. The in-flight frame is not counted against the waiting queue,
// matching Node write(false): that frame has been accepted, and only later frames wait.
func (s *Writer) Write(frame string) error {
	if err := s.ready(); err != nil {
		return err
	}
	if len(frame) > s.options.Limits.FrameBytes {
		s.stop(ErrFrameTooLarge)
		return ErrFrameTooLarge
	}
	s.mu.Lock()
	if s.closed {
		err := s.closedError()
		s.mu.Unlock()
		return err
	}
	if s.current == nil {
		s.current = &frame
	} else {
		limits := s.options.Limits
		if len(s.queue) >= limits.QueuedFrames || len(frame) > limits.QueuedBytes-s.queuedBytes {
			s.mu.Unlock()
			s.stop(ErrQueueFull)
			return ErrQueueFull
		}
		s.queue = append(s.queue, frame)
		s.queuedBytes += len(frame)
	}
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return nil
}

// Run serves the queue on the calling HTTP-handler goroutine until closed or canceled.
// It applies the existing SSE headers and a bounded write deadline to every flushed frame.
// Return its error to the common HTTP error boundary; it will not rewrite committed responses.
func (s *Writer) Run(ctx context.Context, response http.ResponseWriter) error {
	controller := http.NewResponseController(response)
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return ErrAlreadyRunning
	}
	s.running = true
	if s.closed {
		s.mu.Unlock()
		return s.result()
	}
	s.mu.Unlock()
	stopCancellation := context.AfterFunc(ctx, func() { s.stop(ctx.Err()) })
	defer stopCancellation()
	if err := controller.SetWriteDeadline(time.Time{}); err != nil {
		s.stop(err)
		return s.result()
	}
	if err := s.ready(); err != nil {
		return s.result()
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache, no-transform")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	for {
		frame, ok := s.next()
		if !ok {
			return s.result()
		}
		writeErr, cleanupErr := s.writeFrame(response, controller, frame)
		if cleanupErr != nil {
			s.mu.Lock()
			s.err = errors.Join(s.err, cleanupErr)
			s.mu.Unlock()
		}
		if writeErr != nil || cleanupErr != nil {
			s.stop(writeErr)
			return s.result()
		}
		s.advance()
	}
}

func (s *Writer) writeFrame(response http.ResponseWriter, controller *http.ResponseController, frame string) (failure, cleanupFailure error) {
	if err := s.ready(); err != nil {
		return err, nil
	}
	s.mu.Lock()
	if s.closed {
		err := s.closedError()
		s.mu.Unlock()
		return err, nil
	}
	err := controller.SetWriteDeadline(time.Now().Add(s.options.Limits.DrainTimeout))
	if err == nil {
		s.interrupt = func() error { return controller.SetWriteDeadline(time.Now()) }
	}
	s.mu.Unlock()
	if err != nil {
		return err, nil
	}
	defer func() {
		s.mu.Lock()
		s.interrupt = nil
		cleanupFailure = controller.SetWriteDeadline(time.Time{})
		s.mu.Unlock()
	}()
	written, err := io.WriteString(response, frame)
	if err != nil {
		return err, nil
	}
	if written != len(frame) {
		return io.ErrShortWrite, nil
	}
	if err := controller.Flush(); err != nil {
		return err, nil
	}
	return nil, nil
}

func (s *Writer) next() (string, bool) {
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return "", false
		}
		if s.current != nil {
			frame := *s.current
			s.mu.Unlock()
			return frame, true
		}
		s.mu.Unlock()
		select {
		case <-s.wake:
		case <-s.done:
			return "", false
		}
	}
}

func (s *Writer) advance() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = nil
	if !s.closed && len(s.queue) > 0 {
		frame := s.queue[0]
		s.queue[0] = ""
		s.queue = s.queue[1:]
		s.queuedBytes -= len(frame)
		s.current = &frame
	}
}

func (s *Writer) ready() error {
	s.mu.Lock()
	closed := s.closed
	err := s.closedError()
	s.mu.Unlock()
	if closed {
		return err
	}
	if s.options.Allowed != nil && !s.options.Allowed() {
		s.stop(ErrAccessExpired)
		return ErrAccessExpired
	}
	return nil
}

// Close discards waiting frames and unblocks Run without reporting a transport failure.
// A lane should call Close before returning from its stream handler, including shutdown.
func (s *Writer) Close() { s.finish(nil, false) }

// Done closes once on Close, request cancellation, access expiry, overflow or a write failure.
func (s *Writer) Done() <-chan struct{} { return s.done }

// Err returns the retained failure, or nil after Close when response cleanup succeeded.
func (s *Writer) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

func (s *Writer) result() error {
	<-s.done
	return s.Err()
}

func (s *Writer) closedError() error {
	if s.err != nil {
		return s.err
	}
	return ErrClosed
}

func (s *Writer) stop(err error) { s.finish(err, true) }

func (s *Writer) finish(err error, notify bool) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.err = errors.Join(s.err, err)
	s.queue = nil
	s.current = nil
	s.queuedBytes = 0
	if s.interrupt != nil {
		if deadlineErr := s.interrupt(); deadlineErr != nil {
			s.err = errors.Join(s.err, deadlineErr)
		}
	}
	retained := s.err
	s.mu.Unlock()
	if notify && s.options.OnStopped != nil {
		s.options.OnStopped(retained)
	}
	close(s.done)
}
