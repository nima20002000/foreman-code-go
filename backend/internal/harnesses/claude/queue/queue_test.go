package queue_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"testing/synctest"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/claude/queue"
)

func newQueue[T any](t *testing.T, capacity int, coalesce func(T, T) (T, bool)) *queue.Queue[T] {
	t.Helper()
	q, err := queue.New(capacity, coalesce)
	if err != nil {
		t.Fatal(err)
	}
	return q
}

func offer[T any](q *queue.Queue[T], ctx context.Context, value T) <-chan error {
	result := make(chan error, 1)
	go func() { result <- q.Offer(ctx, value) }()
	return result
}

func requirePending(t *testing.T, result <-chan error) {
	t.Helper()
	synctest.Wait()
	select {
	case err := <-result:
		t.Fatalf("offer completed without capacity: %v", err)
	default:
	}
}

func requireOffer(t *testing.T, result <-chan error, want error) {
	t.Helper()
	if err := <-result; !errors.Is(err, want) {
		t.Fatalf("offer error = %v, want %v", err, want)
	}
}

func requireNext[T comparable](t *testing.T, reader *queue.Reader[T], want T) {
	t.Helper()
	value, ok, err := reader.Next()
	if err != nil || !ok || value != want {
		t.Fatalf("Next = (%v, %v, %v), want (%v, true, nil)", value, ok, err, want)
	}
}

func requireEnd[T any](t *testing.T, reader *queue.Reader[T], want error) {
	t.Helper()
	_, ok, err := reader.Next()
	if ok || !errors.Is(err, want) {
		t.Fatalf("Next = (_, %v, %v), want (_, false, %v)", ok, err, want)
	}
}

type readResult[T any] struct {
	value T
	ok bool
	err error
}

func read[T any](reader *queue.Reader[T]) <-chan readResult[T] {
	result := make(chan readResult[T], 1)
	go func() {
		value, ok, err := reader.Next()
		result <- readResult[T]{value: value, ok: ok, err: err}
	}()
	return result
}

func TestCapacityMustBePositive(t *testing.T) {
	for _, capacity := range []int{0, -1, -8} {
		if _, err := queue.New[string](capacity, nil); !errors.Is(err, queue.ErrCapacity) {
			t.Fatalf("capacity %d: %v", capacity, err)
		}
	}
	q := newQueue[string](t, 1, nil)
	q.Close(nil, true)
}

func TestOfferPreservesFIFOAndBackpressure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		if err := q.Offer(context.Background(), "text"); err != nil {
			t.Fatal(err)
		}
		permission := offer(q, context.Background(), "permission")
		requirePending(t, permission)
		terminal := offer(q, context.Background(), "terminal")
		requirePending(t, terminal)
		reader := q.Reader()
		requireNext(t, reader, "text")
		requireOffer(t, permission, nil)
		requirePending(t, terminal)
		requireNext(t, reader, "permission")
		requireOffer(t, terminal, nil)
		q.Close(nil, false)
		requireNext(t, reader, "terminal")
		requireEnd(t, reader, nil)
		if err := q.Offer(context.Background(), "late"); !errors.Is(err, queue.ErrClosed) {
			t.Fatalf("offer after closure = %v", err)
		}
	})
}

func TestOfferHandsOffToWaitingReader(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		pending := read(q.Reader())
		synctest.Wait()
		if err := q.Offer(context.Background(), "direct"); err != nil {
			t.Fatal(err)
		}
		got := <-pending
		if got.value != "direct" || !got.ok || got.err != nil {
			t.Fatalf("waiting reader = %+v", got)
		}
	})
}

func TestCoalescingOnlyUsesFullUncontendedBuffer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 2, func(prior, next string) (string, bool) {
			if !strings.HasPrefix(prior, "text:") || !strings.HasPrefix(next, "text:") {
				return "", false
			}
			return prior + "+" + strings.TrimPrefix(next, "text:"), true
		})
		defer q.Close(nil, true)
		for _, value := range []string{"text:a", "text:b", "text:c"} {
			if err := q.Offer(context.Background(), value); err != nil {
				t.Fatal(err)
			}
		}
		permission := offer(q, context.Background(), "permission")
		requirePending(t, permission)
		text := offer(q, context.Background(), "text:d")
		requirePending(t, text)
		reader := q.Reader()
		requireNext(t, reader, "text:a")
		requireOffer(t, permission, nil)
		requireNext(t, reader, "text:b+c")
		requireOffer(t, text, nil)
		requireNext(t, reader, "permission")
		requireNext(t, reader, "text:d")
	})
}

func TestCanceledOfferCannotEnterQueue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		ctx, cancel := context.WithCancelCause(context.Background())
		reason := errors.New("prompt withdrawn")
		cancel(reason)
		if err := q.Offer(ctx, "never"); !errors.Is(err, reason) {
			t.Fatalf("already canceled offer = %v", err)
		}
		if err := q.Offer(context.Background(), "first"); err != nil {
			t.Fatal(err)
		}
		ctx, cancel = context.WithCancelCause(context.Background())
		pending := offer(q, ctx, "withdrawn")
		requirePending(t, pending)
		cancel(reason)
		requireOffer(t, pending, reason)
		reader := q.Reader()
		requireNext(t, reader, "first")
		if err := q.Offer(context.Background(), "last"); err != nil {
			t.Fatal(err)
		}
		q.Close(nil, false)
		requireNext(t, reader, "last")
		requireEnd(t, reader, nil)
	})
}

