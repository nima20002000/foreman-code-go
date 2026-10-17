package kernel_test

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/kernel"
)

func TestExecutionLimiterRejectsInvalidCapacity(t *testing.T) {
	type capacityCase struct {
		name    string
		maximum int
		waiting int
		message string
	}
	cases := []capacityCase{
		{"zero_parallelism", 0, 1, "maxParallelism must be a positive integer."},
		{"negative_parallelism", -1, 1, "maxParallelism must be a positive integer."},
		{"negative_waiting", 1, -1, "The waiting capacity must be a nonnegative integer."},
	}
	if strconv.IntSize == 64 {
		unsafeInteger := int64(1 << 53)
		cases = append(cases,
			capacityCase{"unsafe_parallelism", int(unsafeInteger), 1, "maxParallelism must be a positive integer."},
			capacityCase{"unsafe_waiting", 1, int(unsafeInteger), "The waiting capacity must be a nonnegative integer."},
		)
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			limiter, err := kernel.NewExecutionLimiter(item.maximum, item.waiting)
			if limiter != nil || err == nil || err.Error() != item.message {
				t.Fatalf("got limiter %v and error %v; want %q", limiter, err, item.message)
			}
		})
	}
}

func TestExecutionLimiterSharesCapacityAcrossWorkKinds(t *testing.T) {
	limiter := newLimiter(t, 2, 1)
	agentGate, jobGate := newGate(t), newGate(t)
	agentStarted, jobStarted, waitingAgentStarted := make(chan struct{}), make(chan struct{}), make(chan struct{})
	agent := launch(limiter, context.Background(), func() error {
		close(agentStarted)
		<-agentGate.channel
		return nil
	}, nil)
	job := launch(limiter, context.Background(), func() error {
		close(jobStarted)
		<-jobGate.channel
		return nil
	}, nil)
	await(t, agentStarted)
	await(t, jobStarted)
	waitingAgentWait := newObservation()
	waitingAgent := launch(limiter, context.Background(), func() error {
		close(waitingAgentStarted)
		return nil
	}, waitingAgentWait.scope())
	awaitQueued(t, waitingAgentWait, waitingAgent)
	notSignaled(t, waitingAgentStarted, "waiting graph Agent work exceeded the shared capacity")
	agentGate.release()
	await(t, waitingAgentStarted)
	noError(t, waitingAgent)
	noError(t, agent)
	jobGate.release()
	noError(t, job)
}

func TestExecutionLimiterAdmitsFIFOIncludingNewArrivals(t *testing.T) {
	limiter := newLimiter(t, 1, 3)
	activeGate, firstGate, secondGate := newGate(t), newGate(t), newGate(t)
	activeStarted := make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	order := make(chan string, 3)
	firstWait, secondWait, lateWait := newObservation(), newObservation(), newObservation()
	first := launch(limiter, context.Background(), func() error {
		order <- "first"
		<-firstGate.channel
		return nil
	}, firstWait.scope())
	awaitQueued(t, firstWait, first)
	second := launch(limiter, context.Background(), func() error {
		order <- "second"
		<-secondGate.channel
		return nil
	}, secondWait.scope())
	awaitQueued(t, secondWait, second)
	activeGate.release()
	if got := await(t, order); got != "first" {
		t.Fatalf("first admission was %q", got)
	}
	late := launch(limiter, context.Background(), func() error {
		order <- "late"
		return nil
	}, lateWait.scope())
	awaitQueued(t, lateWait, late)
	firstGate.release()
	if got := await(t, order); got != "second" {
		t.Fatalf("second admission was %q", got)
	}
	secondGate.release()
	if got := await(t, order); got != "late" {
		t.Fatalf("last admission was %q", got)
	}
	for _, finished := range []<-chan error{active, first, second, late} {
		noError(t, finished)
	}
}

func TestExecutionLimiterReservesTransferredSlotUntilWaiterStarts(t *testing.T) {
	limiter := newLimiter(t, 1, 1)
	activeGate, observationGate, waitingWorkGate := newGate(t), newGate(t), newGate(t)
	activeStarted, waitingStarted, lateStarted := make(chan struct{}), make(chan struct{}), make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	wait := newObservation()
	waiting := launch(limiter, context.Background(), func() error {
		close(waitingStarted)
		<-waitingWorkGate.channel
		return nil
	}, func() func() {
		close(wait.queued)
		<-observationGate.channel
		return func() { close(wait.finished) }
	})
	awaitQueued(t, wait, waiting)
	activeGate.release()
	noError(t, active)
	lateWait := newObservation()
	late := launch(limiter, context.Background(), func() error {
		close(lateStarted)
		return nil
	}, lateWait.scope())
	awaitQueued(t, lateWait, late)
	notSignaled(t, lateStarted, "new work overtook a transferred slot")
	observationGate.release()
	await(t, waitingStarted)
	notSignaled(t, lateStarted, "new work exceeded the occupied slot")
	waitingWorkGate.release()
	noError(t, waiting)
	noError(t, late)
}

