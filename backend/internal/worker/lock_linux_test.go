package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/worker"
)

func acquireLock(t *testing.T, state string, status worker.StatusProvider) *worker.WorkerLock {
	t.Helper()
	lock, err := worker.AcquireWorkerLock(state, status)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := lock.Close(); err != nil {
			t.Errorf("release worker lock: %v", err)
		}
	})
	return lock
}

func TestWorkerLockExcludesCanonicalStateAliasesAndReleases(t *testing.T) {
	parent := t.TempDir()
	state := filepath.Join(parent, "state")
	if _, err := worker.PrepareStateDirectory(state); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "parent-alias")
	if err := os.Symlink(parent, alias); err != nil {
		t.Fatal(err)
	}
	lock := acquireLock(t, state, nil)
	if err := lock.AssertOwned(); err != nil {
		t.Fatal(err)
	}
	for _, selected := range []string{state, filepath.Join(alias, "state")} {
		other, err := worker.AcquireWorkerLock(selected, nil)
		if other != nil {
			_ = other.Close()
			t.Fatal("second worker acquired the same canonical state")
		}
		requireWorkerError(t, err, "worker_already_running")
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	requireWorkerError(t, lock.AssertOwned(), "worker_ownership_lost")
	acquireLock(t, filepath.Join(alias, "state"), nil)
}

func TestWorkerLockSeparateStatesCanRunIndependently(t *testing.T) {
	first := acquireLock(t, t.TempDir(), nil)
	second := acquireLock(t, t.TempDir(), nil)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := second.AssertOwned(); err != nil {
		t.Fatalf("closing another state lost ownership: %v", err)
	}
}

func TestWorkerLockRejectsUnacquiredOwnership(t *testing.T) {
	var absent *worker.WorkerLock
	var empty worker.WorkerLock
	for _, lock := range []*worker.WorkerLock{absent, &empty} {
		requireWorkerError(t, lock.AssertOwned(), "worker_ownership_lost")
		requireWorkerError(t, lock.Close(), "worker_ownership_lost")
	}
}

func TestWorkerStatusReturnsCurrentPublicPayloadAndDoesNotCreateState(t *testing.T) {
	state := t.TempDir()
	var mu sync.Mutex
	current := json.RawMessage(`{"active":true,"phase":"connecting","failure":null}`)
	lock := acquireLock(t, state, func() json.RawMessage {
		mu.Lock()
		defer mu.Unlock()
		return append(json.RawMessage(nil), current...)
	})
	read := func(want string) {
		t.Helper()
		got, err := worker.ReadWorkerStatus(context.Background(), state)
		if err != nil || string(got) != want {
			t.Fatalf("status=%s error=%v; want %s", got, err, want)
		}
	}
	read(string(current))
	mu.Lock()
	current = json.RawMessage(`{"active":true,"phase":"ready","failure":null}`)
	mu.Unlock()
	read(string(current))
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if got, err := worker.ReadWorkerStatus(context.Background(), state); err != nil || got != nil {
		t.Fatalf("stopped worker status=%s error=%v", got, err)
	}
	missing := filepath.Join(state, "not-created")
	if got, err := worker.ReadWorkerStatus(context.Background(), missing); err != nil || got != nil {
		t.Fatalf("missing worker status=%s error=%v", got, err)
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("status inspection created state: %v", err)
	}
}

func TestWorkerStatusRejectsInvalidAndOversizedRepliesWithoutLosingLock(t *testing.T) {
	for _, test := range []struct {
		name    string
		payload string
		code    string
	}{
		{"malformed", `{`, "worker_status_invalid"},
		{"null", `null`, "worker_status_invalid"},
		{"array", `[]`, "worker_status_invalid"},
		{"inactive", `{"active":false}`, "worker_status_invalid"},
		{"string-active", `{"active":"true"}`, "worker_status_invalid"},
		{"missing-active", `{}`, "worker_status_invalid"},
		{"oversized", `{"active":true,"details":"` + strings.Repeat("x", 2048) + `"}`, "worker_status_oversized"},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := t.TempDir()
			lock := acquireLock(t, state, func() json.RawMessage { return json.RawMessage(test.payload) })
			_, err := worker.ReadWorkerStatus(context.Background(), state)
			requireWorkerError(t, err, test.code)
			if err := lock.AssertOwned(); err != nil {
				t.Fatalf("status inspection lost ownership: %v", err)
			}
		})
	}
}

func TestWorkerStatusAcceptsExactByteLimit(t *testing.T) {
	state := t.TempDir()
	prefix, suffix := `{"active":true,"details":"`, `"}`
	value := prefix + strings.Repeat("x", 2048-len(prefix)-len(suffix)) + suffix
	acquireLock(t, state, func() json.RawMessage { return json.RawMessage(value) })
	got, err := worker.ReadWorkerStatus(context.Background(), state)
	if err != nil || string(got) != value {
		t.Fatalf("bounded status length=%d error=%v", len(got), err)
	}
}

func TestWorkerStatusHonorsCancelledCaller(t *testing.T) {
	state := t.TempDir()
	lock := acquireLock(t, state, nil)
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("inspection is cancelled")
	cancel(cause)
	if _, err := worker.ReadWorkerStatus(ctx, state); !errors.Is(err, cause) {
		t.Fatalf("inspection cancellation=%v", err)
	}
	if err := lock.AssertOwned(); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerStatusRequiresExplicitAbsoluteState(t *testing.T) {
	for _, state := range []string{"", "relative-state"} {
		_, err := worker.ReadWorkerStatus(context.Background(), state)
		requireWorkerError(t, err, "private_directory_required")
	}
}
