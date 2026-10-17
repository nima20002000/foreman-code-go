package handoffs

import (
	"context"
	"errors"
	"sync"
)

// ActivationPort is the ID-only boundary of the frozen work-handoff graph. It
// must be bound to the same validated semantics-3 Run as its ActivationRunner.
// The caller retains Run serialization and ownership; these callbacks do not
// receive permission, accepted-input or native-launch authority from the runner.
type ActivationPort interface {
	// EnsureEntryActivation idempotently admits or reads the durable entry on
	// the existing Run owner. The returned ID is not a native launch permit.
	EnsureEntryActivation(context.Context) (string, error)
	// ExecuteActivation executes or reconciles exactly this activation through
	// the existing admission, native and accepted-result boundaries. Return
	// only newly runnable successors after their durable dispatch claim. A
	// waiting join or completed review returns no additional wake-up. The store
	// owns Run/round scope, join readiness and replay; local graph completion
	// cannot replace those checks. Return an immutable successor slice.
	ExecuteActivation(context.Context, string) ([]string, error)
}

// ActivationRunner dispatches fresh work-handoff graph invocations by ID. Each
// frontier is one superstep: all its wrappers start before another frontier is
// dispatched. The runner has no static indegree, accepted-result cache, limiter,
// checkpoint, resume command, durable write or native cleanup operation.
type ActivationRunner struct {
	runID          string
	port           ActivationPort
	recursionLimit int
}

// NewActivationRunner takes the validated compiler's explicit graph allowance.
// The frozen compiler derives it as min(2147483647, maxNodeExecutions + 16).
// There is no default or new policy cap here; this is a superstep allowance,
// not admission or execution capacity. The generated-contract compiler must
// validate the pinned handoff policy and reject repeat plus handoffs before use.
func NewActivationRunner(runID string, port ActivationPort, recursionLimit int) (*ActivationRunner, error) {
	if port == nil {
		return nil, errors.New("activation runner requires its scoped port")
	}
	if recursionLimit < 1 {
		return nil, errors.New("activation graph recursion limit must be positive")
	}
	return &ActivationRunner{runID: runID, port: port, recursionLimit: recursionLimit}, nil
}

// Start invokes entry for the supplied initial Run ID, then dispatches the IDs
// returned by the port. It is a fresh invocation, not checkpoint recovery. The
// owning engine must serialize invocations on one Run and authenticate any
// eventual resume before this boundary. A caller cannot supply activation IDs,
// accepted input, results or an unreceipted resume through this method.
//
// ctx is the owning runtime context. A canceled observer of task.Wait does not
// cancel it. Cancellation reports its original cause promptly, while Drained
// remains open until every already-started callback has returned. That channel
// measures callback drain only; it never proves physical native closure. The
// runtime must retain the task's drain even when Wait returns an early error.
func (r *ActivationRunner) Start(ctx context.Context, runID string) *ActivationTask {
	task := &ActivationTask{done: make(chan struct{}), drained: make(chan struct{})}
	go func() {
		select {
		case <-ctx.Done():
			task.finish(context.Cause(ctx))
		case <-task.done:
		}
	}()
	go r.run(ctx, runID, task)
	return task
}

func (r *ActivationRunner) run(ctx context.Context, runID string, task *ActivationTask) {
	defer close(task.drained)
	if err := context.Cause(ctx); err != nil {
		task.finish(err)
		return
	}
	if runID != r.runID {
		task.finish(errors.New("RUN_PIN_CONFLICT"))
		return
	}
	entry, err := r.port.EnsureEntryActivation(ctx)
	if err != nil {
		task.finish(err)
		return
	}
	frontier := []string{entry}
	// The entry wrapper consumes the first superstep. An empty entry ID is
	// rejected by its activation wrapper, as with the frozen graph's Send.
	for used := 1; len(frontier) > 0; used++ {
		if err := context.Cause(ctx); err != nil {
			task.finish(err)
			return
		}
		if used >= r.recursionLimit {
			task.finish(errors.New("GRAPH_RECURSION_LIMIT"))
			return
		}
		next := make([][]string, len(frontier))
		var pending sync.WaitGroup
		for index, activationID := range frontier {
			pending.Add(1)
			go func(index int, activationID string) {
				defer pending.Done()
				successors, err := r.execute(ctx, activationID)
				if err != nil {
					task.finish(err)
					return
				}
				next[index] = successors
			}(index, activationID)
		}
		pending.Wait()
		select {
		case <-task.done:
			return
		default:
		}
		frontier = nil
		for _, successors := range next {
			// Do not deduplicate across callbacks or frontiers. The frozen graph
			// preserves distinct Send operations; the store owns dispatch claims.
			frontier = append(frontier, successors...)
		}
	}
	task.finish(context.Cause(ctx))
}

func (r *ActivationRunner) execute(ctx context.Context, activationID string) ([]string, error) {
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	if activationID == "" {
		return nil, errors.New("WORK_CHECKPOINT_ACTIVATION_MISSING")
	}
	successors, err := r.port.ExecuteActivation(ctx, activationID)
	if err != nil {
		return nil, err
	}
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(successors))
	for _, id := range successors {
		if _, exists := seen[id]; exists {
			return nil, errors.New("WORK_SUCCESSOR_DUPLICATE")
		}
		seen[id] = struct{}{}
	}
	return append([]string(nil), successors...), nil
}
