package logging_test

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/logging"
)

type slowDestination struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
	output  bytes.Buffer
}

func (w *slowDestination) Write(data []byte) (int, error) {
	w.once.Do(func() {
		close(w.started)
		<-w.release
	})
	return w.output.Write(data)
}

func TestLoggingDoesNotBlockRequestOnSlowStdout(t *testing.T) {
	destination := &slowDestination{started: make(chan struct{}), release: make(chan struct{})}
	runtime := logging.New(logging.Options{Stdout: destination})
	var release sync.Once
	defer func() {
		release.Do(func() { close(destination.release) })
		if err := runtime.Close(); err != nil {
			t.Errorf("close logger: %v", err)
		}
	}()
	runtime.Logger.Info("first", "padding", strings.Repeat("x", 4096))
	select {
	case <-destination.started:
	case <-time.After(2 * time.Second):
		t.Fatal("stdout did not begin its asynchronous write")
	}
	returned := make(chan struct{})
	go func() {
		runtime.Logger.Info("second")
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("log call blocked behind destination I/O")
	}
	release.Do(func() { close(destination.release) })
	if err := runtime.Flush(); err != nil {
		t.Fatal(err)
	}
	lines := readLines(t, destination.output.Bytes())
	if len(lines) != 2 || lines[0]["msg"] != "first" || lines[1]["msg"] != "second" {
		t.Fatalf("ordered drain lost a record: %#v", lines)
	}
}

type periodicDestination struct {
	written chan []byte
}

func (w periodicDestination) Write(data []byte) (int, error) {
	w.written <- append([]byte(nil), data...)
	return len(data), nil
}

func TestLoggingPeriodicallyFlushesSmallLines(t *testing.T) {
	destination := periodicDestination{written: make(chan []byte, 2)}
	runtime := logging.New(logging.Options{Stdout: destination})
	defer func() {
		if err := runtime.Close(); err != nil {
			t.Errorf("close logger: %v", err)
		}
	}()
	runtime.Logger.Info("small line")
	select {
	case data := <-destination.written:
		lines := readLines(t, data)
		if len(lines) != 1 || lines[0]["msg"] != "small line" {
			t.Fatalf("periodic output = %#v", lines)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a sub-batch line was never flushed without an explicit drain")
	}
}

func TestLoggingCloseWaitsForAcceptedLines(t *testing.T) {
	destination := &slowDestination{started: make(chan struct{}), release: make(chan struct{})}
	runtime := logging.New(logging.Options{Stdout: destination})
	var release sync.Once
	defer func() {
		release.Do(func() { close(destination.release) })
		if err := runtime.Close(); err != nil {
			t.Errorf("close logger: %v", err)
		}
	}()
	runtime.Logger.Info("first", "padding", strings.Repeat("x", 4096))
	select {
	case <-destination.started:
	case <-time.After(2 * time.Second):
		t.Fatal("stdout did not begin")
	}
	runtime.Logger.Info("last")
	closed := make(chan error, 1)
	go func() { closed <- runtime.Close() }()
	select {
	case err := <-closed:
		t.Fatalf("Close returned before accepted lines were written: %v", err)
	default:
	}
	release.Do(func() { close(destination.release) })
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not finish its ordered drain")
	}
	if err := runtime.Close(); err != nil {
		t.Fatalf("idempotent Close = %v", err)
	}
	lines := readLines(t, destination.output.Bytes())
	if len(lines) != 2 || lines[0]["msg"] != "first" || lines[1]["msg"] != "last" {
		t.Fatalf("close output = %#v", lines)
	}
}

type failingDestination struct {
	err   error
	short bool
}

func (w failingDestination) Write(data []byte) (int, error) {
	if w.short {
		return len(data) / 2, nil
	}
	return 0, w.err
}

func TestLoggingRetainsDestinationFailure(t *testing.T) {
	broken := errors.New("isolated stdout failure")
	for _, test := range []struct {
		name        string
		destination failingDestination
		want        error
	}{
		{"write_error", failingDestination{err: broken}, broken},
		{"short_write", failingDestination{short: true}, io.ErrShortWrite},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime := logging.New(logging.Options{Stdout: test.destination})
			runtime.Logger.Info("accepted before failure")
			if err := runtime.Flush(); !errors.Is(err, test.want) {
				t.Errorf("Flush = %v, want %v", err, test.want)
			}
			runtime.Logger.Error("after failed destination")
			if err := runtime.Flush(); !errors.Is(err, test.want) {
				t.Errorf("second Flush = %v, want retained %v", err, test.want)
			}
			if err := runtime.Close(); !errors.Is(err, test.want) {
				t.Errorf("Close = %v, want retained %v", err, test.want)
			}
		})
	}
}

func TestLoggingFatalDrainsWithoutExiting(t *testing.T) {
	runtime, output := runtimeFor(t, nil)
	runtime.Logger.Info("before fatal")
	if err := runtime.Fatal("fatal diagnostic", "operation", "isolated startup"); err != nil {
		t.Fatal(err)
	}
	lines := readLines(t, output.Bytes())
	if len(lines) != 2 || lines[0]["msg"] != "before fatal" || lines[1]["level"] != "fatal" ||
		lines[1]["msg"] != "fatal diagnostic" {
		t.Fatalf("fatal drain = %#v", lines)
	}
}

type closeAwareDestination struct {
	bytes.Buffer
	closed bool
}

func (w *closeAwareDestination) Close() error {
	w.closed = true
	return nil
}

func TestLoggingLeavesCallerStdoutOpen(t *testing.T) {
	destination := &closeAwareDestination{}
	runtime := logging.New(logging.Options{Stdout: destination})
	runtime.Logger.Info("last line")
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	if destination.closed {
		t.Fatal("logger closed the caller's stdout")
	}
	if _, err := destination.WriteString("caller output\n"); err != nil {
		t.Fatal(err)
	}
}
