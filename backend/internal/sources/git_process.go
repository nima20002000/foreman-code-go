//go:build linux

// Package sources contains the source acquisition boundaries.
package sources

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/text/encoding/unicode"
)

const gitOutputLimit = 4 * 1024 * 1024

// GitProcessOptions is the internal process port used by source Git operations.
// A nil Timeout uses fifteen minutes; an explicit zero retains GNU timeout's
// disabled-deadline meaning. Env overrides the non-interactive Git defaults.
type GitProcessOptions struct {
	Cwd              string
	Timeout          *time.Duration
	Env              map[string]string
	MaximumFileBytes *uint64
	LockFile         *os.File
	TransferLockFile *os.File
}

// GitProcessInterruption records when the interrupted operation was launched.
type GitProcessInterruption struct {
	StartedAt int64
}

// GitProcessResult keeps Git diagnostics private until a caller sanitizes them.
// Spawn errors, cancellation, and output overflow produce code 1. A deadline
// retains timeout's exit code (124 or 137) and records Interrupted.
type GitProcessResult struct {
	Code        int
	Stdout      string
	Stderr      string
	Interrupted *GitProcessInterruption
}

// RunGitProcess runs system Git with a private umask, bounded output, inherited
// lock files, and a supervisor that retains the deadline after the caller exits.
// The supplied environment is explicit; no ambient process values are added.
func RunGitProcess(ctx context.Context, args []string, options GitProcessOptions, environment map[string]string) GitProcessResult {
	file, childArgs := gitSupervisedCommand(args, options)
	command := exec.Command(file, childArgs...)
	command.Dir = options.Cwd
	command.Env = gitProcessEnvironment(environment, options.Env)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	for _, inherited := range []*os.File{options.LockFile, options.TransferLockFile} {
		if inherited != nil {
			command.ExtraFiles = append(command.ExtraFiles, inherited)
		}
	}
	var pid atomic.Int64
	var failed, finished atomic.Bool
	stop := func() {
		if finished.Load() {
			return
		}
		failed.Store(true)
		if childPID := pid.Load(); childPID != 0 {
			if err := syscall.Kill(-int(childPID), syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
				// The operation remains failed if signaling is denied. Its detached
				// supervisor still owns the original deadline and inherited locks.
				failed.Store(true)
			}
		}
	}
	stdout := &gitOutput{stop: stop}
	stderr := &gitOutput{stop: stop}
	command.Stdout, command.Stderr = stdout, stderr
	startedAt := time.Now().UnixMilli()
	if err := command.Start(); err != nil {
		return GitProcessResult{Code: 1}
	}
	pid.Store(int64(command.Process.Pid))
	if failed.Load() || ctx.Err() != nil {
		stop()
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			stop()
		case <-done:
		}
	}()
	waitError := command.Wait()
	finished.Store(true)
	close(done)
	result := GitProcessResult{Code: command.ProcessState.ExitCode()}
	if waitError != nil && result.Code < 0 {
		result.Code = 1
	}
	var stdoutError, stderrError error
	result.Stdout, stdoutError = stdout.text()
	result.Stderr, stderrError = stderr.text()
	interrupted := failed.Load() || ctx.Err() != nil
	if interrupted || stdoutError != nil || stderrError != nil {
		result.Code = 1
	}
	if interrupted || result.Code == 124 || result.Code == 137 {
		result.Interrupted = &GitProcessInterruption{StartedAt: startedAt}
	}
	return result
}

func gitSupervisedCommand(args []string, options GitProcessOptions) (string, []string) {
	command := append([]string{"/bin/sh", "-c", "umask 077 && exec git \"$@\"", "git"}, args...)
	if options.MaximumFileBytes != nil {
		limit := strconv.FormatUint(*options.MaximumFileBytes, 10)
		command = append([]string{"/usr/bin/prlimit", "--fsize=" + limit + ":" + limit, "--"}, command...)
	}
	timeout := 15 * time.Minute
	if options.Timeout != nil {
		timeout = *options.Timeout
	}
	seconds := strconv.FormatFloat(timeout.Seconds(), 'f', -1, 64) + "s"
	// timeout leads a separate process group. The detached shell kills that
	// whole group on expiry, cancellation, or normal completion, including any
	// descendants that still hold the cache or transfer lock descriptors.
	supervisor := "trap 'kill -KILL -$! $! 2>/dev/null; exit 143' TERM; " +
		"timeout --signal=TERM --kill-after=0.25s \"$@\" & wait $!; status=$?; " +
		"kill -KILL -$! 2>/dev/null; exit $status"
	return "/bin/sh", append([]string{"-c", supervisor, "deadline", seconds}, command...)
}

func gitProcessEnvironment(base, overrides map[string]string) []string {
	values := make(map[string]string, len(base)+len(overrides)+3)
	for key, value := range base {
		values[key] = value
	}
	values["GIT_TERMINAL_PROMPT"] = "0"
	values["GCM_INTERACTIVE"] = "never"
	values["GIT_NO_LAZY_FETCH"] = "1"
	for key, value := range overrides {
		values[key] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}

type gitOutput struct {
	mu    sync.Mutex
	bytes []byte
	size  uint64
	stop  func()
}

func (output *gitOutput) Write(chunk []byte) (int, error) {
	output.mu.Lock()
	output.size += uint64(len(chunk))
	overflow := output.size > gitOutputLimit
	if !overflow {
		output.bytes = append(output.bytes, chunk...)
	}
	output.mu.Unlock()
	if overflow {
		output.stop()
	}
	return len(chunk), nil
}

func (output *gitOutput) text() (string, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	// Match Node Buffer.toString('utf8'), including malformed byte replacement.
	decoded, err := unicode.UTF8.NewDecoder().Bytes(output.bytes)
	return string(decoded), err
}
