package mcpserver_test

import (
	"bufio"
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
	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

const cancellationWait = 3 * time.Second

type cancellationPrincipal struct{}

// The policy and tool below are isolated public-boundary fixtures, never product
// grants, generated principal substitutes, or installation/qualification receipts.
type cancellationAccess struct {
	identityCalls atomic.Int32
	missing       bool
	failure       error
}

func (access *cancellationAccess) Authenticate(request *http.Request) (context.Context, error) {
	var key string
	switch request.Header.Get("Authorization") {
	case "Bearer caller-a":
		key = "\x00a"
	case "Bearer caller-b":
		key = "\x00b"
	case "Bearer caller-surrogate":
		key = "\xd8\x00"
	case "Bearer caller-replacement":
		key = "\xff\xfd"
	default:
		return nil, domainerror.New("AUTH_REQUIRED", "An isolated fixture credential is required.", 401, nil)
	}
	return context.WithValue(request.Context(), cancellationPrincipal{}, key), nil
}

func (access *cancellationAccess) PrincipalID(ctx context.Context) (string, error) {
	access.identityCalls.Add(1)
	if access.failure != nil {
		return "", access.failure
	}
	if access.missing {
		return "", nil
	}
	key, ok := ctx.Value(cancellationPrincipal{}).(string)
	if !ok {
		return "", errors.New("fixture principal context was lost")
	}
	return key, nil
}

func (*cancellationAccess) Visible(_ context.Context, name string) (bool, error) {
	return name == "fixture_wait", nil
}

func (*cancellationAccess) Authorize(ctx context.Context, name string, _ json.RawMessage) error {
	if ctx.Value(cancellationPrincipal{}) == nil || name != "fixture_wait" {
		return domainerror.New("ACCESS_DENIED", "Fixture access denied.", 403, nil)
	}
	return nil
}

type cancellationArguments struct {
	Label              string `json:"label"`
	Wait               bool   `json:"wait"`
	IgnoreCancellation bool   `json:"ignoreCancellation"`
}

func cancellationInput(raw json.RawMessage) (cancellationArguments, error) {
	var value cancellationArguments
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	if value.Label == "" {
		return value, errors.New("fixture label is required")
	}
	return value, nil
}

type cancellationActivity struct {
	label   string
	ctx     context.Context
	release chan struct{}
	once    sync.Once
}

func (activity *cancellationActivity) finish() { activity.once.Do(func() { close(activity.release) }) }

type cancellationFixture struct {
	access      *cancellationAccess
	server      *httptest.Server
	client      *http.Client
	entered     chan *cancellationActivity
	stop        chan struct{}
	invocations atomic.Int32
}

func newCancellationFixture(t *testing.T, access *cancellationAccess) *cancellationFixture {
	t.Helper()
	if access == nil {
		access = &cancellationAccess{}
	}
	fixture := &cancellationFixture{access: access, entered: make(chan *cancellationActivity, 16), stop: make(chan struct{})}
	application, err := app.New(app.Options{MCPAccess: access})
	if err != nil {
		t.Fatal(err)
	}
	application.RegisterTool(&mcp.Tool{Name: "fixture_wait", InputSchema: json.RawMessage(
		`{"type":"object","properties":{"label":{"type":"string"},"wait":{"type":"boolean"},"ignoreCancellation":{"type":"boolean"}},"required":["label"],"additionalProperties":false}`)},
		func(raw json.RawMessage) error { _, err := cancellationInput(raw); return err },
		func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			fixture.invocations.Add(1)
			arguments, err := cancellationInput(request.Params.Arguments)
			if err != nil {
				return nil, err
			}
			state := "completed"
			if arguments.Wait {
				activity := &cancellationActivity{label: arguments.Label, ctx: ctx, release: make(chan struct{})}
				fixture.entered <- activity
				if arguments.IgnoreCancellation {
					select {
					case <-activity.release:
					case <-fixture.stop:
					}
				} else {
					select {
					case <-ctx.Done():
					case <-activity.release:
					case <-fixture.stop:
					}
				}
				if ctx.Err() != nil {
					state = "cancelled"
				}
			}
			return mcpserver.ToolResult(map[string]any{"label": arguments.Label, "state": state})
		})
	fixture.server = httptest.NewServer(application.Handler())
	fixture.client = &http.Client{Timeout: 4 * cancellationWait}
	t.Cleanup(func() {
		close(fixture.stop)
		fixture.client.CloseIdleConnections()
		fixture.server.Close()
	})
	return fixture
}

