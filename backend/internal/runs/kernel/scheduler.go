package kernel

import (
	"context"
	"errors"
	"sync"
)

var (
	ErrBoundaryUnresolved = errors.New("REPEAT_BOUNDARY_UNRESOLVED")
	ErrWorkflowUnresolved = errors.New("WORKFLOW_UNRESOLVED")
	ErrRecursionLimit     = errors.New("compiled workflow exceeded its superstep budget")
)

// Invocation retains the live wrapper drain separately from its result. Wait
// can return an error or cancellation while a callback is still closing native
// work. The owner retains this handle and calls Drain with its existing cleanup
// context before releasing ownership. Nothing here certifies durable cleanup.
type Invocation struct {
	ctx      context.Context
	finished chan struct{}
	drained  chan struct{}
	settled  sync.Once
	err      error
}

// Start runs one process-local graph invocation. It does not read, publish or
// reconstruct a checkpoint. Callbacks must re-read their exact durable slots;
// completed-attempt settlement must remain a non-launching path in that adapter.
// Only the caller cancels siblings, after its existing failure classification
// and cleanup request. An arbitrary wrapper error is not new Stop authority.
func (p *Program) Start(ctx context.Context) *Invocation {
	invocation := &Invocation{ctx: ctx, finished: make(chan struct{}), drained: make(chan struct{})}
	go invocation.observeCancellation()
	go invocation.execute(p)
	return invocation
}

// Wait joins the invocation's one settled outcome. Cancellation participates in
// that race until settlement, independently of an unresponsive native iterator.
// Later cancellation cannot replace a completed result or change repeated waits.
// The caller can still Drain every callback that actually began.
func (i *Invocation) Wait() error {
	<-i.finished
	return i.err
}

func (i *Invocation) observeCancellation() {
	select {
	case <-i.finished:
	case <-i.ctx.Done():
		i.finish(context.Cause(i.ctx))
	}
}

// Drain waits only for this invocation's wrappers. A nil result means those
// callbacks returned, not that the Run or a native session has been settled.
func (i *Invocation) Drain(ctx context.Context) error {
	select {
	case <-i.drained:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}

type stepResult struct {
	step  int
	route BoundaryRoute
	err   error
}

type barrierProgress struct {
	seen      map[int]bool
	remaining int
}

func (i *Invocation) execute(program *Program) {
	defer close(i.drained)
	if program == nil || len(program.steps) == 0 {
		i.finish(ErrInvalidLayout)
		return
	}
	progress := make([]barrierProgress, len(program.barriers))
	for index, barrier := range program.barriers {
		progress[index] = barrierProgress{seen: make(map[int]bool, len(barrier.sources)), remaining: len(barrier.sources)}
	}
	ready := []int{program.start}
	for step := 0; len(ready) != 0; step++ {
		if err := context.Cause(i.ctx); err != nil {
			i.finish(err)
			return
		}
		if step >= program.recursionLimit {
			i.finish(ErrRecursionLimit)
			return
		}
		results, ok := i.superstep(program, ready)
		if !ok {
			return
		}
		if err := context.Cause(i.ctx); err != nil {
			i.finish(err)
			return
		}
		ready = program.advance(results, progress)
	}
	for _, barrier := range progress {
		if len(barrier.seen) != 0 {
			i.finish(ErrWorkflowUnresolved)
			return
		}
	}
	i.finish(nil)
}

// A superstep releases no dependent wrapper until all of its siblings return.
// Successful no-op/skip callbacks participate exactly like executed callbacks.
// On error, publish the failure promptly but retain every outstanding callback
// in this drain; their original context and limiter slot remain unchanged.
func (i *Invocation) superstep(program *Program, ready []int) ([]stepResult, bool) {
	completed := make(chan stepResult, len(ready))
	for _, step := range ready {
		go func(index int) {
			value := program.steps[index]
			result := stepResult{step: index}
			if result.err = context.Cause(i.ctx); result.err == nil {
				if value.boundary == nil {
					result.err = value.action(i.ctx)
				} else {
					result.route, result.err = value.boundary(i.ctx)
					if result.err == nil && result.route != RepeatBody && result.route != RepeatDone {
						result.err = ErrBoundaryUnresolved
					}
				}
			}
			completed <- result
		}(step)
	}
	results := make([]stepResult, 0, len(ready))
	failed := false
	canceled := i.ctx.Done()
	for range ready {
		var result stepResult
		select {
		case result = <-completed:
		case <-canceled:
			if !failed {
				i.finish(context.Cause(i.ctx))
				failed = true
			}
			canceled = nil
			result = <-completed
		}
		if result.err != nil && !failed {
			i.finish(result.err)
			failed = true
		}
		results = append(results, result)
	}
	return results, !failed
}

func (p *Program) advance(results []stepResult, progress []barrierProgress) []int {
	selected := make([]bool, len(p.steps))
	for _, result := range results {
		instruction := p.steps[result.step]
		if instruction.boundary != nil {
			target := instruction.body
			if result.route == RepeatDone {
				target = instruction.done
			}
			selected[target] = true
		}
		for _, index := range p.outgoing[result.step] {
			barrier := &progress[index]
			if !barrier.seen[result.step] {
				barrier.seen[result.step] = true
				barrier.remaining--
			}
		}
	}
	for index := range progress {
		barrier := &progress[index]
		if barrier.remaining == 0 {
			selected[p.barriers[index].target] = true
			clear(barrier.seen)
			barrier.remaining = len(p.barriers[index].sources)
		}
	}
	ready := make([]int, 0)
	for step, yes := range selected {
		if yes {
			ready = append(ready, step)
		}
	}
	return ready
}

func (i *Invocation) finish(err error) {
	i.settled.Do(func() {
		i.err = err
		close(i.finished)
	})
}
