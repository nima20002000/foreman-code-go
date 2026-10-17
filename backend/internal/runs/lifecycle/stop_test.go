package lifecycle_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/runs/lifecycle"
)

func TestStopFenceFailureLeavesActiveDriveUnchanged(t *testing.T) {
	entered := make(chan context.Context, 1)
	release := gate(t)
	denied := domainerror.New("REPEAT_STOP_AUTHORIZATION_REQUIRED", "No committed Stop fence.", 409, nil)
	c := coordinator(t, func(ctx context.Context, _ string) error {
		entered <- ctx
		<-release
		return nil
	}, stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
		return nil, denied
	}), 0)
	active := mustStart(t, c, "run-a")
	driveContext := receive(t, entered)
	if task, err := c.Stop(context.Background(), "run-a"); task != nil || !errors.Is(err, denied) {
		t.Fatalf("unfenced Stop = (%v, %v)", task, err)
	}
	pending(t, driveContext.Done())
	close(release)
	if err := waitTask(t, active); err != nil {
		t.Fatal(err)
	}
}

func TestStopCancelsOnlyItsNamedRun(t *testing.T) {
	firstEntered := make(chan context.Context, 1)
	secondEntered := make(chan context.Context, 1)
	secondRelease := gate(t)
	c := coordinator(t, func(ctx context.Context, runID string) error {
		if runID == "run-a" {
			firstEntered <- ctx
			<-ctx.Done()
			return context.Cause(ctx)
		}
		secondEntered <- ctx
		<-secondRelease
		return nil
	}, stopPortFunc(func(_ context.Context, runID string) (lifecycle.StopWork, error) {
		if runID != "run-a" {
			return nil, errors.New("Stop selected a different Run")
		}
		return stopWork{
			close:  func(context.Context) error { return nil },
			settle: func(context.Context) (bool, error) { return true, nil },
		}, nil
	}), 2)
	first := mustStart(t, c, "run-a")
	second := mustStart(t, c, "run-b")
	firstContext := receive(t, firstEntered)
	secondContext := receive(t, secondEntered)
	stopping := mustStop(t, c, context.Background(), "run-a")
	errorCode(t, context.Cause(firstContext), "GRAPH_STOP_CONFLICT")
	pending(t, secondContext.Done())
	errorCode(t, waitTask(t, first), "GRAPH_STOP_CONFLICT")
	if stopped, err := waitStop(t, stopping); !stopped || err != nil {
		t.Fatalf("first Run Stop = (%v, %v)", stopped, err)
	}
	pending(t, second.Done())
	close(secondRelease)
	if err := waitTask(t, second); err != nil {
		t.Fatalf("unrelated Run result = %v", err)
	}
}

func TestStopCancelsBeforePreflightAndWaitsForDriveDrain(t *testing.T) {
	entered := make(chan context.Context, 1)
	preflight := gate(t)
	nativeEntered := make(chan struct{}, 1)
	nativeRelease := gate(t)
	var prepared, driveExited atomic.Bool
	c := coordinator(t, func(ctx context.Context, _ string) error {
		entered <- ctx
		<-preflight
		if !prepared.Load() || context.Cause(ctx) == nil {
			return errors.New("preflight continued before the committed Stop cancellation")
		}
		driveExited.Store(true)
		return context.Cause(ctx)
	}, stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
		prepared.Store(true)
		return stopWork{
			close: func(context.Context) error {
				nativeEntered <- struct{}{}
				<-nativeRelease
				return nil
			},
			settle: func(context.Context) (bool, error) {
				if !driveExited.Load() {
					return false, errors.New("settlement ran before the existing drive drained")
				}
				return true, nil
			},
		}, nil
	}), 0)
	active := mustStart(t, c, "run-a")
	driveContext := receive(t, entered)
	stopping := mustStop(t, c, context.Background(), "run-a")
	errorCode(t, context.Cause(driveContext), "GRAPH_STOP_CONFLICT")
	receive(t, nativeEntered)
	close(nativeRelease)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if stopped, err := stopping.Wait(ctx); stopped || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Stop completed before preflight drained: (%v, %v)", stopped, err)
	}
	close(preflight)
	errorCode(t, waitTask(t, active), "GRAPH_STOP_CONFLICT")
	if stopped, err := waitStop(t, stopping); !stopped || err != nil {
		t.Fatalf("settled Stop = (%v, %v)", stopped, err)
	}
}

func TestStopChecksEveryCallerBeforeJoiningCleanup(t *testing.T) {
	nativeEntered := make(chan struct{}, 2)
	nativeRelease := gate(t)
	var preparations, closes, settlements atomic.Int32
	work := stopWork{
		close: func(context.Context) error {
			closes.Add(1)
			nativeEntered <- struct{}{}
			<-nativeRelease
			return nil
		},
		settle: func(context.Context) (bool, error) {
			settlements.Add(1)
			// Native cancellation returned, but the existing Run owner is still
			// unavailable. This is not confirmed physical settlement.
			return false, nil
		},
	}
	c := coordinator(t, func(context.Context, string) error { return nil },
		stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
			preparations.Add(1)
			return work, nil
		}), 0)
	first := mustStop(t, c, context.Background(), "run-a")
	receive(t, nativeEntered)
	second := mustStop(t, c, context.Background(), "run-a")
	if preparations.Load() != 2 {
		t.Fatalf("Stop boundary checks = %d; want 2", preparations.Load())
	}
	close(nativeRelease)
	for _, task := range []*lifecycle.StopTask{first, second} {
		if stopped, err := waitStop(t, task); stopped || err != nil {
			t.Fatalf("unconfirmed settlement = (%v, %v)", stopped, err)
		}
	}
	if closes.Load() != 1 || settlements.Load() != 1 {
		t.Fatalf("native/settlement calls = %d/%d; want 1/1", closes.Load(), settlements.Load())
	}
}

