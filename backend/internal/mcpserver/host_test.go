package mcpserver_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

type hostPrincipalKey struct{}

// This isolated public Access fixture admits only the exact Host supplied by its
// case. It does not copy the product Host allowlist, credentials, or principals.
// The source-owned access adapter has a separate integrated TCP policy gate.
type hostAccess struct {
	admittedHost string
	failure error
	nilContext bool
	calls atomic.Int32
	loopback atomic.Bool
	bodyReads atomic.Int32
	bodyBeforeAuthentication atomic.Bool
}

func (access *hostAccess) Authenticate(request *http.Request) (context.Context, error) {
	access.calls.Add(1)
	if local, ok := request.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
		host, _, err := net.SplitHostPort(local.String())
		if err == nil && net.ParseIP(host).IsLoopback() { access.loopback.Store(true) }
	}
	if request.Host != access.admittedHost {
		return nil, domainerror.New("HOST_NOT_ALLOWED", "The fixture Host was not admitted.", 403, nil)
	}
	if request.Header.Get("Origin") != "" {
		return nil, domainerror.New("ORIGIN_NOT_ALLOWED", "The fixture Origin was not admitted.", 403, nil)
	}
	if request.Header.Get("Authorization") != "Bearer host-fixture" {
		return nil, domainerror.New("AUTH_REQUIRED", "The isolated fixture credential is required.", 401, nil)
	}
	if access.failure != nil { return nil, access.failure }
	if access.nilContext { return nil, nil }
	return context.WithValue(request.Context(), hostPrincipalKey{}, true), nil
}

func (*hostAccess) PrincipalID(ctx context.Context) (string, error) {
	if ctx.Value(hostPrincipalKey{}) != true { return "", fmt.Errorf("fixture principal is missing") }
	return "\x00h", nil
}

func (*hostAccess) Visible(ctx context.Context, name string) (bool, error) {
	return ctx.Value(hostPrincipalKey{}) == true && name == "fixture_host", nil
}

func (*hostAccess) Authorize(ctx context.Context, name string, _ json.RawMessage) error {
	if ctx.Value(hostPrincipalKey{}) != true || name != "fixture_host" {
		return domainerror.New("ACCESS_DENIED", "The fixture tool was not admitted.", 403, nil)
	}
	return nil
}

type hostObservedBody struct {
	io.ReadCloser
	access *hostAccess
}

func (body *hostObservedBody) Read(data []byte) (int, error) {
	body.access.bodyReads.Add(1)
	if body.access.calls.Load() == 0 { body.access.bodyBeforeAuthentication.Store(true) }
	return body.ReadCloser.Read(data)
}

type hostReply struct {
	status int
	header http.Header
	body []byte
	invocations int32
}

func hostRequest(t *testing.T, access *hostAccess, omitAccess bool, host, origin, credential string) hostReply {
	t.Helper()
	options := app.Options{}
	if !omitAccess { options.MCPAccess = access }
	application, err := app.New(options)
	if err != nil { t.Fatal(err) }
	var invocations atomic.Int32
	application.RegisterTool(&mcp.Tool{Name: "fixture_host", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		func(raw json.RawMessage) error {
			if !bytes.Equal(bytes.TrimSpace(raw), []byte(`{}`)) { return fmt.Errorf("fixture arguments must be empty") }
			return nil
		},
		func(_ context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			invocations.Add(1)
			return mcpserver.ToolResult(map[string]any{"completed": true})
		})
	handler := application.Handler()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		request.Body = &hostObservedBody{ReadCloser: request.Body, access: access}
		handler.ServeHTTP(w, request)
	}))
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{}, Timeout: 3 * time.Second}
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/mcp", strings.NewReader(
		`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_host","arguments":{}}}`))
	if err != nil { t.Fatal(err) }
	request.Host = host
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
	if origin != "" { request.Header.Set("Origin", origin) }
	if credential != "" { request.Header.Set("Authorization", credential) }
	response, err := client.Do(request)
	if err != nil { t.Fatal(err) }
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil { t.Fatal(err) }
	return hostReply{status: response.StatusCode, header: response.Header.Clone(), body: data, invocations: invocations.Load()}
}

