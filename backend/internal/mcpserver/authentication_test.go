package mcpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

type reauthenticationPrincipal struct{}

// This credential table and tool are isolated HTTP fixtures, never generated
// product principal replacements or new grants. State 0 is revoked; 1 and 2
// stand for two distinct principals bound to the same fixture credential.
type reauthenticationAccess struct {
	state atomic.Int32
	calls atomic.Int32
	invocations atomic.Int32
	dispatchedPrincipal atomic.Int32
}

func (access *reauthenticationAccess) Authenticate(request *http.Request) (context.Context, error) {
	access.calls.Add(1)
	if request.Header.Get("Authorization") != "Bearer fixture-rebind" || access.state.Load() == 0 {
		return nil, domainerror.New("AUTH_REQUIRED", "The isolated fixture credential was revoked.", 401, nil)
	}
	return context.WithValue(request.Context(), reauthenticationPrincipal{}, access.state.Load()), nil
}

func (*reauthenticationAccess) PrincipalID(ctx context.Context) (string, error) {
	switch ctx.Value(reauthenticationPrincipal{}) {
	case int32(1): return "\x00o\x00l\x00d", nil
	case int32(2): return "\x00n\x00e\x00w", nil
	default: return "", errors.New("fixture principal context was lost")
	}
}

func (*reauthenticationAccess) Visible(_ context.Context, name string) (bool, error) {
	return name == "fixture_identity", nil
}

func (*reauthenticationAccess) Authorize(ctx context.Context, name string, _ json.RawMessage) error {
	if name != "fixture_identity" || ctx.Value(reauthenticationPrincipal{}) == nil {
		return domainerror.New("ACCESS_DENIED", "Fixture access denied.", 403, nil)
	}
	return nil
}

type reauthenticationBody struct {
	reader *strings.Reader
	access *reauthenticationAccess
	next int32
	authAtRead int32
	once sync.Once
}

func (body *reauthenticationBody) Read(destination []byte) (int, error) {
	body.once.Do(func() {
		body.authAtRead = body.access.calls.Load()
		body.access.state.Store(body.next)
	})
	return body.reader.Read(destination)
}

func (*reauthenticationBody) Close() error { return nil }

func serveReauthenticationRequest(t *testing.T, next int32) (*reauthenticationAccess, *reauthenticationBody, *httptest.ResponseRecorder) {
	t.Helper()
	access := &reauthenticationAccess{}
	access.state.Store(1)
	application, err := app.New(app.Options{MCPAccess: access})
	if err != nil { t.Fatal(err) }
	application.RegisterTool(&mcp.Tool{Name: "fixture_identity", InputSchema: json.RawMessage(
		`{"type":"object","properties":{},"additionalProperties":false}`)},
		func(raw json.RawMessage) error {
			var value map[string]json.RawMessage
			if err := json.Unmarshal(raw, &value); err != nil { return err }
			if value == nil || len(value) != 0 { return errors.New("fixture arguments must be an empty object") }
			return nil
		},
		func(ctx context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			principal, ok := ctx.Value(reauthenticationPrincipal{}).(int32)
			if !ok { return nil, errors.New("fixture dispatch lost principal") }
			access.invocations.Add(1)
			access.dispatchedPrincipal.Store(principal)
			label := "old"
			if principal == 2 { label = "new" }
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "principal:" + label}}}, nil
		})
	const payload = `{"jsonrpc":"2.0","id":91,"method":"tools/call","params":{"name":"fixture_identity","arguments":{}}}`
	body := &reauthenticationBody{reader: strings.NewReader(payload), access: access, next: next}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/mcp", strings.NewReader(payload)).WithContext(ctx)
	request.Body = body
	request.Header.Set("Authorization", "Bearer fixture-rebind")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
	recorder := httptest.NewRecorder()
	application.Handler().ServeHTTP(recorder, request)
	return access, body, recorder
}

func TestMCPReauthenticatesRevokedCredentialsAfterBodyAdmission(t *testing.T) {
	access, body, recorder := serveReauthenticationRequest(t, 0)
	// Required pre-fix red must reach this public dispatch assertion after the
	// first authentication and body read, not merely fail a call-count check.
	if access.invocations.Load() != 0 {
		t.Fatal("revoked credential dispatched a public MCP tool after body admission")
	}
	response := recorder.Result()
	defer response.Body.Close()
	content, err := io.ReadAll(response.Body)
	if err != nil { t.Fatal(err) }
	if response.StatusCode != 401 || !bytes.Contains(content, []byte(`"code":"AUTH_REQUIRED"`)) {
		t.Fatalf("revoked credential did not retain the public auth denial: status%d %s", response.StatusCode, content)
	}
	if body.authAtRead != 1 || access.calls.Load() != 2 {
		t.Fatalf("authentication/body ordering: first body read after%d calls, final%d; want1 then2", body.authAtRead, access.calls.Load())
	}
}

func TestMCPRebindsPrincipalAfterBodyAdmission(t *testing.T) {
	access, body, recorder := serveReauthenticationRequest(t, 2)
	if access.invocations.Load() != 1 {
		t.Fatalf("fixture request did not reach exactly one public tool: calls%d response%s", access.invocations.Load(), recorder.Body.Bytes())
	}
	if access.dispatchedPrincipal.Load() != 2 {
		t.Fatal("rebound credential dispatched a public MCP tool using its prior principal")
	}
	response := recorder.Result()
	defer response.Body.Close()
	content, err := io.ReadAll(response.Body)
	if err != nil { t.Fatal(err) }
	if response.StatusCode != 200 || !bytes.Contains(content, []byte(`"text":"principal:new"`)) {
		t.Fatalf("rebound principal did not retain successful public readback: status%d %s", response.StatusCode, content)
	}
	if body.authAtRead != 1 || access.calls.Load() != 2 {
		t.Fatalf("authentication/body ordering: first body read after%d calls, final%d; want1 then2", body.authAtRead, access.calls.Load())
	}
}
