// Package queue supplies the bounded, single-reader queues used by Claude
// prompt delivery and detachable output observers.
package queue

import (
	"context"
	"errors"
	"sync"
)

var (
	ErrCapacity     = errors.New("invalid Claude queue capacity")
	ErrClosed       = errors.New("Claude queue closed")
	ErrReaderExists = errors.New("Claude queue already has a reader")
)

// Queue retains at most capacity values. Additional offers wait in FIFO order.
// Construct a Queue with New; its zero value is not ready for use.
type Queue[T any] struct {
	mu       sync.Mutex
	capacity int
	coalesce func(prior, next T) (T, bool)
	values   []T
	writers  []*writer[T]
	reader   *read[T]
	ended    bool
	failure  error
}

type writer[T any] struct {
	value   T
	ctx     context.Context
	done    chan struct{}
	settled bool
	err     error
}

type read[T any] struct {
	owner *Reader[T]
	done  chan struct{}
	value T
	ok    bool
	err   error
}

// New creates a queue with a positive retained capacity. A coalescer may replace
// the last retained value only when the buffer is full and no producer is queued.
// It runs while the queue is locked and must not call back into the queue.
func New[T any](capacity int, coalesce func(prior, next T) (T, bool)) (*Queue[T], error) {
	if capacity < 1 {
		return nil, ErrCapacity
	}
	return &Queue[T]{capacity: capacity, coalesce: coalesce}, nil
}

// Offer waits for queue capacity, a reader, cancellation, or closure. A nil
// result means the queue accepted or deliberately discarded this value; it is
// never evidence that a native harness received a prompt. ctx must be non-nil.
func (q *Queue[T]) Offer(ctx context.Context, value T) error {
	w, err := q.admit(ctx, value)
	if w == nil {
		return err
	}
	select {
	case <-w.done:
		return w.err
	case <-ctx.Done():
		q.mu.Lock()
		if !w.settled {
			for i, pending := range q.writers {
				if pending == w {
					copy(q.writers[i:], q.writers[i+1:])
					q.writers[len(q.writers)-1] = nil
					q.writers = q.writers[:len(q.writers)-1]
					break
				}
			}
			finishWriter(w, context.Cause(ctx))
		}
		// An already settled offer keeps its outcome even if cancellation wins
		// the select after a reader has accepted the value.
		err := w.err
		q.mu.Unlock()
		return err
	}
}

func (q *Queue[T]) admit(ctx context.Context, value T) (*writer[T], error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	if q.ended {
		return nil, q.closedError()
	}
	q.withdrawCanceledWriters()
	if q.reader != nil {
		pending := q.reader
		q.reader = nil
		pending.value, pending.ok = value, true
		close(pending.done)
		return nil, nil
	}
	if len(q.values) < q.capacity && len(q.writers) == 0 {
		q.values = append(q.values, value)
		return nil, nil
	}
	if len(q.values) > 0 && len(q.writers) == 0 && q.coalesce != nil {
		last := len(q.values) - 1
		if merged, ok := q.coalesce(q.values[last], value); ok {
			q.values[last] = merged
			return nil, nil
		}
	}
	w := &writer[T]{value: value, ctx: ctx, done: make(chan struct{})}
	q.writers = append(q.writers, w)
	return w, nil
}

// Discard drops buffered and waiting values, releasing their producers. It does
// not close the queue or detach a reader waiting for a future value.
func (q *Queue[T]) Discard() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.withdrawCanceledWriters()
	q.discard()
}

func (q *Queue[T]) discard() {
	q.values = nil
	for _, w := range q.writers {
		finishWriter(w, nil)
	}
	q.writers = nil
}

// Close preserves the first terminal outcome. Without discard, readers drain
// retained values before receiving failure or end-of-stream, and waiting offers
// fail. With discard, live waiting offers are released successfully and no
// buffered values remain. Completed cancellations retain their cause. Either
// form prevents subsequent offers.
func (q *Queue[T]) Close(failure error, discard bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.ended {
		return
	}
	q.withdrawCanceledWriters()
	q.ended, q.failure = true, failure
	if discard {
		q.discard()
	}
	for _, w := range q.writers {
		finishWriter(w, q.closedError())
	}
	q.writers = nil
	if q.reader != nil {
		pending := q.reader
		q.reader = nil
		pending.err = failure
		close(pending.done)
	}
}

func (q *Queue[T]) closedError() error {
	if q.failure != nil {
		return q.failure
	}
	return ErrClosed
}

func finishWriter[T any](w *writer[T], err error) {
	var zero T
	w.value = zero
	w.err, w.settled = err, true
	close(w.done)
}

// A producer may not have observed its completed cancellation yet. Reconcile
// pending cancellations before another operation settles or bypasses writers.
// Accepted writers are no longer in this list and keep their original outcome.
// The caller must hold q.mu.
func (q *Queue[T]) withdrawCanceledWriters() {
	remaining := q.writers[:0]
	for _, w := range q.writers {
		if err := context.Cause(w.ctx); err != nil {
			finishWriter(w, err)
			continue
		}
		remaining = append(remaining, w)
	}
	clear(q.writers[len(remaining):])
	q.writers = remaining
}

func (q *Queue[T]) promoteWriter() {
	for len(q.writers) > 0 {
		w := q.writers[0]
		q.writers[0] = nil
		q.writers = q.writers[1:]
		if err := context.Cause(w.ctx); err != nil {
			finishWriter(w, err)
			continue
		}
		q.values = append(q.values, w.value)
		finishWriter(w, nil)
		return
	}
}

// Reader is a detachable iterator. Detach ends this reader without closing its
// queue. A queue permits only one pending Next call across all its readers.
type Reader[T any] struct {
	queue    *Queue[T]
	detached bool
}

func (q *Queue[T]) Reader() *Reader[T] {
	return &Reader[T]{queue: q}
}

// Next returns a value, the queue's terminal failure, or ok=false at the end.
// It waits until Offer, Close, or this reader's Detach resolves the read.
func (r *Reader[T]) Next() (value T, ok bool, err error) {
	q := r.queue
	q.mu.Lock()
	if r.detached {
		q.mu.Unlock()
		return value, false, nil
	}
	if len(q.values) > 0 {
		value = q.values[0]
		var zero T
		q.values[0] = zero
		q.values = q.values[1:]
		q.promoteWriter()
		q.mu.Unlock()
		return value, true, nil
	}
	if q.ended {
		err = q.failure
		q.mu.Unlock()
		return value, false, err
	}
	if q.reader != nil {
		q.mu.Unlock()
		return value, false, ErrReaderExists
	}
	pending := &read[T]{owner: r, done: make(chan struct{})}
	q.reader = pending
	q.mu.Unlock()
	<-pending.done
	return pending.value, pending.ok, pending.err
}

// Detach resolves only this reader's pending Next. Other readers and retained
// values remain available, and subsequent Next calls on this reader end cleanly.
func (r *Reader[T]) Detach() {
	q := r.queue
	q.mu.Lock()
	defer q.mu.Unlock()
	r.detached = true
	if q.reader != nil && q.reader.owner == r {
		pending := q.reader
		q.reader = nil
		close(pending.done)
	}
}