// This unchanged public regression runs against the merged base production.
// Its real TCP request creates LocalAddrContextKey, which a Recorder cannot do.
func TestMCPUsesAdmittedHostOnLoopbackListener(t *testing.T) {
	for _, scenario := range []struct { name, host string }{
		{"cgnat", "100.64.0.1"},
		{"tailnet", "worker.tail.ts.net"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			access := &hostAccess{admittedHost: scenario.host}
			reply := hostRequest(t, access, false, scenario.host, "", "Bearer host-fixture")
			if access.calls.Load() == 0 || !access.loopback.Load() {
				t.Fatal("fixture did not reach public Access admission on a real loopback listener")
			}
			if access.bodyBeforeAuthentication.Load() { t.Fatal("MCP read the body before required Access admission") }
			if reply.status != http.StatusOK || reply.invocations != 1 {
				t.Fatalf("source-admitted Host was rejected before public MCP tool dispatch: status %d, invocations %d, body %s", reply.status, reply.invocations, reply.body)
			}
			data := reply.body
			if strings.HasPrefix(reply.header.Get("Content-Type"), "text/event-stream") {
				scanner := bufio.NewScanner(bytes.NewReader(data))
				for scanner.Scan() {
					if value, ok := strings.CutPrefix(scanner.Text(), "data: "); ok { data = []byte(value); break }
				}
				if err := scanner.Err(); err != nil { t.Fatal(err) }
			}
			var response struct {
				ID int `json:"id"`
				Result struct { Structured struct { Completed bool `json:"completed"` } `json:"structuredContent"` } `json:"result"`
			}
			if err := json.Unmarshal(data, &response); err != nil { t.Fatal(err) }
			if response.ID != 7 || !response.Result.Structured.Completed {
				t.Fatalf("admitted Host did not receive its completed public tool response: %s", data)
			}
		})
	}
}

func TestMCPHostTransportRetainsRequiredAccess(t *testing.T) {
	for _, scenario := range []struct {
		name, host, origin, credential, code string
		status int
		omitAccess, nilContext bool
		failure error
	}{
		{name: "denied_host", host: "public.example", credential: "Bearer host-fixture", code: "HOST_NOT_ALLOWED", status: 403},
		{name: "denied_origin", host: "100.64.0.1", origin: "https://public.example", credential: "Bearer host-fixture", code: "ORIGIN_NOT_ALLOWED", status: 403},
		{name: "missing_credential", host: "100.64.0.1", code: "AUTH_REQUIRED", status: 401},
		{name: "admission_error", host: "100.64.0.1", credential: "Bearer host-fixture", code: "ACCESS_DENIED", status: 403, failure: domainerror.New("ACCESS_DENIED", "Fixture admission failed.", 403, nil)},
		{name: "nil_context", host: "100.64.0.1", credential: "Bearer host-fixture", code: "INTERNAL_ERROR", status: 500, nilContext: true},
		{name: "missing_access_with_credential", host: "100.64.0.1", credential: "Bearer host-fixture", code: "MCP_UNAVAILABLE", status: 503, omitAccess: true},
		{name: "missing_access_without_credential", host: "100.64.0.1", code: "AUTH_REQUIRED", status: 401, omitAccess: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			access := &hostAccess{admittedHost: "100.64.0.1", failure: scenario.failure, nilContext: scenario.nilContext}
			reply := hostRequest(t, access, scenario.omitAccess, scenario.host, scenario.origin, scenario.credential)
			var envelope struct { Error struct { Code string `json:"code"` } `json:"error"` }
			if err := json.Unmarshal(reply.body, &envelope); err != nil { t.Fatalf("admission failure was replaced by a transport response: %v; %s", err, reply.body) }
			if reply.status != scenario.status || envelope.Error.Code != scenario.code {
				t.Fatalf("required Access denial changed: status %d, code %q; want %d, %q", reply.status, envelope.Error.Code, scenario.status, scenario.code)
			}
			if reply.invocations != 0 || access.bodyReads.Load() != 0 {
				t.Fatalf("unadmitted request reached body or tool: body reads %d, invocations %d", access.bodyReads.Load(), reply.invocations)
			}
			if scenario.omitAccess {
				if access.calls.Load() != 0 { t.Fatal("missing fixture Access was invoked") }
			} else if access.calls.Load() != 1 || !access.loopback.Load() {
				t.Fatal("denial did not stop at first public Access call on the loopback listener")
			}
		})
	}
}
