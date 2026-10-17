package kernel_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/kernel"
)

func TestSchedulerWaitsForEveryIncomingWrapper(t *testing.T) {
	var builder kernel.Builder
	var settled atomic.Int32
	slowGate := newGate(t)
	slowStarted, fastSettled, joined := make(chan struct{}), make(chan struct{}), make(chan struct{})
	start := addStep(t, &builder, noWork)
	slow := addStep(t, &builder, func(context.Context) error {
		close(slowStarted)
		<-slowGate.channel
		settled.Add(1)
		return nil
	})
	fast := addStep(t, &builder, func(context.Context) error {
		settled.Add(1)
		close(fastSettled)
		return nil
	})
	join := addStep(t, &builder, func(context.Context) error {
		if settled.Load() != 2 {
			return errors.New("join admitted before every incoming wrapper settled")
		}
		close(joined)
		return nil
	})
	depend(t, &builder, slow, start)
	depend(t, &builder, fast, start)
	depend(t, &builder, join, slow, fast)
	invocation := compileProgram(t, &builder, start, 10).Start(context.Background())
	await(t, slowStarted)
	await(t, fastSettled)
	notSignaled(t, joined, "join ran while an incoming dependency was unresolved")
	slowGate.release()
	finishInvocation(t, invocation, nil)
	await(t, joined)
}

func TestSchedulerSkippedWrappersStillSettleDownstreamBarriers(t *testing.T) {
	var builder kernel.Builder
	var selectedSettled, skippedSettled, downstreamSkipped atomic.Bool
	start := addStep(t, &builder, noWork)
	selected := addStep(t, &builder, func(context.Context) error { selectedSettled.Store(true); return nil })
	skipped := addStep(t, &builder, func(context.Context) error {
		// The store-shaped fake resolves this wrapper as skipped, without native work.
		skippedSettled.Store(true)
		return nil
	})
	join := addStep(t, &builder, func(context.Context) error {
		if !selectedSettled.Load() || !skippedSettled.Load() {
			return errors.New("mixed selected/unselected join lacks a settled predecessor")
		}
		return nil
	})
	skippedChild := addStep(t, &builder, func(context.Context) error {
		if !skippedSettled.Load() {
			return errors.New("skip propagated before its predecessor settled")
		}
		downstreamSkipped.Store(true)
		return nil
	})
	terminal := addStep(t, &builder, func(context.Context) error {
		if !downstreamSkipped.Load() {
			return errors.New("skipped branch did not fire its completion barrier")
		}
		return nil
	})
	depend(t, &builder, selected, start)
	depend(t, &builder, skipped, start)
	depend(t, &builder, join, selected, skipped)
	depend(t, &builder, skippedChild, skipped)
	depend(t, &builder, terminal, join, skippedChild)
	finishInvocation(t, compileProgram(t, &builder, start, 10).Start(context.Background()), nil)
}

func TestSchedulerRepeatBarriersResetForEveryOccurrence(t *testing.T) {
	var builder kernel.Builder
	var occurrence, leftSettled, skippedSettled, exits, outsideCalls atomic.Int32
	entry := addStep(t, &builder, noWork)
	left := addStep(t, &builder, func(context.Context) error { leftSettled.Store(occurrence.Load()); return nil })
	skipped := addStep(t, &builder, func(context.Context) error { skippedSettled.Store(occurrence.Load()); return nil })
	exit := addStep(t, &builder, func(context.Context) error {
		current := occurrence.Load()
		if leftSettled.Load() != current || skippedSettled.Load() != current {
			return errors.New("repeat barrier borrowed a prior occurrence's completion")
		}
		exits.Add(1)
		return nil
	})
	depend(t, &builder, left, entry)
	depend(t, &builder, skipped, entry)
	depend(t, &builder, exit, left, skipped)
	boundary := repeatSteps(t, &builder, entry, exit,
		func(context.Context) (kernel.BoundaryRoute, error) {
			occurrence.Store(1)
			return kernel.RepeatBody, nil
		}, func(context.Context) (kernel.BoundaryRoute, error) {
			if exits.Load() != occurrence.Load() {
				return 0, errors.New("advance overtook a body exit")
			}
			if occurrence.Load() == 3 {
				return kernel.RepeatDone, nil
			}
			occurrence.Add(1)
			return kernel.RepeatBody, nil
		})
	outside := addStep(t, &builder, func(context.Context) error {
		if exits.Load() != 3 {
			return errors.New("intermediate repeat exit released external work")
		}
		outsideCalls.Add(1)
		return nil
	})
	depend(t, &builder, outside, boundary.Done)
	program := compileProgram(t, &builder, boundary.Enter, 30)
	finishInvocation(t, program.Start(context.Background()), nil)
	if exits.Load() != 3 || outsideCalls.Load() != 1 {
		t.Fatalf("got %d exits and %d outside calls; want 3 and 1", exits.Load(), outsideCalls.Load())
	}
}

