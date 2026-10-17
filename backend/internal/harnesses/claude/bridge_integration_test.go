//go:build integration

package claude_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/claude"
)

type fakeBridge struct {
	client  *claude.Client
	ctx     context.Context
	root    string
	profile string
	sdk     string
}

func newFakeBridge(t *testing.T, scripts func(string) []any) fakeBridge {
	t.Helper()
	repo, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	fixture := filepath.Join(root, "sdk")
	// Copy executable test fixtures to owned state; no repository source or
	// shared fixture is mutated, and no source text is asserted.
	if err := os.CopyFS(fixture, os.DirFS(filepath.Join(repo, "conformance/fixtures/harnesses/claude-sdk"))); err != nil {
		t.Fatal(err)
	}
	if scripts != nil {
		data, err := json.Marshal(scripts(root))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(fixture, "scripts.json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("Claude bridge integration requires the CI Node prerequisite:", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	command := exec.CommandContext(ctx, node, filepath.Join(repo, "backend/bridge/claude/claude-bridge.mjs"))
	command.Dir = root
	command.Env = []string{"HOME=" + root, "TMPDIR=" + root, "CLAUDE_CONFIG_DIR=" + filepath.Join(root, "profile"),
		"XDG_CONFIG_HOME=" + filepath.Join(root, "xdg-config"), "XDG_DATA_HOME=" + filepath.Join(root, "xdg-data"),
		"XDG_STATE_HOME=" + filepath.Join(root, "xdg-state"), "XDG_CACHE_HOME=" + filepath.Join(root, "xdg-cache")}
	command.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	command.Stderr = &stderr
	input, err := command.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	output, err := command.StdinPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	client := claude.NewClient(input, output)
	t.Cleanup(func() {
		_ = client.Close()
		err := command.Wait()
		cancel()
		if err != nil {
			t.Errorf("owned fake bridge cleanup: %v; stderr: %s", err, stderr.String())
		}
	})
	bridge := fakeBridge{client: client, ctx: ctx, root: root, profile: filepath.Join(root, "profile"), sdk: filepath.Join(fixture, "sdk.mjs")}
	version, err := client.Initialize(ctx, bridge.sdk)
	if err != nil {
		t.Fatal(err)
	}
	if version != claude.SDKVersion {
		t.Fatalf("unexpected SDK version: %s", version)
	}
	return bridge
}

func marshalValue(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func (bridge fakeBridge) query(t *testing.T, extra map[string]any, callbacks map[string]claude.Callback) *claude.Query {
	t.Helper()
	options := map[string]any{"cwd": bridge.root, "env": map[string]string{"CLAUDE_CONFIG_DIR": bridge.profile}, "permissionMode": "plan"}
	for key, value := range extra {
		options[key] = value
	}
	query, err := bridge.client.Query(bridge.ctx, marshalValue(t, options), callbacks)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := query.Close(bridge.ctx); err != nil {
			t.Errorf("query cleanup: %v", err)
			return
		}
		for {
			_, err := query.Next(bridge.ctx)
			if errors.Is(err, io.EOF) {
				return
			}
			if err != nil {
				t.Errorf("query stream cleanup: %v", err)
				return
			}
		}
	})
	return query
}

func sendPrompt(t *testing.T, ctx context.Context, query *claude.Query, content string) {
	t.Helper()
	message := map[string]any{"type": "user", "message": map[string]string{"role": "user", "content": content},
		"parent_tool_use_id": nil, "uuid": "00000000-0000-4000-8000-000000000011"}
	if err := query.Send(ctx, marshalValue(t, message)); err != nil {
		t.Fatal(err)
	}
}

func nativeResult(t *testing.T, ctx context.Context, query *claude.Query) ([]map[string]json.RawMessage, map[string]json.RawMessage) {
	t.Helper()
	var events []map[string]json.RawMessage
	for {
		raw, err := query.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var event map[string]json.RawMessage
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
		if textValue(t, event["type"]) == "result" {
			return events, event
		}
	}
}

func TestBridgeFakeSDKStreamsControlsHistoryAndFork(t *testing.T) {
	bridge := newFakeBridge(t, nil)
	query := bridge.query(t, nil, nil)
	if err := query.SetPermissionMode(bridge.ctx, "plan"); err != nil {
		t.Fatal(err)
	}
	if err := query.SetPermissionMode(bridge.ctx, "bypassPermissions"); err == nil {
		t.Fatal("session control widened the port's permission modes")
	}
	initialization, err := query.InitializationResult(bridge.ctx)
	if err != nil {
		t.Fatal(err)
	}
	var initial map[string]json.RawMessage
	if err := json.Unmarshal(initialization, &initial); err != nil {
		t.Fatal(err)
	}
	if textValue(t, initial["permissionMode"]) != "plan" {
		t.Fatal("permission control did not reach the SDK")
	}
	endpoint := httptest.NewServer(http.NotFoundHandler())
	defer endpoint.Close()
	servers := marshalValue(t, map[string]any{"files": map[string]string{"type": "http", "url": endpoint.URL + "/mcp"}})
	if _, err := query.SetMCPServers(bridge.ctx, servers); err != nil {
		t.Fatal(err)
	}
	status, err := query.MCPServerStatus(bridge.ctx)
	if err != nil {
		t.Fatal(err)
	}
	var statuses []struct {
		Name   string            `json:"name"`
		Config map[string]string `json:"config"`
	}
	if err := json.Unmarshal(status, &statuses); err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 1 || statuses[0].Name != "files" || statuses[0].Config["url"] != endpoint.URL+"/mcp" {
		t.Fatal("HTTP MCP configuration was changed in transport")
	}
	sendPrompt(t, bridge.ctx, query, "bridge-answer")
	events, result := nativeResult(t, bridge.ctx, query)
	if string(result["is_error"]) != "false" || textValue(t, result["result"]) != "Conformance assistant answer." {
		t.Fatalf("native completion changed: %v", result)
	}
	if len(events) < 3 || textValue(t, events[0]["type"]) != "system" || textValue(t, events[1]["type"]) != "user" {
		t.Fatal("native initialization/input ordering changed")
	}
	session := textValue(t, result["session_id"])
	directory := marshalValue(t, map[string]any{"dir": bridge.root, "offset": 0, "limit": 100})
	info, err := bridge.client.GetSessionInfo(bridge.ctx, session, directory)
	if err != nil {
		t.Fatal(err)
	}
	var identity map[string]json.RawMessage
	if err := json.Unmarshal(info, &identity); err != nil {
		t.Fatal(err)
	}
	if textValue(t, identity["sessionId"]) != session {
		t.Fatal("history read used another native session")
	}
	history, err := bridge.client.GetSessionMessages(bridge.ctx, session, directory)
	if err != nil {
		t.Fatal(err)
	}
	var messages []map[string]json.RawMessage
	if err := json.Unmarshal(history, &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) == 0 || textValue(t, messages[len(messages)-1]["type"]) != "result" {
		t.Fatal("native history omitted the completed result")
	}
	fork, err := bridge.client.ForkSession(bridge.ctx, session, directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(fork, &identity); err != nil {
		t.Fatal(err)
	}
	if forkID := textValue(t, identity["sessionId"]); forkID == "" || forkID == session {
		t.Fatal("fork identity was not preserved")
	}
	if _, err := bridge.client.GetSessionMessages(bridge.ctx, session, marshalValue(t, map[string]string{"dir": filepath.Join(bridge.root, "wrong")})); err == nil {
		t.Fatal("SDK directory mismatch became a successful history read")
	}
}

func TestBridgeFakeSDKRunsGoCallbacksAndPreservesWriteDenial(t *testing.T) {
	bridge := newFakeBridge(t, func(root string) []any {
		return []any{map[string]any{"includes": "denied-write", "answer": "after-tool", "tools": []any{
			map[string]any{"name": "Write", "input": map[string]string{"file_path": filepath.Join(root, "denied.txt"), "content": "must not be written"}},
		}}}
	})
	var before, policy atomic.Int32
	query := bridge.query(t, map[string]any{"tools": []string{"Write"}, "sandbox": map[string]bool{"enabled": true},
		"canUseTool": claude.CallbackReference("policy"), "hooks": map[string]any{
			"PreToolUse": []any{map[string]any{"hooks": []any{claude.CallbackReference("before")}}},
		}}, map[string]claude.Callback{
		"before": func(ctx context.Context, args []json.RawMessage) (json.RawMessage, error) {
			if ctx.Err() != nil || len(args) != 3 {
				return nil, errors.New("hook context or arguments are unavailable")
			}
			before.Add(1)
			return json.RawMessage(`{}`), nil
		},
		"policy": func(ctx context.Context, args []json.RawMessage) (json.RawMessage, error) {
			if ctx.Err() != nil || len(args) != 3 || string(args[0]) != `"Write"` {
				return nil, errors.New("tool callback arguments changed")
			}
			var options map[string]json.RawMessage
			if err := json.Unmarshal(args[2], &options); err != nil {
				return nil, err
			}
			if len(options["toolUseID"]) == 0 || options["signal"] != nil {
				return nil, errors.New("callback identity or cancellation transport changed")
			}
			policy.Add(1)
			return json.RawMessage(`{"behavior":"deny","message":"Read-only policy denies writing."}`), nil
		},
	})
	sendPrompt(t, bridge.ctx, query, "denied-write")
	events, result := nativeResult(t, bridge.ctx, query)
	if before.Load() != 1 || policy.Load() != 1 {
		t.Fatalf("callbacks did not round trip: before=%d policy=%d", before.Load(), policy.Load())
	}
	if string(result["is_error"]) != "true" {
		t.Fatal("denied native tool became successful completion")
	}
	denied := false
	for _, event := range events {
		if textValue(t, event["type"]) != "user" {
			continue
		}
		var message struct {
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(event["message"], &message); err != nil {
			t.Fatal(err)
		}
		if len(message.Content) == 0 || message.Content[0] != '[' {
			continue
		}
		var content []struct {
			Type    string `json:"type"`
			IsError bool   `json:"is_error"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(message.Content, &content); err != nil {
			t.Fatal(err)
		}
		for _, block := range content {
			if block.Type == "tool_result" && block.IsError && block.Content == `{"error":"Tool request denied."}` {
				denied = true
			}
		}
	}
	if !denied {
		t.Fatal("native permission-denial result was lost")
	}
	if _, err := os.Stat(filepath.Join(bridge.root, "denied.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("denied write changed owned filesystem: %v", err)
	}
}

func TestBridgeFakeSDKInterruptsAnActiveTurn(t *testing.T) {
	bridge := newFakeBridge(t, func(string) []any { return []any{map[string]any{"includes": "interrupt-me", "waitForInterrupt": true}} })
	query := bridge.query(t, nil, nil)
	sendPrompt(t, bridge.ctx, query, "interrupt-me")
	for {
		event, err := query.Next(bridge.ctx)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]json.RawMessage
		if err := json.Unmarshal(event, &value); err != nil {
			t.Fatal(err)
		}
		if textValue(t, value["type"]) == "user" {
			break
		}
	}
	if _, err := query.Interrupt(bridge.ctx); err != nil {
		t.Fatal(err)
	}
	_, result := nativeResult(t, bridge.ctx, query)
	if string(result["is_error"]) != "true" || textValue(t, result["result"]) != "Interrupted." {
		t.Fatal(fmt.Sprintf("interrupt result changed: %v", result))
	}
}