func TestExecutionLimiterCanceledWaitReleasesQueueCapacity(t *testing.T) {
	limiter := newLimiter(t, 1, 1)
	activeGate := newGate(t)
	activeStarted, canceledStarted := make(chan struct{}), make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	ctx, cancel := context.WithCancelCause(context.Background())
	t.Cleanup(func() { cancel(nil) })
	wait := newObservation()
	canceled := launch(limiter, ctx, func() error {
		close(canceledStarted)
		return nil
	}, wait.scope())
	awaitQueued(t, wait, canceled)
	cause := errors.New("workflow stopped while queued")
	cancel(cause)
	if got := await(t, canceled); got != cause {
		t.Fatalf("got cancellation %v; want original cause %v", got, cause)
	}
	await(t, wait.finished)
	notSignaled(t, canceledStarted, "canceled queued work ran")
	nextWait := newObservation()
	next := launch(limiter, context.Background(), func() error { return nil }, nextWait.scope())
	awaitQueued(t, nextWait, next)
	activeGate.release()
	noError(t, active)
	noError(t, next)
}

func TestExecutionLimiterCancellationAfterTransferDoesNotLaunchWork(t *testing.T) {
	limiter := newLimiter(t, 1, 1)
	activeGate, observationGate := newGate(t), newGate(t)
	activeStarted, canceledStarted := make(chan struct{}), make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	ctx, cancel := context.WithCancelCause(context.Background())
	t.Cleanup(func() { cancel(nil) })
	wait := newObservation()
	canceled := launch(limiter, ctx, func() error {
		close(canceledStarted)
		return nil
	}, func() func() {
		close(wait.queued)
		<-observationGate.channel
		return func() { close(wait.finished) }
	})
	awaitQueued(t, wait, canceled)
	activeGate.release()
	noError(t, active)
	nextWait := newObservation()
	next := launch(limiter, context.Background(), func() error { return nil }, nextWait.scope())
	awaitQueued(t, nextWait, next)
	cause := errors.New("stop won before native launch")
	cancel(cause)
	observationGate.release()
	if got := await(t, canceled); got != cause {
		t.Fatalf("got cancellation %v; want original cause %v", got, cause)
	}
	await(t, wait.finished)
	notSignaled(t, canceledStarted, "work launched after cancellation of its transferred slot")
	noError(t, next)
}

func TestExecutionLimiterRejectsOverflowWithoutPublishingWait(t *testing.T) {
	limiter := newLimiter(t, 1, 1)
	activeGate := newGate(t)
	activeStarted := make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	wait := newObservation()
	queued := launch(limiter, context.Background(), func() error { return nil }, wait.scope())
	awaitQueued(t, wait, queued)
	workCalled, waitPublished := false, false
	err := limiter.Run(context.Background(), func() error {
		workCalled = true
		return nil
	}, func() func() {
		waitPublished = true
		return nil
	})
	if !errors.Is(err, kernel.ErrAdmissionFull) || err.Error() != "RUNNER_ADMISSION_FULL" || workCalled || waitPublished {
		t.Fatalf("overflow: error=%v work=%v observation=%v", err, workCalled, waitPublished)
	}
	activeGate.release()
	noError(t, active)
	noError(t, queued)
}

func TestExecutionLimiterZeroWaitingCapacityStillAllowsAvailableWork(t *testing.T) {
	limiter := newLimiter(t, 1, 0)
	activeGate := newGate(t)
	activeStarted := make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	if err := limiter.Run(context.Background(), func() error {
		t.Error("overflow callback ran")
		return nil
	}, nil); !errors.Is(err, kernel.ErrAdmissionFull) {
		t.Fatalf("got %v; want admission-full error", err)
	}
	activeGate.release()
	noError(t, active)
	if err := limiter.Run(context.Background(), func() error { return nil }, nil); err != nil {
		t.Fatalf("available slot was rejected: %v", err)
	}
}