func TestSchedulerInactiveRepeatCompletesWithoutBodyOrAdvance(t *testing.T) {
	var builder kernel.Builder
	var outsideCalls atomic.Int32
	body := addStep(t, &builder, func(context.Context) error { return errors.New("inactive body executed") })
	boundary := repeatSteps(t, &builder, body, body, chooseDone,
		func(context.Context) (kernel.BoundaryRoute, error) { return 0, errors.New("inactive block advanced") })
	outside := addStep(t, &builder, func(context.Context) error { outsideCalls.Add(1); return nil })
	depend(t, &builder, outside, boundary.Done)
	finishInvocation(t, compileProgram(t, &builder, boundary.Enter, 10).Start(context.Background()), nil)
	if outsideCalls.Load() != 1 {
		t.Fatalf("outside calls = %d; want 1", outsideCalls.Load())
	}
}

func TestSchedulerExternalJoinWaitsForRepeatDone(t *testing.T) {
	var builder kernel.Builder
	advanceGate := newGate(t)
	bodyExited, otherSettled, outsideStarted := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var published atomic.Bool
	start := addStep(t, &builder, noWork)
	body := addStep(t, &builder, func(context.Context) error { close(bodyExited); return nil })
	boundary := repeatSteps(t, &builder, body, body, chooseBody,
		func(context.Context) (kernel.BoundaryRoute, error) {
			<-advanceGate.channel
			published.Store(true)
			return kernel.RepeatDone, nil
		})
	other := addStep(t, &builder, func(context.Context) error { close(otherSettled); return nil })
	outside := addStep(t, &builder, func(context.Context) error {
		if !published.Load() {
			return errors.New("external join used an occurrence-local exit")
		}
		close(outsideStarted)
		return nil
	})
	depend(t, &builder, boundary.Enter, start)
	depend(t, &builder, other, start)
	depend(t, &builder, outside, boundary.Done, other)
	invocation := compileProgram(t, &builder, start, 20).Start(context.Background())
	await(t, bodyExited)
	await(t, otherSettled)
	notSignaled(t, outsideStarted, "repeat exit satisfied the external barrier before done")
	advanceGate.release()
	finishInvocation(t, invocation, nil)
	await(t, outsideStarted)
}

func TestSchedulerSequentialRepeatBlocksUseFinalCompletion(t *testing.T) {
	var builder kernel.Builder
	var firstBody, secondBody atomic.Int32
	first := addStep(t, &builder, func(context.Context) error { firstBody.Add(1); return nil })
	firstBoundary := repeatSteps(t, &builder, first, first, chooseBody,
		func(context.Context) (kernel.BoundaryRoute, error) {
			if firstBody.Load() == 2 {
				return kernel.RepeatDone, nil
			}
			return kernel.RepeatBody, nil
		})
	second := addStep(t, &builder, func(context.Context) error { secondBody.Add(1); return nil })
	secondBoundary := repeatSteps(t, &builder, second, second,
		func(context.Context) (kernel.BoundaryRoute, error) {
			if firstBody.Load() != 2 {
				return 0, errors.New("second block entered before first block finished")
			}
			return kernel.RepeatBody, nil
		}, chooseDone)
	depend(t, &builder, secondBoundary.Enter, firstBoundary.Done)
	finishInvocation(t, compileProgram(t, &builder, firstBoundary.Enter, 30).Start(context.Background()), nil)
	if firstBody.Load() != 2 || secondBody.Load() != 1 {
		t.Fatalf("body calls = %d and %d; want 2 and 1", firstBody.Load(), secondBody.Load())
	}
}

func TestSchedulerUnresolvedBoundaryDoesNotDispatchBody(t *testing.T) {
	var builder kernel.Builder
	var bodyCalls atomic.Int32
	body := addStep(t, &builder, func(context.Context) error { bodyCalls.Add(1); return nil })
	boundary := repeatSteps(t, &builder, body, body,
		func(context.Context) (kernel.BoundaryRoute, error) { return 0, nil }, chooseDone)
	finishInvocation(t, compileProgram(t, &builder, boundary.Enter, 10).Start(context.Background()), kernel.ErrBoundaryUnresolved)
	if bodyCalls.Load() != 0 {
		t.Fatal("unresolved boundary dispatched its body")
	}
}

