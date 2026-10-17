package mcpserver_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

type principalKey struct{}

// This synthetic policy tests the public registration boundary without adding product grants.
type counterAccess struct{ authentications atomic.Int32 }

func (a *counterAccess) Authenticate(request *http.Request) (context.Context, error) {
	a.authentications.Add(1)
	token := request.Header.Get("Authorization")
	if token == "" {
		return nil, domainerror.New("AUTH_REQUIRED", "A bearer credential is required.", 401, nil)
	}
	if token != "Bearer reader" && token != "Bearer writer" {
		return nil, domainerror.New("AUTH_INVALID", "The supplied credential is invalid.", 401, nil)
	}
	return context.WithValue(request.Context(), principalKey{}, token), nil
}

func (a *counterAccess) Visible(ctx context.Context, name string) (bool, error) {
	return name == "counter_get" || ctx.Value(principalKey{}) == "Bearer writer", nil
}

func (a *counterAccess) Authorize(ctx context.Context, name string, _ json.RawMessage) error {
	visible, err := a.Visible(ctx, name)
	if err != nil {
		return err
	}
	if !visible {
		return domainerror.New("ACCESS_DENIED", "The caller is not authorized for this operation and resource.", 403, nil)
	}
	return nil
}

func counterApp(t *testing.T) (*app.App, *counterAccess, *atomic.Int32) {
	t.Helper()
	access := &counterAccess{}
	application, err := app.New(app.Options{MCPAccess: access})
	if err != nil {
		t.Fatal(err)
	}
	count := &atomic.Int32{}
	validate := func(raw json.RawMessage) error {
		if len(raw) == 0 {
			return nil
		}
		var input map[string]json.RawMessage
		if err := json.Unmarshal(raw, &input); err != nil || len(input) != 0 {
			return domainerror.New("INVALID_REQUEST", "The request does not match its shared contract.", 400, nil)
		}
		return nil
	}
	for _, name := range []string{"counter_get", "counter_increment"} {
		application.RegisterTool(&mcp.Tool{Name: name,
			InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
			validate, func(_ context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				if name == "counter_increment" {
					count.Add(1)
				}
				return mcpserver.ToolResult(map[string]any{"value": count.Load()})
			})
	}
	return application, access, count
}

func rpc(t *testing.T, application *app.App, token, body string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/mcp", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	application.Handler().ServeHTTP(recorder, request)
	data := recorder.Body.Bytes()
	if strings.HasPrefix(recorder.Header().Get("Content-Type"), "text/event-stream") {
		scanner := bufio.NewScanner(strings.NewReader(recorder.Body.String()))
		for scanner.Scan() {
			if line, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
				data = []byte(line)
				break
			}
		}
		if err := scanner.Err(); err != nil {
			t.Fatal(err)
		}
	}
	var response map[string]any
	if err := json.Unmarshal(data, &response); err != nil {
		t.Fatalf("RPC status %d body %q: %v", recorder.Code, recorder.Body.String(), err)
	}
	return recorder.Code, response
}

func TestMCPAuthenticatesEveryRequestAndPreservesReadOnlyDenials(t *testing.T) {
	application, access, count := counterApp(t)
	status, initialized := rpc(t, application, "writer", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`)
	if status != 200 || initialized["result"].(map[string]any)["protocolVersion"] != "2025-11-25" {
		t.Fatalf("initialization = %d %#v", status, initialized)
	}
	status, written := rpc(t, application, "writer", `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"counter_increment","arguments":{}}}`)
	if status != 200 || written["result"].(map[string]any)["isError"] == true || count.Load() != 1 {
		t.Fatalf("writer call = %d %#v, counter %d", status, written, count.Load())
	}
	status, catalog := rpc(t, application, "reader", `{"jsonrpc":"2.0","id":3,"method":"tools/list"}`)
	tools := catalog["result"].(map[string]any)["tools"].([]any)
	if status != 200 || len(tools) != 1 || tools[0].(map[string]any)["name"] != "counter_get" {
		t.Fatalf("reader catalog = %d %#v", status, catalog)
	}
	status, denied := rpc(t, application, "reader", `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"counter_increment","arguments":{}}}`)
	result := denied["result"].(map[string]any)
	if status != 200 || result["isError"] != true || result["structuredContent"] != nil || count.Load() != 1 {
		t.Fatalf("reader write = %d %#v, counter %d", status, denied, count.Load())
	}
	content := result["content"].([]any)[0].(map[string]any)["text"].(string)
	var errorBody map[string]map[string]any
	if err := json.Unmarshal([]byte(content), &errorBody); err != nil {
		t.Fatal(err)
	}
	if errorBody["error"]["code"] != "ACCESS_DENIED" {
		t.Fatalf("denial body = %#v", errorBody)
	}
	status, readback := rpc(t, application, "reader", `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"counter_get","arguments":{}}}`)
	value := readback["result"].(map[string]any)["structuredContent"].(map[string]any)["value"]
	if status != 200 || value != float64(1) || access.authentications.Load() != 5 {
		t.Fatalf("persisted readback = %d %#v, authentications %d", status, readback, access.authentications.Load())
	}
}

func TestMCPRejectsMissingCredentialsBeforeReadingBody(t *testing.T) {
	application, _, _ := counterApp(t)
	// Malformed JSON would be a 400 only after successful authentication.
	status, response := rpc(t, application, "", "not valid JSON")
	if status != 401 || response["error"].(map[string]any)["code"] != "AUTH_REQUIRED" {
		t.Fatalf("unauthenticated response = %d %#v", status, response)
	}
}

func TestMCPMethodRejectionStillAuthenticates(t *testing.T) {
	application, access, _ := counterApp(t)
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		request := httptest.NewRequest(method, "http://127.0.0.1/mcp", nil)
		request.Header.Set("Authorization", "Bearer reader")
		recorder := httptest.NewRecorder()
		application.Handler().ServeHTTP(recorder, request)
		var response map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if recorder.Code != 405 || response["jsonrpc"] != "2.0" || response["id"] != nil ||
			response["error"].(map[string]any)["code"] != float64(-32000) {
			t.Fatalf("%s response = %d %#v", method, recorder.Code, response)
		}
	}
	if access.authentications.Load() != 2 {
		t.Fatalf("method rejections authenticated %d times, want 2", access.authentications.Load())
	}
}