func TestExecutionLimiterRejectsInitialCancellationWithoutSideEffects(t *testing.T) {
	limiter := newLimiter(t, 1, 0)
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("canceled before admission")
	cancel(cause)
	workCalled, waitPublished := false, false
	err := limiter.Run(ctx, func() error {
		workCalled = true
		return nil
	}, func() func() {
		waitPublished = true
		return nil
	})
	if err != cause || workCalled || waitPublished {
		t.Fatalf("cancellation: error=%v work=%v observation=%v", err, workCalled, waitPublished)
	}
	if err := limiter.Run(context.Background(), func() error { return nil }, nil); err != nil {
		t.Fatalf("initial cancellation consumed capacity: %v", err)
	}
}

func TestExecutionLimiterRemovesWaitObservationBeforeWork(t *testing.T) {
	limiter := newLimiter(t, 1, 1)
	activeGate := newGate(t)
	activeStarted := make(chan struct{})
	active := launch(limiter, context.Background(), func() error {
		close(activeStarted)
		<-activeGate.channel
		return nil
	}, nil)
	await(t, activeStarted)
	wait := newObservation()
	sentinel := errors.New("original callback failure")
	queued := launch(limiter, context.Background(), func() error {
		select {
		case <-wait.finished:
			return sentinel
		default:
			return errors.New("queue reason was still published during work")
		}
	}, wait.scope())
	awaitQueued(t, wait, queued)
	activeGate.release()
	noError(t, active)
	if got := await(t, queued); got != sentinel {
		t.Fatalf("work returned %v; want original callback failure", got)
	}
	if err := limiter.Run(context.Background(), func() error { return nil }, func() func() {
		t.Error("available work published a wait")
		return nil
	}); err != nil {
		t.Fatalf("failed callback leaked a slot: %v", err)
	}
}

func TestExecutionLimiterKeepsRunningCapacityUntilCallbackReturns(t *testing.T) {
	limiter := newLimiter(t, 1, 0)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	started := make(chan struct{})
	callbackResult := errors.New("native callback drained")
	result := launch(limiter, ctx, func() error {
		close(started)
		<-ctx.Done()
		if err := limiter.Run(context.Background(), func() error {
			return errors.New("another native callback entered before drain")
		}, nil); !errors.Is(err, kernel.ErrAdmissionFull) {
			return errors.New("running cancellation released capacity before callback return")
		}
		return callbackResult
	}, nil)
	await(t, started)
	cancel()
	if got := await(t, result); got != callbackResult {
		t.Fatalf("running callback returned %v; want its original result", got)
	}
	if err := limiter.Run(context.Background(), func() error { return nil }, nil); err != nil {
		t.Fatalf("drained callback retained capacity: %v", err)
	}
}

func TestExecutionLimiterPanicReleasesCapacity(t *testing.T) {
	limiter := newLimiter(t, 1, 0)
	marker := errors.New("native callback panic")
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		_ = limiter.Run(context.Background(), func() error { panic(marker) }, nil)
	}()
	if recovered != marker {
		t.Fatalf("got panic %v; want original panic", recovered)
	}
	if err := limiter.Run(context.Background(), func() error { return nil }, nil); err != nil {
		t.Fatalf("panic leaked capacity: %v", err)
	}
}

func newLimiter(t *testing.T, maximum, waiting int) *kernel.ExecutionLimiter {
	t.Helper()
	limiter, err := kernel.NewExecutionLimiter(maximum, waiting)
	if err != nil {
		t.Fatal(err)
	}
	return limiter
}

func launch(limiter *kernel.ExecutionLimiter, ctx context.Context, work func() error, queued kernel.QueueWait) <-chan error {
	result := make(chan error, 1)
	go func() { result <- limiter.Run(ctx, work, queued) }()
	return result
}

type gate struct {
	channel chan struct{}
	release func()
}

func newGate(t *testing.T) gate {
	t.Helper()
	channel := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(channel) }) }
	t.Cleanup(release)
	return gate{channel: channel, release: release}
}

type observation struct {
	queued   chan struct{}
	finished chan struct{}
}

func newObservation() observation {
	return observation{queued: make(chan struct{}), finished: make(chan struct{})}
}

func (o observation) scope() kernel.QueueWait {
	return func() func() {
		close(o.queued)
		return func() { close(o.finished) }
	}
}

func await[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the controlled callback")
		var zero T
		return zero
	}
}

func awaitQueued(t *testing.T, wait observation, result <-chan error) {
	t.Helper()
	select {
	case <-wait.queued:
	case err := <-result:
		t.Fatalf("work returned before its expected capacity wait: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for capacity observation")
	}
}

func noError(t *testing.T, result <-chan error) {
	t.Helper()
	if err := await(t, result); err != nil {
		t.Fatal(err)
	}
}

func notSignaled(t *testing.T, channel <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-channel:
		t.Fatal(message)
	default:
	}
}
