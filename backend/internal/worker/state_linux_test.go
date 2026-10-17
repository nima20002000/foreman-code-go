package worker_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/worker"
)

func TestPrivateStateDirectoryCreatesOnlyExplicitPrivateState(t *testing.T) {
	parent := t.TempDir()
	state := filepath.Join(parent, "new", "state")
	canonical, err := worker.PrepareStateDirectory(state)
	if err != nil || canonical != state {
		t.Fatalf("prepare state=%q error=%v", canonical, err)
	}
	info, err := os.Stat(state)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("created private state info=%v error=%v", info, err)
	}
	entries, err := os.ReadDir(state)
	if err != nil || len(entries) != 0 {
		t.Fatalf("preparation created identity or runtime state: entries=%v error=%v", entries, err)
	}
	if _, err := worker.PrepareStateDirectory("relative-state"); err == nil {
		t.Fatal("relative state accepted")
	} else {
		requireWorkerError(t, err, "private_directory_required")
	}
}

func TestPrivateStateDirectoryRejectsSymlinkFileAndSharedMode(t *testing.T) {
	parent := t.TempDir()
	state := filepath.Join(parent, "state")
	if err := os.Mkdir(state, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(parent, "alias")
	if err := os.Symlink(state, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.RequirePrivateDirectory(alias); err == nil {
		t.Fatal("symlink state accepted")
	} else {
		requireWorkerError(t, err, "private_directory_required")
	}
	if err := os.Chmod(state, 0o750); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.PrepareStateDirectory(state); err == nil {
		t.Fatal("shared state accepted")
	} else {
		requireWorkerError(t, err, "private_directory_required")
	}
	info, err := os.Stat(state)
	if err != nil || info.Mode().Perm() != 0o750 {
		t.Fatalf("existing directory permissions were changed: info=%v error=%v", info, err)
	}
	file := filepath.Join(parent, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.RequirePrivateDirectory(file); err == nil {
		t.Fatal("file accepted as state")
	} else {
		requireWorkerError(t, err, "private_directory_required")
	}
	if _, err := worker.RequirePrivateDirectory(filepath.Join(parent, "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing state error=%v", err)
	}
}
