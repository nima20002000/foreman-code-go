//go:build integration

package codex_test

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
)

// This test executes the repository's scripted app-server through the public Go
// transport. The fixture's files, HOME, native state, and cwd are disposable.
func TestScriptedAppServerSessionAndTurn(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("scripted app-server prerequisite is missing: %v", err)
	}
	directory := t.TempDir()
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "apps", "api", "test", "fixtures", "codex-app-server.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	fixture := filepath.Join(directory, "codex-app-server.cjs")
	if err := os.WriteFile(fixture, source, 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, node, fixture, "app-server", "--stdio")
	command.Dir = directory
	command.Env = []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + directory, "USERPROFILE=" + directory,
		"CODEX_HOME=" + directory, "TMPDIR=" + directory, "TMP=" + directory, "TEMP=" + directory,
		"XDG_CONFIG_HOME=" + directory, "XDG_STATE_HOME=" + directory, "TEST_AGENT_ID=go-transport",
	}
	command.Stderr = io.Discard
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
	events := make(chan codex.Notification, 64)
	transport, err := codex.NewTransport(codex.Streams{Input: input, Output: output}, codex.Options{
		Protocol: testProtocol{}, OnNotification: func(value codex.Notification) { events <- value },
	})
	if err != nil {
		_ = input.Close()
		_ = output.Close()
		_ = command.Wait()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := transport.Close(); err != nil {
			t.Error(err)
		}
		if err := command.Wait(); err != nil {
			t.Errorf("scripted native process did not close cleanly: %v", err)
		}
	})
	if err := transport.Start(ctx); err != nil {
		t.Fatal(err)
	}
	started, err := transport.StartThread(ctx, protocol.V2ThreadStartParams{
		Model: protocol.Some("test-model"), Cwd: protocol.Some(directory), Ephemeral: protocol.Some(true),
		Sandbox:        protocol.Some(protocol.V2SandboxMode("read-only")),
		ApprovalPolicy: protocol.Some(json.RawMessage(`"never"`)),
	})
	if err != nil || started.Thread == nil || started.Thread.ID == "" {
		t.Fatalf("native thread did not start: %v", err)
	}
	var sandbox map[string]any
	if json.Unmarshal(started.Sandbox, &sandbox) != nil || sandbox["type"] != "readOnly" || sandbox["networkAccess"] != false {
		t.Fatalf("native session did not retain read-only settings: %s", started.Sandbox)
	}
	turn, err := transport.StartTurn(ctx, protocol.V2TurnStartParams{
		ThreadID: started.Thread.ID,
		Input:    []protocol.V2UserInput{json.RawMessage(`{"type":"text","text":"hello","text_elements":[]}`)},
	})
	if err != nil || turn.Turn == nil || turn.Turn.ID == "" {
		t.Fatalf("native turn did not start: %v", err)
	}
	for {
		select {
		case native := <-events:
			if native.Method != "turn/completed" {
				continue
			}
			var completed protocol.V2TurnCompletedNotification
			if err := json.Unmarshal(native.Params, &completed); err != nil {
				t.Fatal(err)
			}
			if completed.ThreadID != started.Thread.ID || completed.Turn == nil || completed.Turn.ID != turn.Turn.ID || completed.Turn.Status != "completed" {
				t.Fatalf("native completion identity/status mismatch: %s", native.Params)
			}
			if len(completed.Turn.Items) < 2 {
				t.Fatal("completed native turn lost its user input or assistant output")
			}
			return
		case <-ctx.Done():
			t.Fatal("scripted native turn never completed")
		}
	}
}