func TestStopRejectsLaterUnfencedCallerWithoutDisturbingCleanup(t *testing.T) {
	nativeEntered := make(chan struct{}, 1)
	nativeRelease := gate(t)
	var preparations atomic.Int32
	denied := errors.New("the later caller no longer has Stop authority")
	c := coordinator(t, func(context.Context, string) error { return nil },
		stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
			if preparations.Add(1) == 2 {
				return nil, denied
			}
			return stopWork{
				close: func(context.Context) error {
					nativeEntered <- struct{}{}
					<-nativeRelease
					return nil
				},
				settle: func(context.Context) (bool, error) { return true, nil },
			}, nil
		}), 0)
	first := mustStop(t, c, context.Background(), "run-a")
	receive(t, nativeEntered)
	if task, err := c.Stop(context.Background(), "run-a"); task != nil || !errors.Is(err, denied) {
		t.Fatalf("later denied caller = (%v, %v)", task, err)
	}
	pending(t, first.Done())
	close(nativeRelease)
	if stopped, err := waitStop(t, first); !stopped || err != nil {
		t.Fatalf("original cleanup = (%v, %v)", stopped, err)
	}
}

func TestStopFailuresStillReachAuthoritativeSettlement(t *testing.T) {
	entered := make(chan struct{}, 1)
	driveFailure := errors.New("native drive ended with an error")
	closeFailure := errors.New("native close response was lost")
	settlementFailure := errors.New("physical closure remains unconfirmed")
	var settled atomic.Bool
	c := coordinator(t, func(ctx context.Context, _ string) error {
		entered <- struct{}{}
		<-ctx.Done()
		return driveFailure
	}, stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
		return stopWork{
			close: func(context.Context) error { return closeFailure },
			settle: func(context.Context) (bool, error) {
				settled.Store(true)
				return true, settlementFailure
			},
		}, nil
	}), 0)
	active := mustStart(t, c, "run-a")
	receive(t, entered)
	stopping := mustStop(t, c, context.Background(), "run-a")
	if err := waitTask(t, active); !errors.Is(err, driveFailure) {
		t.Fatalf("drive result = %v", err)
	}
	if stopped, err := waitStop(t, stopping); stopped || !errors.Is(err, settlementFailure) {
		t.Fatalf("settlement result = (%v, %v)", stopped, err)
	}
	if !settled.Load() {
		t.Fatal("an earlier failure bypassed the authoritative settlement operation")
	}
}

func TestCanceledStopWaitDoesNotAbandonCommittedCleanup(t *testing.T) {
	nativeEntered := make(chan context.Context, 1)
	nativeRelease := gate(t)
	c := coordinator(t, func(context.Context, string) error { return nil },
		stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
			return stopWork{
				close: func(ctx context.Context) error {
					nativeEntered <- ctx
					<-nativeRelease
					return nil
				},
				settle: func(context.Context) (bool, error) { return true, nil },
			}, nil
		}), 0)
	ctx, cancel := context.WithCancelCause(context.Background())
	task := mustStop(t, c, ctx, "run-a")
	cleanupContext := receive(t, nativeEntered)
	waitFailure := errors.New("caller stopped waiting")
	cancel(waitFailure)
	if stopped, err := task.Wait(ctx); stopped || !errors.Is(err, waitFailure) {
		t.Fatalf("canceled Stop wait = (%v, %v)", stopped, err)
	}
	pending(t, cleanupContext.Done())
	close(nativeRelease)
	if stopped, err := waitStop(t, task); !stopped || err != nil {
		t.Fatalf("retained cleanup result = (%v, %v)", stopped, err)
	}
}

func TestStopDrainsResumeAlreadyQueuedBehindActiveDrive(t *testing.T) {
	entered := make(chan int32, 2)
	resumeRelease := gate(t)
	var calls atomic.Int32
	var stopCommitted, resumeExited atomic.Bool
	fenced := domainerror.New("GRAPH_STOP_CONFLICT", "The durable Stop fence is present.", 409, nil)
	c := coordinator(t, func(ctx context.Context, _ string) error {
		call := calls.Add(1)
		entered <- call
		if call == 1 {
			<-ctx.Done()
			return context.Cause(ctx)
		}
		if !stopCommitted.Load() {
			return errors.New("queued resume did not read the committed Stop")
		}
		<-resumeRelease
		resumeExited.Store(true)
		return fenced
	}, stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
		stopCommitted.Store(true)
		return stopWork{
			close: func(context.Context) error { return nil },
			settle: func(context.Context) (bool, error) {
				if !resumeExited.Load() {
					return false, errors.New("settlement did not wait for queued resume")
				}
				return true, nil
			},
		}, nil
	}), 0)
	active := mustStart(t, c, "run-a")
	receive(t, entered)
	resumed := mustResume(t, c, "run-a")
	stopping := mustStop(t, c, context.Background(), "run-a")
	if got := receive(t, entered); got != 2 {
		t.Fatalf("queued drive = %d; want 2", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if stopped, err := stopping.Wait(ctx); stopped || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Stop returned before queued resume drained: (%v, %v)", stopped, err)
	}
	close(resumeRelease)
	errorCode(t, waitTask(t, active), "GRAPH_STOP_CONFLICT")
	errorCode(t, waitTask(t, resumed), "GRAPH_STOP_CONFLICT")
	if stopped, err := waitStop(t, stopping); !stopped || err != nil {
		t.Fatalf("drained Stop = (%v, %v)", stopped, err)
	}
}