func TestSchedulerRepeatStorageIsIndependentOfSuperstepBudget(t *testing.T) {
	var builder kernel.Builder
	var calls atomic.Int32
	body := addStep(t, &builder, func(context.Context) error { calls.Add(1); return nil })
	boundary := repeatSteps(t, &builder, body, body, chooseBody,
		func(context.Context) (kernel.BoundaryRoute, error) {
			if calls.Load() == 1000 {
				return kernel.RepeatDone, nil
			}
			return kernel.RepeatBody, nil
		})
	program := compileProgram(t, &builder, boundary.Enter, 2147483647)
	if steps, barriers := program.Size(); steps != 4 || barriers != 1 {
		t.Fatalf("repeat layout size = %d, %d; want four static steps and one barrier", steps, barriers)
	}
	finishInvocation(t, program.Start(context.Background()), nil)
	if calls.Load() != 1000 {
		t.Fatalf("body calls = %d; want 1000", calls.Load())
	}
}

func TestSchedulerHonorsTheExplicitSuperstepBudget(t *testing.T) {
	var builder kernel.Builder
	var calls atomic.Int32
	body := addStep(t, &builder, func(context.Context) error { calls.Add(1); return nil })
	boundary := repeatSteps(t, &builder, body, body, chooseBody, chooseBody)
	finishInvocation(t, compileProgram(t, &builder, boundary.Enter, 4).Start(context.Background()), kernel.ErrRecursionLimit)
	if calls.Load() != 2 {
		t.Fatalf("body calls = %d; want 2 before the explicit budget is exhausted", calls.Load())
	}
}

func TestSchedulerDoesNotAcquireCapacityAroundWrappers(t *testing.T) {
	limiter := newLimiter(t, 1, 0)
	var builder kernel.Builder
	var observed atomic.Int32
	step := addStep(t, &builder, func(ctx context.Context) error {
		return limiter.Run(ctx, func() error { observed.Add(1); return nil }, nil)
	})
	finishInvocation(t, compileProgram(t, &builder, step, 3).Start(context.Background()), nil)
	if observed.Load() != 1 {
		t.Fatalf("native callback count = %d; want 1 through the callback-owned limiter", observed.Load())
	}
}

func TestSchedulerAllowsResolvedSettlementWhileCapacityIsOccupied(t *testing.T) {
	limiter := newLimiter(t, 1, 0)
	activeGate := newGate(t)
	activeStarted := make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	var builder kernel.Builder
	var settled atomic.Int32
	step := addStep(t, &builder, func(context.Context) error {
		// The completed-slot adapter returns its SQL/cleanup-only resolution here;
		// the scheduler must not add a native-capacity acquisition around it.
		settled.Add(1)
		return nil
	})
	finishInvocation(t, compileProgram(t, &builder, step, 3).Start(context.Background()), nil)
	if settled.Load() != 1 {
		t.Fatalf("resolved settlement count = %d; want 1", settled.Load())
	}
	activeGate.release()
	noError(t, active)
}

func TestSchedulerCancellationWithdrawsQueuedNativeWork(t *testing.T) {
	limiter := newLimiter(t, 1, 1)
	activeGate := newGate(t)
	activeStarted := make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	ctx, cancel := context.WithCancelCause(context.Background())
	t.Cleanup(func() { cancel(context.Canceled) })
	wait := newObservation()
	var builder kernel.Builder
	var nativeCalls atomic.Int32
	step := addStep(t, &builder, func(ctx context.Context) error {
		return limiter.Run(ctx, func() error { nativeCalls.Add(1); return nil }, wait.scope())
	})
	invocation := compileProgram(t, &builder, step, 3).Start(ctx)
	await(t, wait.queued)
	cause := errors.New("owner stopped this invocation")
	cancel(cause)
	finishInvocation(t, invocation, cause)
	await(t, wait.finished)
	if nativeCalls.Load() != 0 {
		t.Fatal("canceled queued native work launched")
	}
	activeGate.release()
	noError(t, active)
}

