package lifecycle

import "context"

// Task is a shared drive or queued-resume result. Waiting cancellation affects
// only the caller, not the owned workflow execution.
type Task struct {
	done chan struct{}
	err  error
}

func newTask() *Task { return &Task{done: make(chan struct{})} }

// Done closes after the drive result and process-local cleanup are available.
func (t *Task) Done() <-chan struct{} { return t.done }

// Wait returns the shared drive result, or the waiting caller's cancellation.
func (t *Task) Wait(ctx context.Context) error {
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

// StopTask is the existing cleanup operation's shared result. A true value from
// Wait comes only from the owning port's final persisted settlement read.
type StopTask struct {
	done    chan struct{}
	stopped bool
	err     error
}

// Done closes after native work and the captured drive/resume tasks have drained
// and the owning port has attempted authoritative settlement.
func (t *StopTask) Done() <-chan struct{} { return t.done }

// Wait separates a caller's wait from the cleanup lifetime. It returns false on
// caller cancellation, without declaring that cleanup finished or stopping it.
func (t *StopTask) Wait(ctx context.Context) (bool, error) {
	select {
	case <-t.done:
		return t.stopped, t.err
	default:
	}
	select {
	case <-t.done:
		return t.stopped, t.err
	case <-ctx.Done():
		return false, context.Cause(ctx)
	}
}
