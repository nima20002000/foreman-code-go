package queue_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"testing/synctest"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/claude/queue"
)

func requireQueueDiagnostic(t *testing.T, got, sentinel, other error, message string) {
	t.Helper()
	if got != sentinel || !errors.Is(got, sentinel) || errors.Is(got, other) {
		t.Fatalf("queue sentinel identity changed: %v", got)
	}
	if got.Error() != message || errors.Unwrap(got) != nil {
		t.Fatalf("queue diagnostic changed: %v", got)
	}
	if !errors.Is(fmt.Errorf("queue operation: %w", got), sentinel) {
		t.Fatal("wrapped queue sentinel no longer matches")
	}
}

// The constructor must return the same diagnostic as the frozen public queue.
func TestCapacityErrorPreservesFrozenMessage(t *testing.T) {
	for _, capacity := range []int{0, -1} {
		q, err := queue.New[string](capacity, nil)
		if q != nil || err == nil {
			t.Fatalf("invalid capacity %d returned queue=%v error=%v", capacity, q, err)
		}
		requireQueueDiagnostic(t, err, queue.ErrCapacity, queue.ErrClosed, "Invalid Claude queue capacity")
	}
}

// These guards preserve existing public sentinel behavior; they are not new
// behavior regressions and are expected to pass before the diagnostic repair.
func TestQueuePublicErrorCompatibility(t *testing.T) {
	t.Run("closed sentinel", func(t *testing.T) {
		q := newQueue[string](t, 1, nil)
		q.Close(nil, false)
		for _, value := range []string{"first", "second"} {
			err := q.Offer(context.Background(), value)
			requireQueueDiagnostic(t, err, queue.ErrClosed, queue.ErrReaderExists, "Claude queue closed")
		}
	})
	t.Run("reader sentinel", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			q := newQueue[string](t, 1, nil)
			defer q.Close(nil, true)
			owner := q.Reader()
			pending := read(owner)
			synctest.Wait()
			for attempt := 0; attempt < 2; attempt++ {
				_, ok, err := q.Reader().Next()
				if ok {
					t.Fatal("second reader received a value without an offer")
				}
				requireQueueDiagnostic(t, err, queue.ErrReaderExists, queue.ErrClosed, "Claude queue already has a reader")
			}
			owner.Detach()
			if got := <-pending; got.ok || got.err != nil {
				t.Fatalf("owner detach changed after rejected readers: %+v", got)
			}
		})
	})
}
