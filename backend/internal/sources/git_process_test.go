//go:build linux

package sources_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/sources"
)

func gitFixture(t *testing.T, script string) (string, map[string]string) {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte("#!/bin/sh\n"+script+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return root, map[string]string{
		"PATH":              bin + ":/usr/bin:/bin",
		"HOME":              root,
		"TMPDIR":            root,
		"XDG_CONFIG_HOME":   root,
		"GIT_CONFIG_GLOBAL": "/dev/null",
		"GIT_CONFIG_SYSTEM": "/dev/null",
	}
}

func TestGitProcessReportsExitStatusAndStreams(t *testing.T) {
	root, environment := gitFixture(t, "printf 'git output'; printf 'private diagnostic' >&2; exit 7")
	result := sources.RunGitProcess(context.Background(), nil, sources.GitProcessOptions{Cwd: root}, environment)
	if result.Code != 7 || result.Stdout != "git output" || result.Stderr != "private diagnostic" || result.Interrupted != nil {
		t.Fatalf("unexpected process result: %+v", result)
	}
}

func TestGitProcessUsesLiteralArgumentsAndExplicitEnvironment(t *testing.T) {
	root, environment := gitFixture(t, "printf '%s\\n' \"$PWD\" \"$GIT_TERMINAL_PROMPT\" \"$GCM_INTERACTIVE\" \"$GIT_NO_LAZY_FETCH\" \"$SOURCE_VALUE\" \"$@\"")
	environment["GIT_TERMINAL_PROMPT"] = "1"
	environment["GCM_INTERACTIVE"] = "always"
	environment["GIT_NO_LAZY_FETCH"] = "0"
	argument := "$(printf unwanted execution); path with spaces"
	options := sources.GitProcessOptions{Cwd: root, Env: map[string]string{"SOURCE_VALUE": "explicit value"}}
	result := sources.RunGitProcess(context.Background(), []string{argument}, options, environment)
	expected := strings.Join([]string{root, "0", "never", "1", "explicit value", argument, ""}, "\n")
	if result.Code != 0 || result.Stdout != expected {
		t.Fatalf("literal arguments or environment changed: code=%d stdout=%q stderr=%q", result.Code, result.Stdout, result.Stderr)
	}
	options.Env["GIT_TERMINAL_PROMPT"] = "override"
	result = sources.RunGitProcess(context.Background(), nil, options, environment)
	if result.Code != 0 || !strings.Contains(result.Stdout, "\noverride\nnever\n1\n") {
		t.Fatalf("per-command environment did not override defaults: %+v", result)
	}
}

func TestGitProcessCreatesPrivateFiles(t *testing.T) {
	root, environment := gitFixture(t, ": > \"$1\"")
	file := filepath.Join(root, "new-object")
	result := sources.RunGitProcess(context.Background(), []string{file}, sources.GitProcessOptions{}, environment)
	if result.Code != 0 {
		t.Fatalf("Git fixture failed: %+v", result)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("new Git file permissions are %o, want 600", info.Mode().Perm())
	}
}

func TestGitProcessInheritsLockDescriptors(t *testing.T) {
	root, environment := gitFixture(t, "printf cache >&3; printf transfer >&4")
	cache, err := os.CreateTemp(root, "cache-lock-")
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	transfer, err := os.CreateTemp(root, "transfer-lock-")
	if err != nil {
		t.Fatal(err)
	}
	defer transfer.Close()
	result := sources.RunGitProcess(context.Background(), nil, sources.GitProcessOptions{LockFile: cache, TransferLockFile: transfer}, environment)
	if result.Code != 0 {
		t.Fatalf("inherited descriptor write failed: %+v", result)
	}
	for _, item := range []struct {
		file *os.File
		want string
	}{{cache, "cache"}, {transfer, "transfer"}} {
		data, err := os.ReadFile(item.file.Name())
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != item.want {
			t.Fatalf("inherited lock descriptor data=%q, want %q", data, item.want)
		}
	}
}

func TestGitProcessEnforcesFileSizeLimit(t *testing.T) {
	root, environment := gitFixture(t, "exec dd if=/dev/zero of=\"$1\" bs=4096 count=8")
	file := filepath.Join(root, "bounded-object")
	limit := uint64(4096)
	result := sources.RunGitProcess(context.Background(), []string{file}, sources.GitProcessOptions{MaximumFileBytes: &limit}, environment)
	if result.Code == 0 {
		t.Fatal("Git child wrote beyond its file limit without failing")
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > int64(limit) {
		t.Fatalf("file limit was exceeded: got %d bytes, limit %d", info.Size(), limit)
	}
}

func TestGitProcessBoundsEachOutputStream(t *testing.T) {
	for _, stream := range []string{"stdout", "stderr"} {
		t.Run(stream, func(t *testing.T) {
			redirect := ""
			if stream == "stderr" {
				redirect = " >&2"
			}
			_, environment := gitFixture(t, "head -c 4194305 /dev/zero"+redirect+"; sleep 20")
			timeout := 3 * time.Second
			start := time.Now()
			result := sources.RunGitProcess(context.Background(), nil, sources.GitProcessOptions{Timeout: &timeout}, environment)
			if result.Code != 1 || result.Interrupted == nil {
				t.Fatalf("output overflow was not interrupted: code=%d interrupted=%v", result.Code, result.Interrupted)
			}
			if len(result.Stdout) > 4*1024*1024 || len(result.Stderr) > 4*1024*1024 {
				t.Fatalf("output limit was exceeded: stdout=%d stderr=%d", len(result.Stdout), len(result.Stderr))
			}
			if time.Since(start) >= timeout {
				t.Fatal("output overflow waited for the deadline instead of stopping the child")
			}
		})
	}
}

func TestGitProcessDecodesMalformedUTF8(t *testing.T) {
	_, environment := gitFixture(t, "printf '\\357\\273\\277ok\\377\\376\\342\\202'; printf '\\377' >&2")
	result := sources.RunGitProcess(context.Background(), nil, sources.GitProcessOptions{}, environment)
	if result.Code != 0 || result.Stdout != "\ufeffok\ufffd\ufffd\ufffd" || result.Stderr != "\ufffd" {
		t.Fatalf("Git output does not use Node-compatible UTF-8 decoding: %+v", result)
	}
}

func TestGitProcessReportsStartFailure(t *testing.T) {
	root, environment := gitFixture(t, "printf should-not-run")
	result := sources.RunGitProcess(context.Background(), nil, sources.GitProcessOptions{Cwd: filepath.Join(root, "absent")}, environment)
	if result.Code != 1 || result.Stdout != "" || result.Stderr != "" || result.Interrupted != nil {
		t.Fatalf("unexpected spawn failure result: %+v", result)
	}
}

func waitForGitFixture(t *testing.T, file string, deadline time.Time) {
	t.Helper()
	for time.Now().Before(deadline) {
		if _, err := os.Stat(file); err == nil {
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Git child did not start before the test deadline")
}