type cancellationReply struct {
	status int
	header http.Header
	body   []byte
	err    error
}

func (fixture *cancellationFixture) post(ctx context.Context, token, body string) cancellationReply {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fixture.server.URL+"/mcp", strings.NewReader(body))
	if err != nil {
		return cancellationReply{err: err}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
	response, err := fixture.client.Do(request)
	if err != nil {
		return cancellationReply{err: err}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	return cancellationReply{status: response.StatusCode, header: response.Header, body: data, err: err}
}

func (fixture *cancellationFixture) start(t *testing.T, token, id string, arguments cancellationArguments) (<-chan cancellationReply, context.CancelFunc) {
	t.Helper()
	params, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	body := `{"jsonrpc":"2.0","id":` + id + `,"method":"tools/call","params":{"name":"fixture_wait","arguments":` + string(params) + `}}`
	ctx, cancel := context.WithTimeout(context.Background(), 4*cancellationWait)
	t.Cleanup(cancel)
	replies := make(chan cancellationReply, 1)
	go func() { replies <- fixture.post(ctx, token, body) }()
	return replies, cancel
}

func (fixture *cancellationFixture) activity(t *testing.T, label string) *cancellationActivity {
	t.Helper()
	select {
	case activity := <-fixture.entered:
		if activity.label != label {
			t.Fatalf("entered %q, want %q", activity.label, label)
		}
		return activity
	case <-time.After(cancellationWait):
		t.Fatalf("public tool %q never started", label)
		return nil
	}
}

func replyWithin(t *testing.T, replies <-chan cancellationReply) cancellationReply {
	t.Helper()
	select {
	case reply := <-replies:
		if reply.err != nil {
			t.Fatal(reply.err)
		}
		return reply
	case <-time.After(cancellationWait):
		t.Fatal("MCP request did not complete")
		return cancellationReply{}
	}
}

func rpcBody(t *testing.T, reply cancellationReply) map[string]json.RawMessage {
	t.Helper()
	data := reply.body
	if strings.HasPrefix(reply.header.Get("Content-Type"), "text/event-stream") {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			if value, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
				data = []byte(value)
				break
			}
		}
		if err := scanner.Err(); err != nil {
			t.Fatal(err)
		}
	}
	var response map[string]json.RawMessage
	if err := json.Unmarshal(data, &response); err != nil {
		t.Fatalf("status%d response %q: %v", reply.status, data, err)
	}
	return response
}

func requireToolState(t *testing.T, reply cancellationReply, expected string) {
	t.Helper()
	if reply.status != 200 {
		t.Fatalf("tool status%d: %s", reply.status, reply.body)
	}
	var result struct {
		Structured struct {
			State string `json:"state"`
		} `json:"structuredContent"`
	}
	if err := json.Unmarshal(rpcBody(t, reply)["result"], &result); err != nil {
		t.Fatal(err)
	}
	if result.Structured.State != expected {
		t.Fatalf("tool state%q, want%q: %s", result.Structured.State, expected, reply.body)
	}
}

func (fixture *cancellationFixture) cancel(t *testing.T, token, id string) {
	t.Helper()
	ctx, stop := context.WithTimeout(context.Background(), cancellationWait)
	defer stop()
	reply := fixture.post(ctx, token, `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":`+id+`}}`)
	if reply.err != nil || reply.status != 202 || len(reply.body) != 0 {
		t.Fatalf("cancel response status%d body%q error%v", reply.status, reply.body, reply.err)
	}
}

func TestMCPCancelsAcrossAuthenticatedRequests(t *testing.T) {
	fixture := newCancellationFixture(t, nil)
	call, _ := fixture.start(t, "caller-a", "7", cancellationArguments{Label: "target", Wait: true})
	activity := fixture.activity(t, "target")
	fixture.cancel(t, "caller-a", "7")
	// This assertion deadline expires before the separate request/client bound.
	// A setup failure cannot substitute for the intended missing-cancel regression.
	select {
	case <-activity.ctx.Done():
	case <-time.After(cancellationWait):
		t.Fatal("authenticated 202 cancellation did not reach the already-running public tool context")
	}
	requireToolState(t, replyWithin(t, call), "cancelled")
}

