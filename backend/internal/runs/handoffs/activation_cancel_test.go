package handoffs_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestActivationRunnerCanceledContextPrecedesEntryAndPinCheck(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("original runtime cancellation")
	cancel(cause)
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
	task := runner.Start(ctx, "foreign-run")
	if err := activationWait(t, task); err != cause {
		t.Fatalf("error = %v, want original runtime cancellation", err)
	}
	activationDrain(t, task)
	if calls.Load() != 0 {
		t.Fatal("canceled invocation entered a port")
	}
}

func TestActivationRunnerCancellationRetainsInFlightEntryDrain(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	entered, release := make(chan struct{}), activationGate(t)
	var executions atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) {
			close(entered)
			<-release
			return "late-entry", nil
		},
		execute: func(context.Context, string) ([]string, error) {
			executions.Add(1)
			return nil, nil
		},
	}, 32)
	task := runner.Start(ctx, "run")
	activationReceive(t, entered)
	cause := errors.New("cancel while entry is returning")
	cancel(cause)
	if err := activationWait(t, task); err != cause {
		t.Fatalf("error = %v, want entry cancellation cause", err)
	}
	activationPending(t, task.Drained())
	close(release)
	activationDrain(t, task)
	if executions.Load() != 0 {
		t.Fatal("late entry result dispatched after cancellation")
	}
}

func TestActivationRunnerCancellationDiscardsLateSuccessorsAndRetainsDrain(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	entered, release := make(chan struct{}), activationGate(t)
	var late atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "entry", nil },
		execute: func(_ context.Context, id string) ([]string, error) {
			if id == "entry" {
				close(entered)
				<-release
				return []string{"late"}, nil
			}
			late.Add(1)
			return nil, nil
		},
	}, 32)
	task := runner.Start(ctx, "run")
	activationReceive(t, entered)
	cause := errors.New("stop during an uncooperative callback")
	cancel(cause)
	if err := activationWait(t, task); err != cause {
		t.Fatalf("error = %v, want callback cancellation cause", err)
	}
	activationPending(t, task.Drained())
	close(release)
	activationDrain(t, task)
	if late.Load() != 0 {
		t.Fatal("late successor escaped the canceled frontier")
	}
}

func TestActivationRunnerCanceledWaitDoesNotCancelOwnedWork(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	entered, release := make(chan struct{}), activationGate(t)
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "entry", nil },
		execute: func(got context.Context, _ string) ([]string, error) {
			close(entered)
			<-release
			return nil, context.Cause(got)
		},
	}, 32)
	task := runner.Start(ctx, "run")
	activationReceive(t, entered)
	observer, stopWaiting := context.WithCancelCause(context.Background())
	cause := errors.New("caller stopped observing")
	stopWaiting(cause)
	if err := task.Wait(observer); err != cause {
		t.Fatalf("wait error = %v, want observer cause", err)
	}
	if err := task.WaitDrained(observer); err != cause {
		t.Fatalf("drain wait error = %v, want observer cause", err)
	}
	if ctx.Err() != nil {
		t.Fatal("observer cancellation reached owned runtime context")
	}
	activationPending(t, task.Done())
	activationPending(t, task.Drained())
	close(release)
	if err := activationWait(t, task); err != nil {
		t.Fatal(err)
	}
	activationDrain(t, task)
	if ctx.Err() != nil {
		t.Fatal("natural completion canceled a context retained by a native lifetime")
	}
	if err := task.Wait(observer); err != nil {
		t.Fatalf("retained completed result changed to observer cancellation: %v", err)
	}
	if err := task.WaitDrained(observer); err != nil {
		t.Fatalf("already completed drain changed to observer cancellation: %v", err)
	}
}

func TestActivationRunnerFailureReportsBeforeSiblingDrainWithoutCancelingIt(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	slowEntered := make(chan struct{})
	failNow, slowRelease := activationGate(t), activationGate(t)
	failure := errors.New("original callback failure")
	var late atomic.Int32
	var siblingCanceled atomic.Bool
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "root", nil },
		execute: func(got context.Context, id string) ([]string, error) {
			switch id {
			case "root":
				return []string{"failing", "slow"}, nil
			case "failing":
				<-failNow
				return nil, failure
			case "slow":
				close(slowEntered)
				<-slowRelease
				if got.Err() != nil {
					siblingCanceled.Store(true)
					return nil, errors.New("runner canceled a sibling before the durable cleanup boundary")
				}
				return []string{"late"}, nil
			default:
				late.Add(1)
				return nil, nil
			}
		},
	}, 32)
	task := runner.Start(ctx, "run")
	activationReceive(t, slowEntered)
	close(failNow)
	if err := activationWait(t, task); err != failure {
		t.Fatalf("error = %v, want original frontier failure", err)
	}
	activationPending(t, task.Drained())
	if ctx.Err() != nil {
		t.Fatal("graph failure invented authority to cancel the runtime")
	}
	close(slowRelease)
	activationDrain(t, task)
	if siblingCanceled.Load() {
		t.Fatal("runner canceled an already-started sibling callback")
	}
	if late.Load() != 0 {
		t.Fatal("successful sibling dispatched a later frontier after graph failure")
	}
	if err := activationWait(t, task); err != failure {
		t.Fatal("later callback completion replaced the first graph error")
	}
}

func TestActivationRunnerPostCallbackCancellationPrecedesSuccessorValidation(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	cause := errors.New("canceled at callback boundary")
	var calls atomic.Int32
	runner := activationRunner(t, activationPort{
		entry: func(context.Context) (string, error) { return "entry", nil },
		execute: func(context.Context, string) ([]string, error) {
			calls.Add(1)
			cancel(cause)
			return []string{"duplicate", "duplicate"}, nil
		},
	}, 32)
	task := runner.Start(ctx, "run")
	if err := activationWait(t, task); err != cause {
		t.Fatalf("error = %v, want post-callback cancellation before duplicate validation", err)
	}
	activationDrain(t, task)
	if calls.Load() != 1 {
		t.Fatal("canceled callback dispatched later work")
	}
}