func TestCanceledWriterDoesNotDelayRemainingWriters(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		if err := q.Offer(context.Background(), "first"); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancelCause(context.Background())
		defer cancel(nil)
		withdrawn := offer(q, ctx, "withdrawn")
		requirePending(t, withdrawn)
		remaining := offer(q, context.Background(), "remaining")
		requirePending(t, remaining)
		reason := errors.New("withdraw before capacity opens")
		cancel(reason)
		reader := q.Reader()
		requireNext(t, reader, "first")
		requireOffer(t, withdrawn, reason)
		requireOffer(t, remaining, nil)
		q.Close(nil, false)
		requireNext(t, reader, "remaining")
		requireEnd(t, reader, nil)
	})
}

func TestAcceptedOfferStaysAcceptedAfterCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		if err := q.Offer(context.Background(), "first"); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		pending := offer(q, ctx, "accepted")
		requirePending(t, pending)
		reader := q.Reader()
		requireNext(t, reader, "first")
		cancel()
		requireOffer(t, pending, nil)
		requireNext(t, reader, "accepted")
	})
}

func TestDiscardReleasesWritersWithoutClosingQueue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		if err := q.Offer(context.Background(), "old"); err != nil {
			t.Fatal(err)
		}
		first := offer(q, context.Background(), "old permission")
		requirePending(t, first)
		second := offer(q, context.Background(), "old terminal")
		requirePending(t, second)
		q.Discard()
		requireOffer(t, first, nil)
		requireOffer(t, second, nil)
		if err := q.Offer(context.Background(), "fresh"); err != nil {
			t.Fatal(err)
		}
		q.Close(nil, false)
		reader := q.Reader()
		requireNext(t, reader, "fresh")
		requireEnd(t, reader, nil)
	})
}

func TestCloseRetainsValuesAndFirstFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 2, nil)
		defer q.Close(nil, true)
		for _, value := range []string{"first", "second"} {
			if err := q.Offer(context.Background(), value); err != nil {
				t.Fatal(err)
			}
		}
		pending := offer(q, context.Background(), "blocked")
		requirePending(t, pending)
		failure := errors.New("native failure")
		q.Close(failure, false)
		requireOffer(t, pending, failure)
		q.Close(errors.New("later failure"), true)
		if err := q.Offer(context.Background(), "late"); !errors.Is(err, failure) {
			t.Fatalf("offer after failed closure = %v", err)
		}
		reader := q.Reader()
		requireNext(t, reader, "first")
		requireNext(t, reader, "second")
		requireEnd(t, reader, failure)
	})
}

func TestDiscardingCloseReleasesWritersAndRetainsFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		if err := q.Offer(context.Background(), "old"); err != nil {
			t.Fatal(err)
		}
		pending := offer(q, context.Background(), "discarded")
		requirePending(t, pending)
		failure := errors.New("reader failure")
		q.Close(failure, true)
		requireOffer(t, pending, nil)
		requireEnd(t, q.Reader(), failure)
		if err := q.Offer(context.Background(), "late"); !errors.Is(err, failure) {
			t.Fatalf("offer after discarding closure = %v", err)
		}
	})
}

func TestCloseFinishesWaitingReader(t *testing.T) {
	for _, failure := range []error{nil, errors.New("reader failure")} {
		synctest.Test(t, func(t *testing.T) {
			q := newQueue[string](t, 1, nil)
			defer q.Close(nil, true)
			pending := read(q.Reader())
			synctest.Wait()
			q.Close(failure, false)
			got := <-pending
			if got.ok || !errors.Is(got.err, failure) {
				t.Fatalf("waiting reader after close = %+v, want %v", got, failure)
			}
			requireEnd(t, q.Reader(), failure)
		})
	}
}

func TestReaderDetachOnlyReleasesItsOwnWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		first, second := q.Reader(), q.Reader()
		pending := read(first)
		synctest.Wait()
		requireEnd(t, second, queue.ErrReaderExists)
		second.Detach()
		if err := q.Offer(context.Background(), "first reader"); err != nil {
			t.Fatal(err)
		}
		if got := <-pending; got.value != "first reader" || !got.ok || got.err != nil {
			t.Fatalf("first reader = %+v", got)
		}
		pending = read(first)
		synctest.Wait()
		first.Detach()
		if got := <-pending; got.ok || got.err != nil {
			t.Fatalf("detached reader = %+v", got)
		}
		requireEnd(t, first, nil)
		third := q.Reader()
		pending = read(third)
		synctest.Wait()
		first.Detach()
		if err := q.Offer(context.Background(), "third reader"); err != nil {
			t.Fatal(err)
		}
		if got := <-pending; got.value != "third reader" || !got.ok || got.err != nil {
			t.Fatalf("replacement reader = %+v", got)
		}
	})
}

func TestDiscardPreservesWaitingReader(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		defer q.Close(nil, true)
		pending := read(q.Reader())
		synctest.Wait()
		q.Discard()
		synctest.Wait()
		select {
		case got := <-pending:
			t.Fatalf("discard detached the reader: %+v", got)
		default:
		}
		if err := q.Offer(context.Background(), "future"); err != nil {
			t.Fatal(err)
		}
		if got := <-pending; got.value != "future" || !got.ok || got.err != nil {
			t.Fatalf("reader after discard = %+v", got)
		}
	})
}