func TestMCPCancellationSeparatesCallerAndTypedIDs(t *testing.T) {
	fixture := newCancellationFixture(t, nil)
	target, _ := fixture.start(t, "caller-a", "7", cancellationArguments{Label: "number", Wait: true})
	fixture.activity(t, "number")
	text, _ := fixture.start(t, "caller-a", `"7"`, cancellationArguments{Label: "string", Wait: true})
	textActivity := fixture.activity(t, "string")
	other, _ := fixture.start(t, "caller-b", "7", cancellationArguments{Label: "other", Wait: true})
	otherActivity := fixture.activity(t, "other")
	fixture.cancel(t, "caller-a", "7")
	requireToolState(t, replyWithin(t, target), "cancelled")
	textActivity.finish()
	otherActivity.finish()
	requireToolState(t, replyWithin(t, text), "completed")
	requireToolState(t, replyWithin(t, other), "completed")
	fixture.cancel(t, "caller-a", `"unknown"`)
}

func TestMCPRejectsDuplicateInFlightIDAndReusesFinishedID(t *testing.T) {
	fixture := newCancellationFixture(t, nil)
	first, _ := fixture.start(t, "caller-a", "7", cancellationArguments{Label: "first", Wait: true})
	activity := fixture.activity(t, "first")
	duplicate, _ := fixture.start(t, "caller-a", "7.0", cancellationArguments{Label: "duplicate"})
	reply := replyWithin(t, duplicate)
	if reply.status != 409 || !bytes.Contains(reply.body, []byte(`"code":"MCP_REQUEST_IN_FLIGHT"`)) {
		t.Fatalf("duplicate response%d %s", reply.status, reply.body)
	}
	activity.finish()
	requireToolState(t, replyWithin(t, first), "completed")
	reused, _ := fixture.start(t, "caller-a", "7e0", cancellationArguments{Label: "reused", Wait: true})
	fixture.activity(t, "reused")
	fixture.cancel(t, "caller-a", "7")
	requireToolState(t, replyWithin(t, reused), "cancelled")
}

func TestMCPCancellationUsesECMANumberIDs(t *testing.T) {
	for _, test := range []struct{ name, call, cancel string }{
		{"equivalent_lexemes", "7.0", "7e0"},
		{"negative_zero", "-0", "0"},
		{"rounded_integer", "1.0000000000000001", "1"},
		{"underflow_zero", "1e-5000", "-0"},
		{"maximum_safe", "9007199254740991", "9007199254740991.0"},
		{"minimum_safe", "-9007199254740991", "-9007199254740991.0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			call, _ := fixture.start(t, "caller-a", test.call, cancellationArguments{Label: "number", Wait: true})
			fixture.activity(t, "number")
			fixture.cancel(t, "caller-a", test.cancel)
			requireToolState(t, replyWithin(t, call), "cancelled")
		})
	}
}

func TestMCPCancellationOnlyTracksSourceRPCIDs(t *testing.T) {
	for _, test := range []struct {
		name, id string
		tracked  bool
	}{
		{"string", `""`, true}, {"safe", "9007199254740991", true},
		{"unsafe", "9007199254740992", false}, {"fraction", "7.5", false},
		{"overflow", "1e5000", false}, {"null", "null", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			call, _ := fixture.start(t, "caller-a", test.id, cancellationArguments{Label: "identity"})
			replyWithin(t, call)
			want := int32(0)
			if test.tracked {
				want = 1
			}
			if got := fixture.access.identityCalls.Load(); got != want {
				t.Fatalf("identity lookups%d, want%d", got, want)
			}
		})
	}
}

