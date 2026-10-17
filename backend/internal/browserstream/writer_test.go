package browserstream_test

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/browserstream"
)

// blockedResponse models an accepted frame whose downstream write has not drained.
// It implements only the public net/http writer/deadline/flush interfaces.
type blockedResponse struct {
	header http.Header
	writes chan string
	flushed chan struct{}
	release chan struct{}
	mu sync.Mutex
	deadline time.Time
	changed chan struct{}
	flushError error
	clearCalls int
	clearError error
}

func newBlockedResponse() *blockedResponse {
	return &blockedResponse{header: make(http.Header), writes: make(chan string, 16),
		flushed: make(chan struct{}, 16), release: make(chan struct{}, 16), changed: make(chan struct{})}
}

func (r *blockedResponse) Header() http.Header { return r.header }
func (r *blockedResponse) WriteHeader(int) {}

func (r *blockedResponse) Write(data []byte) (int, error) {
	r.writes <- string(data)
	for {
		r.mu.Lock()
		deadline, changed := r.deadline, r.changed
		r.mu.Unlock()
		if deadline.IsZero() {
			select {
			case <-r.release:
				return len(data), nil
			case <-changed:
				continue
			}
		}
		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-r.release:
			timer.Stop()
			return len(data), nil
		case <-changed:
			timer.Stop()
		case <-timer.C:
			return 0, os.ErrDeadlineExceeded
		}
	}
}

func (r *blockedResponse) SetWriteDeadline(deadline time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if deadline.IsZero() {
		r.clearCalls++
		if r.clearCalls > 1 && r.clearError != nil {
			return r.clearError
		}
	}
	r.deadline = deadline
	close(r.changed)
	r.changed = make(chan struct{})
	return nil
}

func (r *blockedResponse) FlushError() error {
	r.flushed <- struct{}{}
	return r.flushError
}

func receive[T any](t *testing.T, values <-chan T) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("stream operation did not finish")
		var zero T
		return zero
	}
}

