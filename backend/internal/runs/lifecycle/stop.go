package lifecycle

import (
	"context"
	"errors"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// StopPort retains the existing engine cancellation boundary. PrepareStop must
// commit the authorized Stop when requested, or read an already committed Stop,
// cleanup intent or terminal Run. It must reject an active, unfenced Run.
// This is an internal operation, not a receipt or an authorization capability.
type StopPort interface {
	PrepareStop(context.Context, string) (StopWork, error)
}

// StopWork captures the native operation selected from that authoritative read:
// finish a successful unstopped terminal Run, otherwise cancel its native work.
// Settle must acquire the existing Run owner, clean up, re-read persisted state
// and return true only for a completed Run with no pending cleanup. A missing
// owner returns false; a native callback's success alone cannot return true.
type StopWork interface {
	CloseNative(context.Context) error
	Settle(context.Context) (bool, error)
}

// Stop checks the durable boundary on every call, including callers joining an
// existing cleanup. The returned task is process-local work, never a public Stop
// receipt. Its physical settlement result is available only after Wait finishes.
func (c *Coordinator) Stop(ctx context.Context, runID string) (*StopTask, error) {
	work, err := c.stops.PrepareStop(ctx, runID)
	if err != nil {
		return nil, err
	}
	if work == nil {
		return nil, errors.New("Stop preparation returned no native cleanup operation")
	}
	c.mu.Lock()
	if existing := c.cleanup[runID]; existing != nil {
		c.mu.Unlock()
		return existing, nil
	}
	active := c.active[runID]
	if active != nil {
		active.cancel(domainerror.New("GRAPH_STOP_CONFLICT",
			"The Run has a durable Stop or cleanup request.", 409, nil))
	}
	resumed := c.resumes[runID]
	task := &StopTask{done: make(chan struct{})}
	c.cleanup[runID] = task
	c.mu.Unlock()
	// A caller ceasing to wait cannot undo its committed Stop or abandon cleanup.
	go c.runStop(context.WithoutCancel(ctx), runID, work, active, resumed, task)
	return task, nil
}

func (c *Coordinator) runStop(ctx context.Context, runID string, work StopWork,
	active *activeDrive, resumed *Task, task *StopTask) {
	// Like Promise.allSettled in the TS engine, native/drive failures do not skip
	// authoritative cleanup. Settle rechecks actual closure under the Run owner;
	// its result, including any failure, is the Stop task's only final verdict.
	_ = work.CloseNative(ctx)
	if active != nil {
		<-active.task.done
	}
	if resumed != nil {
		<-resumed.done
	}
	stopped, err := work.Settle(ctx)
	if err != nil {
		stopped = false
	}
	c.mu.Lock()
	if c.cleanup[runID] == task {
		delete(c.cleanup, runID)
	}
	task.stopped, task.err = stopped, err
	close(task.done)
	c.mu.Unlock()
}
