//go:build linux

package sources_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/sources"
)

func TestGitProcessCancellationStopsDescendants(t *testing.T) {
	root, environment := gitFixture(t, "sleep 20 & printf ready > \"$1\"; wait")
	ready := filepath.Join(root, "started")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	deadline := 5 * time.Second
	results := make(chan sources.GitProcessResult, 1)
	start := time.Now()
	go func() {
		results <- sources.RunGitProcess(ctx, []string{ready}, sources.GitProcessOptions{Timeout: &deadline}, environment)
	}()
	waitForGitFixture(t, ready, start.Add(3*time.Second))
	cancel()
	select {
	case result := <-results:
		if result.Code != 1 || result.Interrupted == nil || result.Interrupted.StartedAt < start.UnixMilli() {
			t.Fatalf("cancellation lost interruption provenance: %+v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation left a Git descendant holding the output pipes")
	}
}

func TestGitProcessDeadlineStopsTermIgnoringDescendants(t *testing.T) {
	_, environment := gitFixture(t, "trap '' TERM; sleep 20 & wait")
	deadline := 150 * time.Millisecond
	start := time.Now()
	result := sources.RunGitProcess(context.Background(), nil, sources.GitProcessOptions{Timeout: &deadline}, environment)
	if result.Code != 124 && result.Code != 137 {
		t.Fatalf("deadline did not retain timeout's exit status: %+v", result)
	}
	if result.Interrupted == nil || result.Interrupted.StartedAt < start.UnixMilli() {
		t.Fatalf("deadline interruption provenance missing: %+v", result)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("term-ignoring Git descendant survived the deadline")
	}
}

func TestGitProcessPreCanceledContextIsInterrupted(t *testing.T) {
	_, environment := gitFixture(t, "sleep 20")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	deadline := time.Second
	result := sources.RunGitProcess(ctx, nil, sources.GitProcessOptions{Timeout: &deadline}, environment)
	if result.Code != 1 || result.Interrupted == nil {
		t.Fatalf("pre-canceled operation lost its interruption: %+v", result)
	}
}

func TestGitProcessNormalExitReleasesDescendantLocks(t *testing.T) {
	root, environment := gitFixture(t, "sleep 20 & exit 0")
	file, err := os.CreateTemp(root, "inherited-lock-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	deadline := time.Second
	result := sources.RunGitProcess(context.Background(), nil, sources.GitProcessOptions{Timeout: &deadline, LockFile: file}, environment)
	if result.Code != 0 || result.Interrupted != nil {
		t.Fatalf("normal Git exit failed: %+v", result)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	assertGitLockReleased(t, file.Name(), time.Now().Add(time.Second))
}

const gitDeadlineHelper = "FOREMAN_SOURCE_GIT_DEADLINE_HELPER"

func TestMain(tests *testing.M) {
	if root := os.Getenv(gitDeadlineHelper); root != "" {
		os.Exit(runGitDeadlineHelper(root))
	}
	os.Exit(tests.Run())
}

// This isolated helper models an API process exiting after it starts Git. The
// outer behavior test observes the inherited lock without terminating a worker
// or a real application process.
func runGitDeadlineHelper(root string) int {
	file, err := os.OpenFile(filepath.Join(root, "deadline-lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	environment := map[string]string{"PATH": filepath.Join(root, "bin") + ":/usr/bin:/bin", "HOME": root}
	deadline := 2 * time.Second
	go sources.RunGitProcess(context.Background(), []string{filepath.Join(root, "deadline-started")},
		sources.GitProcessOptions{Timeout: &deadline, LockFile: file}, environment)
	until := time.Now().Add(time.Second)
	for time.Now().Before(until) {
		if _, err := os.Stat(filepath.Join(root, "deadline-started")); err == nil {
			return 0
		} else if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		time.Sleep(10 * time.Millisecond)
	}
	fmt.Fprintln(os.Stderr, "Git helper did not start")
	return 2
}

func TestGitProcessDeadlineSurvivesCallerExit(t *testing.T) {
	root, environment := gitFixture(t, "printf ready > \"$1\"; sleep 20 & wait")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	caller := exec.Command(executable)
	for key, value := range environment {
		caller.Env = append(caller.Env, key+"="+value)
	}
	caller.Env = append(caller.Env, gitDeadlineHelper+"="+root)
	if output, err := caller.CombinedOutput(); err != nil {
		t.Fatalf("isolated caller failed: %v: %s", err, output)
	}
	file, err := os.OpenFile(filepath.Join(root, "deadline-lock"), os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatalf("Git did not retain the caller's inherited lock: %v", err)
	}
	assertGitLockReleased(t, file.Name(), time.Now().Add(4*time.Second))
}

func assertGitLockReleased(t *testing.T, name string, deadline time.Time) {
	t.Helper()
	file, err := os.OpenFile(name, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for time.Now().Before(deadline) {
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("a Git descendant retained an inherited lock after the supervisor ended")
}

func TestGitProcessUsesSystemGitObjectIdentity(t *testing.T) {
	root := t.TempDir()
	environment := map[string]string{
		"PATH": "/usr/bin:/bin", "HOME": root, "XDG_CONFIG_HOME": root,
		"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
	}
	file := filepath.Join(root, "approved-bytes")
	if err := os.WriteFile(file, []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := sources.RunGitProcess(context.Background(), []string{"hash-object", "--no-filters", "--", file},
		sources.GitProcessOptions{Cwd: root}, environment)
	if result.Code != 0 || strings.TrimSpace(result.Stdout) != "ce013625030ba8dba906f756967f9e9ca394464a" {
		t.Fatalf("system Git changed the public blob identity: %+v", result)
	}
}
