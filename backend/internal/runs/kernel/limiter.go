package kernel

import (
	"container/list"
	"context"
	"errors"
	"sync"
)

const maximumSafeInteger int64 = 1<<53 - 1

// ErrAdmissionFull preserves the current execution limiter's waiting-cap error.
var ErrAdmissionFull = errors.New("RUNNER_ADMISSION_FULL")

// QueueWait publishes the process-local reason for a capacity wait. Its returned
// function removes that same observation when the wait ends. A caller can bind
// the generated execution identity in these closures; the kernel owns no copy of
// the execution or queue-reason contract. It is called only after a wait is
// admitted, and its cleanup finishes before work can start.
type QueueWait func() func()

// ExecutionLimiter is one Run's FIFO capacity shared by graph Agent and Job
// work. Interval observations use the native driver without graph-parallelism
// slots. Scheduler barriers and SQL-only terminal settlement do not acquire
// another slot around work that already uses this limiter.
type ExecutionLimiter struct {
	mu             sync.Mutex
	maximum        int
	maximumWaiting int
	active         int
	waiting        list.List
}

type executionPermit struct {
	ready    chan struct{}
	position *list.Element
	released bool
}

// NewExecutionLimiter accepts the existing configured limits explicitly. Zero
// waiting capacity rejects a wait but still allows work in an available slot.
func NewExecutionLimiter(maximum, maximumWaiting int) (*ExecutionLimiter, error) {
	if maximum < 1 || int64(maximum) > maximumSafeInteger {
		return nil, errors.New("maxParallelism must be a positive integer.")
	}
	if maximumWaiting < 0 || int64(maximumWaiting) > maximumSafeInteger {
		return nil, errors.New("The waiting capacity must be a nonnegative integer.")
	}
	return &ExecutionLimiter{maximum: maximum, maximumWaiting: maximumWaiting}, nil
}

// Run waits for a FIFO slot, checks cancellation again before dispatch, and
// releases the slot after work returns or panics. Cancellation does not free an
// already-running callback's slot before that callback has actually drained.
// The caller passes the same context to its native work through the closure.
func (l *ExecutionLimiter) Run(ctx context.Context, work func() error, queued QueueWait) error {
	permit, err := l.reserve(ctx)
	if err != nil {
		return err
	}
	defer l.release(permit)
	if permit.ready != nil {
		if err := l.await(ctx, permit, queued); err != nil {
			return err
		}
	}
	if err := context.Cause(ctx); err != nil {
		return err
	}
	return work()
}

func (l *ExecutionLimiter) reserve(ctx context.Context) (*executionPermit, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	if l.active < l.maximum {
		l.active++
		return &executionPermit{}, nil
	}
	if l.waiting.Len() >= l.maximumWaiting {
		return nil, ErrAdmissionFull
	}
	permit := &executionPermit{ready: make(chan struct{})}
	permit.position = l.waiting.PushBack(permit)
	return permit, nil
}

func (l *ExecutionLimiter) await(ctx context.Context, permit *executionPermit, queued QueueWait) error {
	if queued != nil {
		if finished := queued(); finished != nil {
			defer finished()
		}
	}
	select {
	case <-permit.ready:
		return nil
	case <-ctx.Done():
		// Withdraw before running observation cleanup. If cancellation raced with
		// admission, release transfers that already-reserved slot to the next wait.
		l.release(permit)
		return context.Cause(ctx)
	}
}

func (l *ExecutionLimiter) release(permit *executionPermit) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if permit.released {
		return
	}
	permit.released = true
	if permit.position != nil {
		l.waiting.Remove(permit.position)
		permit.position = nil
		return
	}
	if next := l.waiting.Front(); next != nil {
		waiting := next.Value.(*executionPermit)
		l.waiting.Remove(next)
		waiting.position = nil
		// Transfer the releasing worker's slot without reducing active. A new
		// caller cannot overtake the waiter while its goroutine is waking up.
		close(waiting.ready)
		return
	}
	l.active--
}