func TestSchedulerCancellationReturnsBeforeUnresponsiveWrapperDrains(t *testing.T) {
	limiter := newLimiter(t, 1, 0)
	gate := newGate(t)
	started := make(chan struct{})
	ctx, cancel := context.WithCancelCause(context.Background())
	t.Cleanup(func() { cancel(context.Canceled) })
	var builder kernel.Builder
	var successorCalls atomic.Int32
	step := addStep(t, &builder, func(ctx context.Context) error {
		return limiter.Run(ctx, func() error {
			close(started)
			<-gate.channel
			return nil
		}, nil)
	})
	successor := addStep(t, &builder, func(context.Context) error { successorCalls.Add(1); return nil })
	depend(t, &builder, successor, step)
	invocation := compileProgram(t, &builder, step, 5).Start(ctx)
	await(t, started)
	cause := errors.New("stop while native iterator is still returning")
	cancel(cause)
	if err := await(t, waitInvocation(invocation)); !errors.Is(err, cause) {
		t.Fatalf("Wait error = %v; want original cancellation cause", err)
	}
	drainCtx, stopDrain := context.WithCancelCause(context.Background())
	drainCause := errors.New("existing cleanup deadline expired")
	stopDrain(drainCause)
	if err := invocation.Drain(drainCtx); !errors.Is(err, drainCause) {
		t.Fatalf("Drain returned %v while callback was still active", err)
	}
	if err := limiter.Run(context.Background(), noNativeWork, nil); !errors.Is(err, kernel.ErrAdmissionFull) {
		t.Fatalf("cancellation freed an undrained native slot: %v", err)
	}
	gate.release()
	drainInvocation(t, invocation)
	// A completed drain stays observable after this cleanup observer canceled.
	for read := 0; read < 64; read++ {
		if err := invocation.Drain(drainCtx); err != nil {
			t.Fatalf("completed drain changed to observer cancellation on read %d: %v", read+1, err)
		}
	}
	if successorCalls.Load() != 0 {
		t.Fatal("canceled invocation dispatched its successor after callback drain")
	}
	if err := limiter.Run(context.Background(), noNativeWork, nil); err != nil {
		t.Fatalf("native slot not released after actual drain: %v", err)
	}
}

func TestSchedulerFailureRetainsSiblingUntilCallerControlsCleanup(t *testing.T) {
	var builder kernel.Builder
	gate := newGate(t)
	siblingStarted, siblingCanceled := make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithCancelCause(context.Background())
	t.Cleanup(func() { cancel(context.Canceled) })
	failure := errors.New("exact store read failed")
	start := addStep(t, &builder, noWork)
	failed := addStep(t, &builder, func(context.Context) error { <-siblingStarted; return failure })
	sibling := addStep(t, &builder, func(ctx context.Context) error {
		close(siblingStarted)
		<-ctx.Done()
		close(siblingCanceled)
		<-gate.channel
		return context.Cause(ctx)
	})
	depend(t, &builder, failed, start)
	depend(t, &builder, sibling, start)
	invocation := compileProgram(t, &builder, start, 5).Start(ctx)
	if err := await(t, waitInvocation(invocation)); !errors.Is(err, failure) {
		t.Fatalf("Wait error = %v; want original wrapper failure", err)
	}
	if context.Cause(ctx) != nil {
		t.Fatal("scheduler invented cancellation before owner failure classification")
	}
	notSignaled(t, siblingCanceled, "healthy sibling canceled by kernel error policy")
	cancel(errors.New("owner requested cleanup after failure classification"))
	await(t, siblingCanceled)
	gate.release()
	drainInvocation(t, invocation)
}

func TestSchedulerInitialCancellationHasNoWrapperSideEffects(t *testing.T) {
	var builder kernel.Builder
	var calls atomic.Int32
	step := addStep(t, &builder, func(context.Context) error { calls.Add(1); return nil })
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("canceled before invocation")
	cancel(cause)
	finishInvocation(t, compileProgram(t, &builder, step, 3).Start(ctx), cause)
	if calls.Load() != 0 {
		t.Fatal("canceled invocation called a wrapper")
	}
}

func noNativeWork() error { return nil }

func waitInvocation(invocation *kernel.Invocation) <-chan error {
	result := make(chan error, 1)
	go func() { result <- invocation.Wait() }()
	return result
}

func finishInvocation(t *testing.T, invocation *kernel.Invocation, want error) {
	t.Helper()
	if err := await(t, waitInvocation(invocation)); !errors.Is(err, want) {
		t.Fatalf("invocation error = %v; want %v", err, want)
	}
	drainInvocation(t, invocation)
}

func drainInvocation(t *testing.T, invocation *kernel.Invocation) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := invocation.Drain(ctx); err != nil {
		t.Fatalf("wrapper drain failed: %v", err)
	}
}
