package handoffs_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/handoffs"
)

func TestActivationRunnerRequiresPortAndExplicitAllowance(t *testing.T) {
	if _, err := handoffs.NewActivationRunner("run", nil, 32); err == nil {
		t.Fatal("missing scoped port was accepted")
	}
	port := activationPort{}
	for _, limit := range []int{0, -1} {
		if _, err := handoffs.NewActivationRunner("run", port, limit); err == nil {
			t.Fatalf("nonpositive recursion allowance %d was accepted", limit)
		}
	}
}

func TestActivationRunnerRejectsRunMismatchBeforeEntry(t *testing.T) {
	var calls atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) {
			calls.Add(1)
			return "entry", nil
		},
		execute: func(context.Context, string) ([]string, error) {
			calls.Add(1)
			return nil, nil
		},
	}, 32)
	activationError(t, runner.Start(context.Background(), "foreign-run"), "RUN_PIN_CONFLICT")
	if calls.Load() != 0 {
		t.Fatal("foreign Run reached a scoped callback")
	}
}

func TestActivationRunnerPreservesCallbackContextAndIDs(t *testing.T) {
	type contextKey struct{}
	ctx := context.WithValue(context.Background(), contextKey{}, "owned-context")
	var entryCalls, executionCalls atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(got context.Context) (string, error) {
			entryCalls.Add(1)
			if got != ctx || got.Value(contextKey{}) != "owned-context" {
				return "", errors.New("entry context changed")
			}
			return "opaque-entry-id", nil
		},
		execute: func(got context.Context, id string) ([]string, error) {
			executionCalls.Add(1)
			if got != ctx || got.Value(contextKey{}) != "owned-context" {
				return nil, errors.New("activation context changed")
			}
			if id != "opaque-entry-id" {
				return nil, errors.New("activation ID changed")
			}
			return nil, nil
		},
	}, 32)
	task := runner.Start(ctx, "run")
	if err := activationWait(t, task); err != nil {
		t.Fatal(err)
	}
	activationDrain(t, task)
	if entryCalls.Load() != 1 || executionCalls.Load() != 1 {
		t.Fatal("entry and activation must each be called exactly once")
	}
}

func TestActivationRunnerWaitsForWholeFrontierBeforeSuccessors(t *testing.T) {
	fastReturned, slowEntered, childEntered := make(chan struct{}), make(chan struct{}), make(chan struct{})
	slowRelease := activationGate(t)
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "root", nil },
		execute: func(_ context.Context, id string) ([]string, error) {
			switch id {
			case "root":
				return []string{"fast", "slow"}, nil
			case "fast":
				close(fastReturned)
				return []string{"child"}, nil
			case "slow":
				close(slowEntered)
				<-slowRelease
				return nil, nil
			case "child":
				close(childEntered)
				return nil, nil
			default:
				return nil, errors.New("unexpected activation")
			}
		},
	}, 32)
	task := runner.Start(context.Background(), "run")
	activationReceive(t, fastReturned)
	activationReceive(t, slowEntered)
	activationPending(t, childEntered)
	activationPending(t, task.Done())
	close(slowRelease)
	activationReceive(t, childEntered)
	if err := activationWait(t, task); err != nil {
		t.Fatal(err)
	}
	activationDrain(t, task)
}

func TestActivationRunnerRejectsDuplicateSuccessorsBeforeDispatch(t *testing.T) {
	for _, successors := range [][]string{{"child", "child"}, {"", ""}} {
		var calls atomic.Int32
		runner := activationRunner(t, activationPort{
			entry: func(context.Context) (string, error) { return "root", nil },
			execute: func(context.Context, string) ([]string, error) {
				calls.Add(1)
				return successors, nil
			},
		}, 32)
		activationError(t, runner.Start(context.Background(), "run"), "WORK_SUCCESSOR_DUPLICATE")
		if calls.Load() != 1 {
			t.Fatal("duplicate result dispatched a successor")
		}
	}
}

func TestActivationRunnerRejectsMissingActivationIDs(t *testing.T) {
	for _, missingEntry := range []bool{true, false} {
		var calls atomic.Int32
		runner := activationRunner(t, activationPort{
			entry: func(context.Context) (string, error) {
				if missingEntry {
					return "", nil
				}
				return "root", nil
			},
			execute: func(context.Context, string) ([]string, error) {
				calls.Add(1)
				return []string{""}, nil
			},
		}, 32)
		activationError(t, runner.Start(context.Background(), "run"), "WORK_CHECKPOINT_ACTIVATION_MISSING")
		var expected int32 = 1
		if missingEntry {
			expected = 0
		}
		if calls.Load() != expected {
			t.Fatal("empty activation ID reached the execution port")
		}
	}
}

