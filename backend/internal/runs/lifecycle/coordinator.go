// Package lifecycle coordinates process-local workflow drives. Durable Run state,
// authorization, native effects and settlement remain in the injected ports.
package lifecycle

import (
	"context"
	"errors"
	"sync"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// Drive is the existing engine entry for one Run. It must check cancellation at
// ownership and native boundaries, and re-read the durable Stop fence on entry.
// A returned error belongs to this invocation; queued resumes may still proceed.
type Drive func(context.Context, string) error

type activeDrive struct {
	task   *Task
	cancel context.CancelCauseFunc
}

// Coordinator preserves the Start, queued resume and cancellation ordering from
// the frozen TypeScript engine. It does not admit Runs or execute graph steps.
type Coordinator struct {
	mu                sync.Mutex
	drive             Drive
	stops             StopPort
	maximumActiveRuns int
	closing           bool
	active            map[string]*activeDrive
	resumes           map[string]*Task
	cleanup           map[string]*StopTask
}

// New constructs a coordinator without starting work. Zero selects the existing
// default of 32 active Runs; a negative limit is invalid.
func New(drive Drive, stops StopPort, maximumActiveRuns int) (*Coordinator, error) {
	if drive == nil || stops == nil {
		return nil, errors.New("lifecycle requires drive and Stop ports")
	}
	if maximumActiveRuns == 0 {
		maximumActiveRuns = 32
	}
	if maximumActiveRuns < 1 {
		return nil, errors.New("maximumActiveRuns must be positive")
	}
	return &Coordinator{
		drive: drive, stops: stops, maximumActiveRuns: maximumActiveRuns,
		active: make(map[string]*activeDrive), resumes: make(map[string]*Task),
		cleanup: make(map[string]*StopTask),
	}, nil
}

// Start joins the latest queued resume or active drive for this Run. An already
// tracked task remains joinable after admission closes, as in the TS engine.
func (c *Coordinator) Start(runID string) (*Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if pending := c.resumes[runID]; pending != nil {
		return pending, nil
	}
	if active := c.active[runID]; active != nil {
		return active.task, nil
	}
	return c.trackLocked(runID)
}

// Resume queues another drive behind the latest resume or active invocation.
// It does not consume an interaction or claim an atomic graph-resume receipt.
func (c *Coordinator) Resume(runID string) (*Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closing {
		return nil, closingError()
	}
	previous := c.resumes[runID]
	if previous == nil && c.active[runID] != nil {
		previous = c.active[runID].task
	}
	task := newTask()
	c.resumes[runID] = task
	go c.resumeAfter(runID, previous, task)
	return task, nil
}

func (c *Coordinator) trackLocked(runID string) (*Task, error) {
	if c.closing {
		return nil, closingError()
	}
	if active := c.active[runID]; active != nil {
		return active.task, nil
	}
	if len(c.active) >= c.maximumActiveRuns {
		return nil, domainerror.New("RUNNER_ADMISSION_FULL",
			"The runner is at its active Run limit. Durable queued work was not launched.", 503, nil)
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	active := &activeDrive{task: newTask(), cancel: cancel}
	// Publish cancellation and task identity before the drive can acquire its
	// owner or enter preflight. No port is called while holding this mutex.
	c.active[runID] = active
	go c.runDrive(ctx, runID, active)
	return active.task, nil
}

func (c *Coordinator) runDrive(ctx context.Context, runID string, active *activeDrive) {
	err := c.drive(ctx, runID)
	c.mu.Lock()
	if c.active[runID] == active {
		delete(c.active, runID)
	}
	active.task.err = err
	close(active.task.done)
	c.mu.Unlock()
	// A natural drive return may retain a waiting native lifetime. Its closure
	// belongs to the native port; finishing a task does not cancel that lifetime.
}

func (c *Coordinator) resumeAfter(runID string, previous, task *Task) {
	if previous != nil {
		<-previous.done
		// The earlier caller receives its error. A failed invocation must not
		// prevent the next explicitly queued resume from reaching the drive.
	}
	c.mu.Lock()
	active, err := c.trackLocked(runID)
	c.mu.Unlock()
	if err == nil {
		<-active.done
		err = active.err
	}
	c.mu.Lock()
	if c.resumes[runID] == task {
		delete(c.resumes, runID)
	}
	task.err = err
	close(task.done)
	c.mu.Unlock()
}

// CloseAdmission fences new drives without stopping or settling current work.
// The owning engine must perform its durable restart/closure protocol separately.
func (c *Coordinator) CloseAdmission() {
	c.mu.Lock()
	c.closing = true
	c.mu.Unlock()
}

// AcceptsCurrentWork reports whether new Start and resume work can be tracked.
func (c *Coordinator) AcceptsCurrentWork() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closing
}

func closingError() error {
	return domainerror.New("ENGINE_CLOSING", "The workflow engine is shutting down.", 503, nil)
}