func TestMCPCancellationPreservesUTF16StringIDs(t *testing.T) {
	for _, id := range []string{`"\ud800"`, `"\udc00"`} {
		t.Run(id, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			target, _ := fixture.start(t, "caller-a", id, cancellationArguments{Label: "surrogate", Wait: true})
			fixture.activity(t, "surrogate")
			replacement, _ := fixture.start(t, "caller-a", `"\ufffd"`, cancellationArguments{Label: "replacement", Wait: true})
			other := fixture.activity(t, "replacement")
			fixture.cancel(t, "caller-a", id)
			requireToolState(t, replyWithin(t, target), "cancelled")
			other.finish()
			requireToolState(t, replyWithin(t, replacement), "completed")
		})
	}
}

func TestMCPCancellationPreservesOpaquePrincipalIdentity(t *testing.T) {
	fixture := newCancellationFixture(t, nil)
	target, _ := fixture.start(t, "caller-surrogate", "7", cancellationArguments{Label: "surrogate", Wait: true})
	fixture.activity(t, "surrogate")
	other, _ := fixture.start(t, "caller-replacement", "7", cancellationArguments{Label: "replacement", Wait: true})
	activity := fixture.activity(t, "replacement")
	fixture.cancel(t, "caller-surrogate", "7")
	requireToolState(t, replyWithin(t, target), "cancelled")
	activity.finish()
	requireToolState(t, replyWithin(t, other), "completed")
}

func TestMCPCancellationDoesNotInterceptExtraEnvelopeFields(t *testing.T) {
	for _, extra := range []string{`,"extra":true`, `,"id":null`} {
		t.Run(extra, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			call, _ := fixture.start(t, "caller-a", "7", cancellationArguments{Label: "active", Wait: true})
			activity := fixture.activity(t, "active")
			before := fixture.access.identityCalls.Load()
			reply := fixture.post(context.Background(), "caller-a", `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}`+extra+`}`)
			if reply.err != nil {
				t.Fatal(reply.err)
			}
			if fixture.access.identityCalls.Load() != before {
				t.Fatal("strict cancellation envelope was bypassed")
			}
			activity.finish()
			requireToolState(t, replyWithin(t, call), "completed")
		})
	}
}

func TestMCPCancellationFailsClosedWithoutPrincipalIdentity(t *testing.T) {
	for _, name := range []string{"missing", "failure"} {
		t.Run(name, func(t *testing.T) {
			access := &cancellationAccess{missing: name == "missing"}
			if name == "failure" {
				access.failure = errors.New("isolated identity lookup failure")
			}
			fixture := newCancellationFixture(t, access)
			call, _ := fixture.start(t, "caller-a", "7", cancellationArguments{Label: "denied"})
			reply := replyWithin(t, call)
			if reply.status != 500 || fixture.invocations.Load() != 0 {
				t.Fatalf("missing identity status%d invocations%d", reply.status, fixture.invocations.Load())
			}
			reply = fixture.post(context.Background(), "caller-a", `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}`)
			if reply.err != nil || reply.status != 500 {
				t.Fatalf("identity-less cancel status%d error%v", reply.status, reply.err)
			}
		})
	}
}

func TestMCPDisconnectedRequestReleasesIDBeforeToolReturns(t *testing.T) {
	fixture := newCancellationFixture(t, nil)
	_, disconnect := fixture.start(t, "caller-a", "7", cancellationArguments{Label: "old", Wait: true, IgnoreCancellation: true})
	old := fixture.activity(t, "old")
	disconnect()
	select {
	case <-old.ctx.Done():
	case <-time.After(cancellationWait):
		t.Fatal("disconnection did not cancel the public handler context")
	}
	deadline := time.Now().Add(cancellationWait)
	for {
		probe, _ := fixture.start(t, "caller-a", "7", cancellationArguments{Label: "probe"})
		reply := replyWithin(t, probe)
		if reply.status == 200 {
			requireToolState(t, reply, "completed")
			break
		}
		if reply.status != 409 || time.Now().After(deadline) {
			t.Fatalf("disconnected id did not become reusable: %d %s", reply.status, reply.body)
		}
	}
	reused, _ := fixture.start(t, "caller-a", "7", cancellationArguments{Label: "new", Wait: true})
	fixture.activity(t, "new")
	old.finish()
	fixture.cancel(t, "caller-a", "7")
	requireToolState(t, replyWithin(t, reused), "cancelled")
}
