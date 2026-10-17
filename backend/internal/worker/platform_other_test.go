//go:build !linux

package worker_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/worker"
)

func TestWorkerUnsupportedPlatformHasNoStateEffects(t *testing.T) {
	state := filepath.Join(t.TempDir(), "not-created")
	_, err := worker.PrepareStateDirectory(state)
	requireWorkerError(t, err, "worker_platform_unsupported")
	_, err = worker.RequirePrivateDirectory(state)
	requireWorkerError(t, err, "worker_platform_unsupported")
	_, err = worker.AcquireWorkerLock(state, nil)
	requireWorkerError(t, err, "worker_platform_unsupported")
	_, err = worker.ReadWorkerStatus(context.Background(), state)
	requireWorkerError(t, err, "worker_platform_unsupported")
	if _, err := os.Stat(state); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unsupported worker touched state: %v", err)
	}
}