func TestActivationRunnerKeepsSeparateSendsToSameActivation(t *testing.T) {
	var joined atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "root", nil },
		execute: func(_ context.Context, id string) ([]string, error) {
			switch id {
			case "root":
				return []string{"left", "right"}, nil
			case "left", "right":
				return []string{"join"}, nil
			case "join":
				joined.Add(1)
				return nil, nil
			default:
				return nil, errors.New("unexpected activation")
			}
		},
	}, 32)
	task := runner.Start(context.Background(), "run")
	if err := activationWait(t, task); err != nil {
		t.Fatal(err)
	}
	activationDrain(t, task)
	if joined.Load() != 2 {
		t.Fatal("runner invented a cross-callback deduplication or join rule")
	}
}

func TestActivationRunnerAllowsLaterReconciliationOfSameID(t *testing.T) {
	var calls atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "same", nil },
		execute: func(context.Context, string) ([]string, error) {
			if calls.Add(1) == 1 {
				return []string{"same"}, nil
			}
			return nil, nil
		},
	}, 32)
	task := runner.Start(context.Background(), "run")
	if err := activationWait(t, task); err != nil {
		t.Fatal(err)
	}
	activationDrain(t, task)
	if calls.Load() != 2 {
		t.Fatal("local completion cache suppressed a returned activation ID")
	}
}

func TestActivationRunnerEmptyBranchDoesNotEndSiblingProgress(t *testing.T) {
	var last atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "root", nil },
		execute: func(_ context.Context, id string) ([]string, error) {
			switch id {
			case "root":
				return []string{"waiting", "branch"}, nil
			case "waiting":
				return nil, nil
			case "branch":
				return []string{"last"}, nil
			case "last":
				last.Add(1)
				return nil, nil
			default:
				return nil, errors.New("unexpected activation")
			}
		},
	}, 32)
	task := runner.Start(context.Background(), "run")
	if err := activationWait(t, task); err != nil {
		t.Fatal(err)
	}
	activationDrain(t, task)
	if last.Load() != 1 {
		t.Fatal("empty successor list ended unrelated branch work")
	}
}

func TestActivationRunnerFreshInvocationDoesNotCacheCompletion(t *testing.T) {
	var entries, executions atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) {
			entries.Add(1)
			return "entry", nil
		},
		execute: func(context.Context, string) ([]string, error) {
			executions.Add(1)
			return nil, nil
		},
	}, 32)
	for range 2 {
		task := runner.Start(context.Background(), "run")
		if err := activationWait(t, task); err != nil {
			t.Fatal(err)
		}
		activationDrain(t, task)
	}
	if entries.Load() != 2 || executions.Load() != 2 {
		t.Fatal("fresh invocation bypassed its durable replay callbacks")
	}
}

func TestActivationRunnerUsesSuppliedSuperstepAllowance(t *testing.T) {
	var calls atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "again", nil },
		execute: func(context.Context, string) ([]string, error) {
			calls.Add(1)
			return []string{"again"}, nil
		},
	}, 17)
	activationError(t, runner.Start(context.Background(), "run"), "GRAPH_RECURSION_LIMIT")
	if calls.Load() != 16 {
		t.Fatalf("activation callbacks = %d; entry must consume one superstep", calls.Load())
	}
}

func TestActivationRunnerPreservesEntryAndExecutionErrors(t *testing.T) {
	for _, entryFailure := range []bool{true, false} {
		failure := errors.New("original callback failure")
		var calls atomic.Int32
		runner := activationRunner(t, activationPort{
			entry: func(context.Context) (string, error) {
				if entryFailure {
					return "", failure
				}
				return "entry", nil
			},
			execute: func(context.Context, string) ([]string, error) {
				calls.Add(1)
				return []string{"must-not-run"}, failure
			},
		}, 32)
		task := runner.Start(context.Background(), "run")
		if err := activationWait(t, task); err != failure {
			t.Fatalf("error = %v, want original callback error", err)
		}
		activationDrain(t, task)
		var expected int32 = 1
		if entryFailure {
			expected = 0
		}
		if calls.Load() != expected {
			t.Fatal("failed callback dispatched later work")
		}
	}
}
