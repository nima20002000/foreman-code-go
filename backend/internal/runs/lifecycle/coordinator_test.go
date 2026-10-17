package lifecycle_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/lifecycle"
)

func TestStartJoinsActiveDriveAndRetainsItsResult(t *testing.T) {
	entered := make(chan string, 4)
	release := gate(t)
	failure := errors.New("the original drive failed")
	var calls atomic.Int32
	c := coordinator(t, func(_ context.Context, runID string) error {
		calls.Add(1)
		entered <- runID
		<-release
		return failure
	}, nil, 0)
	first := mustStart(t, c, "run-a")
	if runID := receive(t, entered); runID != "run-a" {
		t.Fatalf("drive received %q", runID)
	}
	second := mustStart(t, c, "run-a")
	third := mustStart(t, c, "run-a")
	close(release)
	for _, task := range []*lifecycle.Task{first, second, third} {
		if err := waitTask(t, task); !errors.Is(err, failure) {
			t.Fatalf("joined result = %v; want original drive error", err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("drive calls = %d; want 1", got)
	}
}

func TestActiveRunLimitReleasesCapacityAfterCompletion(t *testing.T) {
	entered := make(chan string, 2)
	release := gate(t)
	c := coordinator(t, func(_ context.Context, runID string) error {
		entered <- runID
		<-release
		return nil
	}, nil, 1)
	first := mustStart(t, c, "run-a")
	receive(t, entered)
	if _, err := c.Start("run-b"); err == nil {
		t.Fatal("a distinct Run exceeded active capacity")
	} else {
		errorCode(t, err, "RUNNER_ADMISSION_FULL")
	}
	joined := mustStart(t, c, "run-a")
	close(release)
	for _, task := range []*lifecycle.Task{first, joined} {
		if err := waitTask(t, task); err != nil {
			t.Fatal(err)
		}
	}
	second := mustStart(t, c, "run-b")
	if runID := receive(t, entered); runID != "run-b" {
		t.Fatalf("replacement drive received %q", runID)
	}
	if err := waitTask(t, second); err != nil {
		t.Fatal(err)
	}
}

func TestResumesQueueAfterFailureAndStartJoinsLatestResume(t *testing.T) {
	entered := make(chan int32, 4)
	releases := []chan struct{}{gate(t), gate(t), gate(t)}
	firstFailure := errors.New("first drive failure")
	lastFailure := errors.New("last drive failure")
	var calls atomic.Int32
	c := coordinator(t, func(context.Context, string) error {
		call := calls.Add(1)
		entered <- call
		if call < 1 || call > int32(len(releases)) {
			return errors.New("unexpected extra drive")
		}
		<-releases[call-1]
		if call == 1 {
			return firstFailure
		}
		if call == 3 {
			return lastFailure
		}
		return nil
	}, nil, 1)
	first := mustStart(t, c, "run-a")
	if got := receive(t, entered); got != 1 {
		t.Fatalf("first drive = %d", got)
	}
	second := mustResume(t, c, "run-a")
	third := mustResume(t, c, "run-a")
	joined := mustStart(t, c, "run-a")
	if calls.Load() != 1 {
		t.Fatal("a queued resume ran alongside the active drive")
	}
	close(releases[0])
	if got := receive(t, entered); got != 2 {
		t.Fatalf("next drive = %d; want 2", got)
	}
	if err := waitTask(t, first); !errors.Is(err, firstFailure) {
		t.Fatalf("first result = %v", err)
	}
	pending(t, third.Done())
	pending(t, joined.Done())
	close(releases[1])
	if got := receive(t, entered); got != 3 {
		t.Fatalf("last drive = %d; want 3", got)
	}
	if err := waitTask(t, second); err != nil {
		t.Fatalf("earlier failure poisoned resume: %v", err)
	}
	pending(t, joined.Done())
	close(releases[2])
	for _, task := range []*lifecycle.Task{third, joined} {
		if err := waitTask(t, task); !errors.Is(err, lastFailure) {
			t.Fatalf("latest joined result = %v", err)
		}
	}
	if calls.Load() != 3 {
		t.Fatalf("drive calls = %d; want 3", calls.Load())
	}
}

func TestCanceledTaskWaitDoesNotCancelOwnedDrive(t *testing.T) {
	entered := make(chan context.Context, 1)
	release := gate(t)
	c := coordinator(t, func(ctx context.Context, _ string) error {
		entered <- ctx
		<-release
		return nil
	}, nil, 0)
	task := mustStart(t, c, "run-a")
	driveContext := receive(t, entered)
	ctx, cancel := context.WithCancelCause(context.Background())
	waitFailure := errors.New("caller stopped waiting")
	cancel(waitFailure)
	if err := task.Wait(ctx); !errors.Is(err, waitFailure) {
		t.Fatalf("wait cancellation = %v", err)
	}
	pending(t, driveContext.Done())
	joined := mustStart(t, c, "run-a")
	close(release)
	for _, waiting := range []*lifecycle.Task{task, joined} {
		if err := waitTask(t, waiting); err != nil {
			t.Fatal(err)
		}
	}
	pending(t, driveContext.Done())
}

func TestClosingAdmissionRetainsTrackedResultsWithoutCancelingDrive(t *testing.T) {
	entered := make(chan context.Context, 1)
	release := gate(t)
	c := coordinator(t, func(ctx context.Context, _ string) error {
		entered <- ctx
		<-release
		return nil
	}, nil, 0)
	first := mustStart(t, c, "run-a")
	driveContext := receive(t, entered)
	queued := mustResume(t, c, "run-a")
	c.CloseAdmission()
	if c.AcceptsCurrentWork() {
		t.Fatal("closed admission reported that it accepts new work")
	}
	joined := mustStart(t, c, "run-a")
	_, err := c.Start("run-b")
	errorCode(t, err, "ENGINE_CLOSING")
	_, err = c.Resume("run-a")
	errorCode(t, err, "ENGINE_CLOSING")
	pending(t, driveContext.Done())
	close(release)
	if err := waitTask(t, first); err != nil {
		t.Fatal(err)
	}
	errorCode(t, waitTask(t, queued), "ENGINE_CLOSING")
	errorCode(t, waitTask(t, joined), "ENGINE_CLOSING")
}

func TestCoordinatorRequiresDriveAndStopPorts(t *testing.T) {
	drive := func(context.Context, string) error { return nil }
	stops := stopPortFunc(func(context.Context, string) (lifecycle.StopWork, error) {
		return nil, errors.New("not called")
	})
	for _, test := range []struct {
		name  string
		drive lifecycle.Drive
		stops lifecycle.StopPort
		limit int
	}{
		{name: "missing drive", stops: stops},
		{name: "missing Stop", drive: drive},
		{name: "negative capacity", drive: drive, stops: stops, limit: -1},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := lifecycle.New(test.drive, test.stops, test.limit); err == nil {
				t.Fatal("invalid lifecycle composition was accepted")
			}
		})
	}
}
