package claude_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/claude"
)

func diagnosticPeer(t *testing.T) (*claude.Client, *peer, context.Context) {
	t.Helper()
	client, server, ctx := newPeer(t)
	stop := context.AfterFunc(ctx, func() { _ = client.Close() })
	t.Cleanup(func() { stop() })
	return client, server, ctx
}

// These are compatibility guards for the retained bridge diagnostics.
func TestBridgePublicErrorCompatibility(t *testing.T) {
	t.Run("closed sentinel", func(t *testing.T) {
		client, _, ctx := diagnosticPeer(t)
		if err := client.Close(); err != nil {
			t.Fatal(err)
		}
		_, err := client.GetSessionInfo(ctx, "session", nil)
		if err != claude.ErrClosed || !errors.Is(err, claude.ErrClosed) {
			t.Fatalf("bridge sentinel identity changed: %v", err)
		}
		if err.Error() != "Claude bridge is closed" || errors.Unwrap(err) != nil {
			t.Fatalf("bridge sentinel diagnostic changed: %v", err)
		}
		if !errors.Is(fmt.Errorf("read session: %w", err), claude.ErrClosed) {
			t.Fatal("wrapped bridge sentinel no longer matches")
		}
	})
	t.Run("callback without identity", func(t *testing.T) {
		client, server, ctx := diagnosticPeer(t)
		finished := make(chan error, 1)
		go func() {
			_, err := client.GetSessionInfo(ctx, "session", nil)
			finished <- err
		}()
		server.receive(t)
		server.send(t, map[string]any{"method": "callback", "params": map[string]any{}})
		err := <-finished
		if err == nil || err.Error() != "Claude callback has no request identity" || errors.Unwrap(err) != nil {
			t.Fatalf("callback identity diagnostic changed: %v", err)
		}
		_, again := client.GetSessionInfo(ctx, "session", nil)
		if again != err || !errors.Is(again, err) {
			t.Fatal("closed transport did not retain its original callback failure")
		}
	})
	t.Run("unregistered callback", func(t *testing.T) {
		_, server, _ := diagnosticPeer(t)
		server.send(t, map[string]any{"id": "callback-one", "method": "callback", "params": map[string]any{
			"queryId": "unknown-query", "name": "unregistered", "args": []any{},
		}})
		answer := server.receive(t)
		var failure struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(answer["error"], &failure); err != nil {
			t.Fatal(err)
		}
		if textValue(t, answer["id"]) != "callback-one" || failure.Code != -32000 || failure.Message != "Claude callback is not registered" || len(answer["result"]) != 0 {
			t.Fatalf("unregistered callback diagnostic changed: %v", answer)
		}
	})
	t.Run("SDK version mismatch", func(t *testing.T) {
		client, server, ctx := diagnosticPeer(t)
		const version = "0.0.0\n\"custom\""
		const message = `Claude SDK version "0.0.0\n\"custom\"" does not match pinned 0.3.284`
		failures := make([]error, 0, 2)
		for attempt := 0; attempt < 2; attempt++ {
			finished := make(chan error, 1)
			go func() {
				_, err := client.Initialize(ctx, "/isolated/fake-sdk.js")
				finished <- err
			}()
			request := server.receive(t)
			server.send(t, map[string]any{"id": request["id"], "result": map[string]string{"sdkVersion": version}})
			err := <-finished
			if err == nil || err.Error() != message || errors.Unwrap(err) != nil {
				t.Fatalf("SDK version diagnostic changed: %v", err)
			}
			failures = append(failures, err)
		}
		if failures[0] == failures[1] || errors.Is(failures[0], failures[1]) {
			t.Fatal("separate SDK version failures acquired shared identity")
		}
	})
}
