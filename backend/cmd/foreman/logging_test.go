package main_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/command"
)

// Terminal CI supplies this exact candidate's already-built command. The tests
// neither build a binary nor launch serve, a worker runtime, or a database.
func runLoggingCommand(t *testing.T, level string, arguments ...string) (int, []byte, []byte) {
	t.Helper()
	binary := os.Getenv("FOREMAN_TEST_BINARY")
	if binary == "" || !filepath.IsAbs(binary) {
		t.Fatal("FOREMAN_TEST_BINARY must name the exact isolated candidate command built by terminal CI")
	}
	root := t.TempDir()
	for _, name := range []string{"home", "config", "state", "cache", "tmp"} {
		if err := os.Mkdir(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	process := exec.Command(binary, arguments...)
	process.Dir = root
	process.Env = []string{"HOME=" + filepath.Join(root, "home"), "XDG_CONFIG_HOME=" + filepath.Join(root, "config"),
		"XDG_STATE_HOME=" + filepath.Join(root, "state"), "XDG_CACHE_HOME=" + filepath.Join(root, "cache"),
		"TMPDIR=" + filepath.Join(root, "tmp"), "LOG_LEVEL=" + level}
	var stdout, stderr bytes.Buffer
	process.Stdout, process.Stderr = &stdout, &stderr
	err := process.Run()
	status := 0
	if err != nil {
		var exited *exec.ExitError
		if !errors.As(err, &exited) {
			t.Fatalf("run isolated command: %v", err)
		}
		status = exited.ExitCode()
	}
	return status, stdout.Bytes(), stderr.Bytes()
}

func TestForemanLoggingHelpExit(t *testing.T) {
	status, stdout, stderr := runLoggingCommand(t, "trace", "--help")
	if status != 0 || string(stdout) != command.Usage() || len(stderr) != 0 {
		t.Fatalf("help status=%d stdout=%q stderr=%q", status, stdout, stderr)
	}
}

func TestForemanLoggingUsageExit(t *testing.T) {
	status, stdout, stderr := runLoggingCommand(t, "trace", "isolated-unknown-command")
	if status != 2 || string(stderr) != command.Usage() {
		t.Fatalf("usage status=%d stderr=%q", status, stderr)
	}
	assertFinalCommandLine(t, stdout, "Unknown foreman command \"isolated-unknown-command\".")
}

func TestForemanLoggingUnavailableExit(t *testing.T) {
	status, stdout, stderr := runLoggingCommand(t, "trace", "worker")
	if status != 1 || len(stderr) != 0 {
		t.Fatalf("unavailable status=%d stderr=%q", status, stderr)
	}
	assertFinalCommandLine(t, stdout, "The worker command is not available in this build.")
}

func TestForemanLoggingSilentPreservesFailureExit(t *testing.T) {
	status, stdout, stderr := runLoggingCommand(t, "silent", "isolated-unknown-command")
	if status != 2 || len(stdout) != 0 || string(stderr) != command.Usage() {
		t.Fatalf("silent status=%d stdout=%q stderr=%q", status, stdout, stderr)
	}
}

func assertFinalCommandLine(t *testing.T, data []byte, message string) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	var line map[string]any
	if err := decoder.Decode(&line); err != nil {
		t.Fatalf("last line was not drained to stdout: %q, %v", data, err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		t.Fatalf("extra command output: %#v, %v", extra, err)
	}
	if line["service"] != "graphql-api" || line["level"] != "error" || line["component"] != "lifecycle" ||
		line["msg"] != "foreman command failed" || line["error"].(map[string]any)["message"] != message {
		t.Fatalf("last command diagnostic = %#v", line)
	}
}
