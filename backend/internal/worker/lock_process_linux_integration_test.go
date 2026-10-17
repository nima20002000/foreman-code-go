//go:build integration && linux

package worker_test

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/worker"
)

func TestWorkerLockExcludesAnotherProcessAndRecoversAfterExit(t *testing.T) {
	if os.Getenv("FOREMAN_WORKER_LOCK_TEST_CHILD") == "1" {
		workerLockChild(t)
		return
	}
	state := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestWorkerLockExcludesAnotherProcessAndRecoversAfterExit$", "-test.count=1", "-test.timeout=10s")
	command.Env = []string{
		"HOME=" + t.TempDir(),
		"TMPDIR=" + t.TempDir(),
		"FOREMAN_WORKER_LOCK_TEST_CHILD=1",
		"FOREMAN_WORKER_LOCK_TEST_STATE=" + state,
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	t.Cleanup(func() {
		_ = input.Close()
		if !waited {
			// Closing input lets this isolated child finish normally. Its test
			// deadline also bounds a child that never reaches the input read.
			_ = command.Wait()
		}
	})
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil || line != "owned\n" {
		t.Fatalf("child did not acquire isolated state: line=%q error=%v", line, err)
	}
	if other, err := worker.AcquireWorkerLock(state, nil); other != nil {
		_ = other.Close()
		t.Fatal("second process acquired the child's state")
	} else {
		requireWorkerError(t, err, "worker_already_running")
	}
	status, err := worker.ReadWorkerStatus(context.Background(), state)
	if err != nil || string(status) != `{"active":true}` {
		t.Fatalf("child status=%s error=%v", status, err)
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	err = command.Wait()
	waited = true
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 23 {
		t.Fatalf("child exit=%v stderr=%s", err, stderr.String())
	}
	// The child intentionally exited without closing its lock. A new owner
	// must acquire the same state without deleting any lock file or PID record.
	acquireLock(t, state, nil)
}

func workerLockChild(t *testing.T) {
	t.Helper()
	lock, err := worker.AcquireWorkerLock(os.Getenv("FOREMAN_WORKER_LOCK_TEST_STATE"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintln(os.Stdout, "owned"); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		t.Fatal(err)
	}
	if err := lock.AssertOwned(); err != nil {
		t.Fatal(err)
	}
	// A distinctive exit code proves the child reached the deliberate exit
	// without the normal Close path; no signal is sent to any other process.
	os.Exit(23)
}