func newWriter(t *testing.T, options browserstream.Options) *browserstream.Writer {
	t.Helper()
	writer, err := browserstream.New(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	return writer
}

func runWriter(writer *browserstream.Writer, ctx context.Context, response http.ResponseWriter) <-chan error {
	result := make(chan error, 1)
	go func() { result <- writer.Run(ctx, response) }()
	return result
}

func TestWriterServesRegisteredStream(t *testing.T) {
	application, err := app.New(app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	frame := "id: 3\nevent: snapshot\ndata: {\"revision\":3}\n\n"
	application.RegisterStream("GET /events", func(response http.ResponseWriter, request *http.Request) error {
		writer, createErr := browserstream.New(browserstream.Options{})
		if createErr != nil {
			return createErr
		}
		defer writer.Close()
		if writeErr := writer.Write(frame); writeErr != nil {
			return writeErr
		}
		runErr := writer.Run(request.Context(), response)
		completed <- runErr
		if errors.Is(runErr, context.Canceled) {
			return nil
		}
		return runErr
	})
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	client := server.Client()
	client.Timeout = 2 * time.Second
	response, err := client.Get(server.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" ||
		response.Header.Get("Cache-Control") != "no-cache, no-transform" || response.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("stream response = %d %v", response.StatusCode, response.Header)
	}
	actual := make([]byte, len(frame))
	if _, err := io.ReadFull(bufio.NewReader(response.Body), actual); err != nil {
		t.Fatal(err)
	}
	if string(actual) != frame {
		t.Fatalf("frame = %q, want %q", actual, frame)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if err := receive(t, completed); !errors.Is(err, context.Canceled) {
		t.Fatalf("disconnect error = %v", err)
	}
}

func TestWriterDrainsEachAcceptedFrameOnce(t *testing.T) {
	writer := newWriter(t, browserstream.Options{})
	response := newBlockedResponse()
	result := runWriter(writer, context.Background(), response)
	frames := []string{"event: first\ndata: 1\n\n", ": heartbeat\n\n", "event: last\ndata: null\n\n"}
	if err := writer.Write(frames[0]); err != nil {
		t.Fatal(err)
	}
	if first := receive(t, response.writes); first != frames[0] {
		t.Fatalf("first accepted frame = %q", first)
	}
	for _, frame := range frames[1:] {
		if err := writer.Write(frame); err != nil {
			t.Fatal(err)
		}
	}
	for _, expected := range frames[1:] {
		response.release <- struct{}{}
		receive(t, response.flushed)
		if next := receive(t, response.writes); next != expected {
			t.Fatalf("next accepted frame = %q, want %q", next, expected)
		}
	}
	response.release <- struct{}{}
	receive(t, response.flushed)
	writer.Close()
	if err := receive(t, result); err != nil {
		t.Fatal(err)
	}
	select {
	case duplicate := <-response.writes:
		t.Fatalf("frame was replayed: %q", duplicate)
	default:
	}
}

func TestWriterStopsAtQueueBounds(t *testing.T) {
	for _, test := range []struct {
		name string
		limits browserstream.Limits
		accepted []string
		overflow string
	}{
		{"frames", browserstream.Limits{QueuedFrames: 2, QueuedBytes: 5}, []string{"aa", "bbb"}, ""},
		{"bytes", browserstream.Limits{QueuedFrames: 10, QueuedBytes: 5}, []string{"12345"}, "!"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stopped atomic.Int32
			writer := newWriter(t, browserstream.Options{Limits: test.limits, OnStopped: func(error) { stopped.Add(1) }})
			response := newBlockedResponse()
			result := runWriter(writer, context.Background(), response)
			if err := writer.Write("first accepted frame exceeds waiting byte budget"); err != nil {
				t.Fatal(err)
			}
			receive(t, response.writes)
			for _, frame := range test.accepted {
				if err := writer.Write(frame); err != nil {
					t.Fatalf("queue boundary rejected: %v", err)
				}
			}
			if err := writer.Write(test.overflow); !errors.Is(err, browserstream.ErrQueueFull) {
				t.Fatalf("overflow error = %v", err)
			}
			if err := receive(t, result); !errors.Is(err, browserstream.ErrQueueFull) {
				t.Fatalf("run error = %v", err)
			}
			writer.Close()
			if stopped.Load() != 1 {
				t.Fatalf("stop callback count = %d", stopped.Load())
			}
			select {
			case leaked := <-response.writes:
				t.Fatalf("queued frame leaked after stop: %q", leaked)
			default:
			}
		})
	}
}

func TestWriterCountsUTF8FrameBytes(t *testing.T) {
	writer := newWriter(t, browserstream.Options{Limits: browserstream.Limits{FrameBytes: 3}})
	if err := writer.Write("é!"); err != nil {
		t.Fatalf("exact three-byte frame: %v", err)
	}
	if err := writer.Write("éé"); !errors.Is(err, browserstream.ErrFrameTooLarge) {
		t.Fatalf("four-byte frame: %v", err)
	}
	<-writer.Done()
}

func TestWriterAcceptsInitialFrameAboveWaitingBudget(t *testing.T) {
	for _, test := range []struct {
		name string
		bytes int
	}{
		{"just_above_queue", 256*1024 + 1},
		{"at_frame_limit", 8 * 1024 * 1024},
	} {
		t.Run(test.name, func(t *testing.T) {
			writer := newWriter(t, browserstream.Options{})
			frame := "data: " + strings.Repeat("x", test.bytes-8) + "\n\n"
			// Domain routes prepare the snapshot before entering Run. An accepted
			// first frame uses the frame limit, not the waiting queue's byte limit.
			if err := writer.Write(frame); err != nil {
				t.Fatalf("initial %d-byte frame rejected before Run: %v", len(frame), err)
			}
			response := newBlockedResponse()
			result := runWriter(writer, context.Background(), response)
			if actual := receive(t, response.writes); actual != frame {
				t.Fatalf("initial frame bytes changed: received %d bytes, want %d", len(actual), len(frame))
			}
			response.release <- struct{}{}
			receive(t, response.flushed)
			writer.Close()
			if err := receive(t, result); err != nil {
				t.Fatalf("initial frame did not finish cleanly: %v", err)
			}
		})
	}
}

func TestWriterStopsWhenAccessExpires(t *testing.T) {
	var allowed atomic.Bool
	allowed.Store(true)
	var stopped atomic.Int32
	writer := newWriter(t, browserstream.Options{Allowed: allowed.Load, OnStopped: func(error) { stopped.Add(1) }})
	if err := writer.Write("data: first\n\n"); err != nil {
		t.Fatal(err)
	}
	allowed.Store(false)
	if err := writer.Write(": heartbeat\n\n"); !errors.Is(err, browserstream.ErrAccessExpired) {
		t.Fatalf("expired write = %v", err)
	}
	if err := writer.Write("data: later\n\n"); !errors.Is(err, browserstream.ErrAccessExpired) || stopped.Load() != 1 {
		t.Fatalf("write after stop = %v, callbacks %d", err, stopped.Load())
	}
}

func TestWriterStopsOnDrainTimeout(t *testing.T) {
	writer := newWriter(t, browserstream.Options{Limits: browserstream.Limits{DrainTimeout: 30 * time.Millisecond}})
	response := newBlockedResponse()
	result := runWriter(writer, context.Background(), response)
	if err := writer.Write("data: blocked\n\n"); err != nil {
		t.Fatal(err)
	}
	receive(t, response.writes)
	if err := receive(t, result); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("drain timeout = %v", err)
	}
}

func TestWriterCancellationReleasesBlockedWrite(t *testing.T) {
	writer := newWriter(t, browserstream.Options{})
	response := newBlockedResponse()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := runWriter(writer, ctx, response)
	if err := writer.Write("data: blocked\n\n"); err != nil {
		t.Fatal(err)
	}
	receive(t, response.writes)
	cancel()
	if err := receive(t, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation = %v", err)
	}
}

func TestWriterCloseIsSilentAndIdempotent(t *testing.T) {
	var stopped atomic.Int32
	writer := newWriter(t, browserstream.Options{OnStopped: func(error) { stopped.Add(1) }})
	response := newBlockedResponse()
	result := runWriter(writer, context.Background(), response)
	if err := writer.Write("data: blocked\n\n"); err != nil {
		t.Fatal(err)
	}
	receive(t, response.writes)
	writer.Close()
	writer.Close()
	if err := receive(t, result); err != nil || stopped.Load() != 0 {
		t.Fatalf("explicit close = %v, callbacks %d", err, stopped.Load())
	}
	if err := writer.Write("later"); !errors.Is(err, browserstream.ErrClosed) {
		t.Fatalf("write after close = %v", err)
	}
}

func TestWriterRetainsDeadlineCleanupFailureAfterStop(t *testing.T) {
	for _, reason := range []string{"close", "cancel", "overflow"} {
		t.Run(reason, func(t *testing.T) {
			cleanupError := errors.New("write deadline could not be cleared")
			writer := newWriter(t, browserstream.Options{Limits: browserstream.Limits{QueuedFrames: 1}})
			response := newBlockedResponse()
			response.clearError = cleanupError
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := runWriter(writer, ctx, response)
			if err := writer.Write("data: blocked\n\n"); err != nil {
				t.Fatal(err)
			}
			receive(t, response.writes)
			var stopError error
			switch reason {
			case "close":
				writer.Close()
			case "cancel":
				stopError = context.Canceled
				cancel()
			case "overflow":
				stopError = browserstream.ErrQueueFull
				if err := writer.Write("data: queued\n\n"); err != nil {
					t.Fatal(err)
				}
				if err := writer.Write("data: overflow\n\n"); !errors.Is(err, stopError) {
					t.Fatalf("overflow error = %v", err)
				}
			}
			err := receive(t, result)
			if !errors.Is(err, cleanupError) || !errors.Is(writer.Err(), cleanupError) {
				t.Fatalf("cleanup failure was lost: Run = %v, Err = %v", err, writer.Err())
			}
			if stopError != nil && !errors.Is(err, stopError) {
				t.Fatalf("original stop reason was lost: %v", err)
			}
			if errors.Is(err, os.ErrDeadlineExceeded) {
				t.Fatalf("expected interrupted write became an independent failure: %v", err)
			}
		})
	}
}

func TestWriterWaitsForStoppedCallback(t *testing.T) {
	entered := make(chan struct{})
	cleanupDone := make(chan struct{})
	writer := newWriter(t, browserstream.Options{OnStopped: func(error) {
		close(entered)
		<-cleanupDone
	}})
	response := newBlockedResponse()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := runWriter(writer, ctx, response)
	if err := writer.Write("data: blocked\n\n"); err != nil {
		t.Fatal(err)
	}
	receive(t, response.writes)
	cancel()
	receive(t, entered)
	select {
	case <-writer.Done():
		t.Error("stream signaled completion before its stop callback finished")
	default:
	}
	select {
	case err := <-result:
		t.Errorf("Run returned before its stop callback finished: %v", err)
	default:
	}
	close(cleanupDone)
	if err := receive(t, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("callback completion = %v", err)
	}
}

func TestWriterReportsFlushFailure(t *testing.T) {
	want := errors.New("connection reset")
	writer := newWriter(t, browserstream.Options{})
	response := newBlockedResponse()
	response.flushError = want
	result := runWriter(writer, context.Background(), response)
	if err := writer.Write("data: first\n\n"); err != nil {
		t.Fatal(err)
	}
	receive(t, response.writes)
	response.release <- struct{}{}
	if err := receive(t, result); !errors.Is(err, want) {
		t.Fatalf("flush failure = %v", err)
	}
}

func TestWriterRequiresDeadlineSupport(t *testing.T) {
	writer := newWriter(t, browserstream.Options{})
	if err := writer.Write("data: first\n\n"); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	if err := writer.Run(context.Background(), response); !errors.Is(err, http.ErrNotSupported) {
		t.Fatalf("unsupported writer = %v", err)
	}
	if response.Body.Len() != 0 {
		t.Fatalf("unsupported writer received body %q", response.Body.String())
	}
}

func TestWriterRejectsNegativeLimits(t *testing.T) {
	for _, limits := range []browserstream.Limits{
		{FrameBytes: -1}, {QueuedBytes: -1}, {QueuedFrames: -1}, {DrainTimeout: -1},
	} {
		if _, err := browserstream.New(browserstream.Options{Limits: limits}); err == nil {
			t.Fatalf("limits %v = %v", limits, err)
		}
	}
}
