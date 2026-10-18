package logging

import (
	"io"
	"sync"
	"time"
)

const stdoutBatchBytes = 4096
const stdoutFlushInterval = 50 * time.Millisecond

// bufferedWriter owns one ordered asynchronous stdout queue. It never closes the
// caller's destination. Flush and Close report failure for all accepted records.
type bufferedWriter struct {
	destination io.Writer
	mu          sync.Mutex
	pending     []byte
	accepted    uint64
	completed   uint64
	progress    chan struct{}
	wake        chan struct{}
	done        chan struct{}
	closed      bool
	err         error
}

func newBufferedWriter(destination io.Writer) *bufferedWriter {
	writer := &bufferedWriter{
		destination: destination, progress: make(chan struct{}),
		wake: make(chan struct{}, 1), done: make(chan struct{}),
	}
	go writer.run()
	return writer
}

func (w *bufferedWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return 0, io.ErrClosedPipe
	}
	if w.err != nil {
		err := w.err
		w.mu.Unlock()
		return 0, err
	}
	w.pending = append(w.pending, data...)
	w.accepted += uint64(len(data))
	ready := len(w.pending) >= stdoutBatchBytes
	w.mu.Unlock()
	if ready {
		w.signal()
	}
	return len(data), nil
}

func (w *bufferedWriter) signal() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *bufferedWriter) run() {
	timer := time.NewTicker(stdoutFlushInterval)
	defer timer.Stop()
	defer close(w.done)
	for {
		select {
		case <-timer.C:
		case <-w.wake:
		}
		w.mu.Lock()
		data, target := w.pending, w.accepted
		w.pending = nil
		if len(data) == 0 {
			closed := w.closed
			w.mu.Unlock()
			if closed {
				return
			}
			continue
		}
		w.mu.Unlock()
		written, err := w.destination.Write(data)
		if written != len(data) && err == nil {
			err = io.ErrShortWrite
		}
		w.mu.Lock()
		w.completed = target
		w.err = err
		close(w.progress)
		w.progress = make(chan struct{})
		closed := w.closed
		pending := len(w.pending)
		if err != nil {
			// The failure is retained and returned to every drain caller. Further
			// writes are rejected rather than being accepted by a failed destination.
			w.pending = nil
		}
		w.mu.Unlock()
		if err != nil || closed && pending == 0 {
			return
		}
		if closed || pending >= stdoutBatchBytes {
			w.signal()
		}
	}
}

func (w *bufferedWriter) Flush() error {
	w.mu.Lock()
	target := w.accepted
	for {
		if w.err != nil {
			err := w.err
			w.mu.Unlock()
			return err
		}
		if w.completed >= target {
			w.mu.Unlock()
			return nil
		}
		progress := w.progress
		w.mu.Unlock()
		w.signal()
		<-progress
		w.mu.Lock()
	}
}

func (w *bufferedWriter) Close() error {
	w.mu.Lock()
	w.closed = true
	w.mu.Unlock()
	w.signal()
	<-w.done
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}
