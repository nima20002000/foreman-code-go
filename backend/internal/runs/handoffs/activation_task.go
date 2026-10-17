package handoffs

import (
	"context"
	"sync"
)

// ActivationTask retains a process-local invocation's result and callback drain.
// It is not a Run completion, native closure, authorization or checkpoint receipt.
type ActivationTask struct {
	once    sync.Once
	done    chan struct{}
	drained chan struct{}
	err     error
}

func (t *ActivationTask) finish(err error) {
	t.once.Do(func() {
		t.err = err
		close(t.done)
	})
}

// Done closes when the invocation has a result. On error or runtime cancellation
// it can close before callbacks drain. No new frontier follows that result.
func (t *ActivationTask) Done() <-chan struct{} { return t.done }

// Drained closes after every started callback returns and scheduling ends. A
// callback may have left a waiting native lifetime; native closure remains the
// existing native port's responsibility, regardless of this channel's state.
func (t *ActivationTask) Drained() <-chan struct{} { return t.drained }

// Wait observes the invocation result. Canceling this wait never cancels the
// owning runtime context or abandons its retained callbacks.
func (t *ActivationTask) Wait(ctx context.Context) error {
	select {
	case <-t.done:
		return t.err
	default:
	}
	select {
	case <-t.done:
		return t.err
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}

// WaitDrained waits only for callback drain. Call Wait separately for the graph
// result. No timeout or cleanup policy is introduced by this observation method.
func (t *ActivationTask) WaitDrained(ctx context.Context) error {
	select {
	case <-t.drained:
		return nil
	default:
	}
	select {
	case <-t.drained:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}
