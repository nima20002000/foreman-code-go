package kernel_test

import (
	"context"
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/kernel"
)

func TestSchedulerCancellationAfterSuccessKeepsSettledOutcome(t *testing.T) {
	var builder kernel.Builder
	step := addStep(t, &builder, noWork)
	ctx, cancel := context.WithCancelCause(context.Background())
	t.Cleanup(func() { cancel(context.Canceled) })
	invocation := compileProgram(t, &builder, step, 3).Start(ctx)
	finishInvocation(t, invocation, nil)
	cancel(errors.New("owner canceled after successful invocation"))
	assertRepeatedOutcome(t, invocation, nil)
}

func TestSchedulerCancellationAfterFailureKeepsSettledOutcome(t *testing.T) {
	var builder kernel.Builder
	gate := newGate(t)
	siblingStarted := make(chan struct{})
	ctx, cancel := context.WithCancelCause(context.Background())
	t.Cleanup(func() { cancel(context.Canceled) })
	failure := errors.New("wrapper failed before owner cancellation")
	start := addStep(t, &builder, noWork)
	failed := addStep(t, &builder, func(context.Context) error {
		<-siblingStarted
		return failure
	})
	sibling := addStep(t, &builder, func(context.Context) error {
		close(siblingStarted)
		<-gate.channel
		return nil
	})
	depend(t, &builder, failed, start)
	depend(t, &builder, sibling, start)
	invocation := compileProgram(t, &builder, start, 5).Start(ctx)
	if err := await(t, waitInvocation(invocation)); !errors.Is(err, failure) {
		t.Fatalf("initial outcome = %v; want original wrapper failure", err)
	}
	cancel(errors.New("owner began cleanup after observing failure"))
	assertRepeatedOutcome(t, invocation, failure)
	gate.release()
	drainInvocation(t, invocation)
	assertRepeatedOutcome(t, invocation, failure)
}

func TestSchedulerCancellationOutcomeSurvivesCallbackDrain(t *testing.T) {
	var builder kernel.Builder
	gate := newGate(t)
	started := make(chan struct{})
	ctx, cancel := context.WithCancelCause(context.Background())
	t.Cleanup(func() { cancel(context.Canceled) })
	step := addStep(t, &builder, func(context.Context) error {
		close(started)
		<-gate.channel
		return errors.New("callback returned an error after cancellation settled")
	})
	invocation := compileProgram(t, &builder, step, 3).Start(ctx)
	await(t, started)
	cause := errors.New("original cancellation before callback drain")
	cancel(cause)
	if err := await(t, waitInvocation(invocation)); !errors.Is(err, cause) {
		t.Fatalf("initial outcome = %v; want original cancellation", err)
	}
	assertRepeatedOutcome(t, invocation, cause)
	gate.release()
	drainInvocation(t, invocation)
	assertRepeatedOutcome(t, invocation, cause)
}

func assertRepeatedOutcome(t *testing.T, invocation *kernel.Invocation, want error) {
	t.Helper()
	// Multiple readers must join the same settled invocation, even when its
	// original context has subsequently been canceled during owner cleanup.
	for read := 0; read < 64; read++ {
		if err := invocation.Wait(); !errors.Is(err, want) {
			t.Fatalf("settled outcome changed on read %d: got %v, want %v", read+1, err, want)
		}
	}
}
