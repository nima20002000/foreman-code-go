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
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

const batchTestWait = 5 * time.Second

type batchTestPrincipal struct{}

// These credentials and tools belong only to an isolated transport fixture.
type batchTestAccess struct{ authentications atomic.Int32 }

func (access *batchTestAccess) Authenticate(request *http.Request) (context.Context, error) {
	access.authentications.Add(1)
	token := request.Header.Get("Authorization")
	if token != "Bearer reader" && token != "Bearer writer" {
		return nil, domainerror.New("AUTH_REQUIRED", "A fixture credential is required.", 401, nil)
	}
	return context.WithValue(request.Context(), batchTestPrincipal{}, token), nil
}

func (*batchTestAccess) Visible(ctx context.Context, name string) (bool, error) {
	return name != "fixture_write" || ctx.Value(batchTestPrincipal{}) == "Bearer writer", nil
}

func (access *batchTestAccess) Authorize(ctx context.Context, name string, _ json.RawMessage) error {
	visible, err := access.Visible(ctx, name)
	if err != nil {
		return err
	}
	if !visible {
		return domainerror.New("ACCESS_DENIED", "The caller is not authorized for this operation and resource.", 403, nil)
	}
	return nil
}

type batchTestObservation struct {
	callbacks    atomic.Int32
	wrongVersion atomic.Int32
	wrongInput   atomic.Int32
}

func batchEmptyInput(raw json.RawMessage) error {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil || value == nil || len(value) != 0 {
		return domainerror.New("INVALID_REQUEST", "The fixture requires an empty object.", 400, nil)
	}
	return nil
}

func newBatchTestRegistry(t *testing.T, options mcpserver.Options) (*mcpserver.Registry, *batchTestAccess, *batchTestObservation) {
	t.Helper()
	access := &batchTestAccess{}
	options.Access = access
	registry := mcpserver.New(options)
	observed := &batchTestObservation{}
	registry.RegisterTool(&mcp.Tool{Name: "fixture_id", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		batchEmptyInput, func(_ context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			observed.callbacks.Add(1)
			if request.Session.InitializeParams().ProtocolVersion != "2025-11-25" ||
				request.Extra.Header.Get("Mcp-Protocol-Version") != "2025-11-25" {
				observed.wrongVersion.Add(1)
			}
			if request.Params.Name != "fixture_id" || !bytes.Equal(request.Params.Arguments, []byte("{}")) {
				observed.wrongInput.Add(1)
			}
			const label = `payload � and literal text "id":"�" must survive`
			return &mcp.CallToolResult{
				Content:           []mcp.Content{&mcp.TextContent{Text: label}},
				StructuredContent: map[string]any{"label": label, "id": "�"},
			}, nil
		})
	return registry, access, observed
}

func batchTestRequest(ctx context.Context, url, token, body string) *http.Request {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		panic(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func batchRecorded(t *testing.T, registry *mcpserver.Registry, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	request := batchTestRequest(ctx, "http://isolated-fixture.invalid/mcp", token, body)
	recorder := httptest.NewRecorder()
	httpserver.ErrorHandler{}.Wrap(registry.Handle).ServeHTTP(recorder, request)
	return recorder
}

type batchOracleOutcome struct {
	ID      string `json:"id"`
	Mode    string `json:"mode"`
	Request struct {
		Body    string            `json:"body"`
		Headers map[string]string `json:"headers"`
	} `json:"request"`
	Callbacks []json.RawMessage `json:"callbacks"`
	Response  struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	} `json:"response"`
}

func batchOracleRows(t *testing.T, mode string) []batchOracleOutcome {
	t.Helper()
	data, err := os.ReadFile("testdata/ts-batch-transport.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Outcomes []batchOracleOutcome `json:"outcomes"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	var rows []batchOracleOutcome
	for _, row := range fixture.Outcomes {
		if row.Mode == mode {
			rows = append(rows, row)
		}
	}
	if len(rows) != 3 {
		t.Fatalf("frozen %s outcomes = %d, want 3", mode, len(rows))
	}
	return rows
}

// This file uses only APIs already present at 877578b8. It can be overlaid
// unchanged on that exact pre-fix source; JSON-option tests live separately.
func TestMCPFrozenBatchOracle(t *testing.T) {
	for _, row := range batchOracleRows(t, "default-sse") {
		t.Run(row.ID, func(t *testing.T) {
			runBatchOracleRow(t, row, mcpserver.Options{})
		})
	}
}

func runBatchOracleRow(t *testing.T, row batchOracleOutcome, options mcpserver.Options) {
	t.Helper()
	registry, access, observed := newBatchTestRegistry(t, options)
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	request := batchTestRequest(ctx, "http://isolated-fixture.invalid/mcp", "reader", row.Request.Body)
	for key, value := range row.Request.Headers {
		if key == "host" {
			request.Host = value
		} else {
			request.Header.Set(key, value)
		}
	}
	recorder := httptest.NewRecorder()
	httpserver.ErrorHandler{}.Wrap(registry.Handle).ServeHTTP(recorder, request)
	// The authentic unsupported SDK path reaches this public assertion directly.
	// No callback handshake or added API can turn the old red into setup failure.
	if recorder.Code != row.Response.Status || int(observed.callbacks.Load()) != len(row.Callbacks) {
		t.Fatalf("batch HTTP status %d, callbacks %d; frozen wants %d/%d; body %q",
			recorder.Code, observed.callbacks.Load(), row.Response.Status, len(row.Callbacks), recorder.Body.String())
	}
	if access.authentications.Load() != 1 || observed.wrongVersion.Load() != 0 || observed.wrongInput.Load() != 0 {
		t.Fatalf("authentication/protocol/input observations = %d/%d/%d",
			access.authentications.Load(), observed.wrongVersion.Load(), observed.wrongInput.Load())
	}
	wantType := row.Response.Headers["content-type"]
	for key, expected := range row.Response.Headers {
		if actual := recorder.Header().Get(key); actual != expected {
			t.Fatalf("response header %s = %q, want %q", key, actual, expected)
		}
	}
	want := batchMessages(t, wantType, []byte(row.Response.Body))
	got := batchMessages(t, recorder.Header().Get("Content-Type"), recorder.Body.Bytes())
	if wantType == "text/event-stream" {
		// Frozen TS emits completion-order SSE. Its immediate fixture happened
		// to finish in input order; Go scheduling must not weaken identity,
		// cardinality or complete result association. Delayed order is tested below.
		assertBatchMessageSet(t, got, want)
	} else {
		assertBatchMessageOrder(t, got, want)
	}
}

func batchMessages(t *testing.T, contentType string, body []byte) []json.RawMessage {
	t.Helper()
	if strings.HasPrefix(contentType, "text/event-stream") {
		var result []json.RawMessage
		scanner := bufio.NewScanner(bytes.NewReader(body))
		scanner.Buffer(make([]byte, 4096), 2*1024*1024)
		for scanner.Scan() {
			if data, ok := strings.CutPrefix(scanner.Text(), "data: "); ok && data != "" {
				result = append(result, json.RawMessage(data))
			}
		}
		if err := scanner.Err(); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if bytes.HasPrefix(bytes.TrimSpace(body), []byte("[")) {
		var result []json.RawMessage
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatalf("invalid JSON response %q: %v", body, err)
		}
		return result
	}
	if !json.Valid(body) {
		t.Fatalf("invalid JSON response %q", body)
	}
	return []json.RawMessage{append(json.RawMessage(nil), body...)}
}

func batchPublicValue(t *testing.T, raw []byte) any {
	t.Helper()
	value, err := jsonvalue.Parse(raw)
	if err != nil {
		t.Fatalf("invalid lossless JSON response %q: %v", raw, err)
	}
	return batchComparable(value)
}

func batchComparable(value any) any {
	switch item := value.(type) {
	case jsonvalue.Object:
		result := make(map[string]any, len(item))
		for _, member := range item {
			result[member.Key.IdentityKey()] = batchComparable(member.Value)
		}
		return result
	case []any:
		result := make([]any, len(item))
		for i, member := range item {
			result[i] = batchComparable(member)
		}
		return result
	default:
		return value
	}
}

func batchResponseKey(t *testing.T, raw []byte) string {
	t.Helper()
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	value, err := jsonvalue.Parse(envelope["id"])
	if err != nil {
		t.Fatalf("response ID %q: %v", envelope["id"], err)
	}
	switch id := value.(type) {
	case jsonvalue.UTF16String:
		return "string:" + id.IdentityKey()
	case json.Number:
		return "number:" + string(id)
	case nil:
		return "null"
	default:
		t.Fatalf("unexpected response ID %q", envelope["id"])
		return ""
	}
}

func assertBatchMessageSet(t *testing.T, got, want []json.RawMessage) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("response count %d, want %d", len(got), len(want))
	}
	expected := make(map[string]json.RawMessage, len(want))
	for _, message := range want {
		expected[batchResponseKey(t, message)] = message
	}
	for _, message := range got {
		key := batchResponseKey(t, message)
		reference, exists := expected[key]
		if !exists || !reflect.DeepEqual(batchPublicValue(t, message), batchPublicValue(t, reference)) {
			t.Fatalf("missing, duplicate, unexpected or changed response %s; expected %s", message, reference)
		}
		delete(expected, key)
	}
	if len(expected) != 0 {
		t.Fatalf("missing %d response IDs", len(expected))
	}
}

func assertBatchMessageOrder(t *testing.T, got, want []json.RawMessage) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("response count %d, want %d", len(got), len(want))
	}
	for i := range want {
		if !reflect.DeepEqual(batchPublicValue(t, got[i]), batchPublicValue(t, want[i])) {
			t.Fatalf("response %d = %s, want %s", i, got[i], want[i])
		}
	}
}

type batchCountingBody struct {
	io.Reader
	reads atomic.Int32
}

func (body *batchCountingBody) Read(data []byte) (int, error) {
	body.reads.Add(1)
	return body.Reader.Read(data)
}

func (*batchCountingBody) Close() error { return nil }

func TestMCPBatchAuthenticationPrecedesBodyRead(t *testing.T) {
	registry, access, observed := newBatchTestRegistry(t, mcpserver.Options{})
	body := &batchCountingBody{Reader: strings.NewReader(`[{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}]`)}
	request := batchTestRequest(context.Background(), "http://isolated-fixture.invalid/mcp", "", "")
	request.Body = body
	recorder := httptest.NewRecorder()
	httpserver.ErrorHandler{}.Wrap(registry.Handle).ServeHTTP(recorder, request)
	if recorder.Code != 401 || body.reads.Load() != 0 || observed.callbacks.Load() != 0 || access.authentications.Load() != 1 {
		t.Fatalf("unauthenticated batch status/reads/callbacks/auth = %d/%d/%d/%d",
			recorder.Code, body.reads.Load(), observed.callbacks.Load(), access.authentications.Load())
	}
}

func TestMCPBatchBodyLimitIsAggregate(t *testing.T) {
	const member = `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}`
	registry, access, observed := newBatchTestRegistry(t, mcpserver.Options{MaxRequestBodyBytes: int64(len(member) + 2)})
	recorder := batchRecorded(t, registry, "reader", "["+member+","+member+"]")
	if recorder.Code != 413 || observed.callbacks.Load() != 0 || access.authentications.Load() != 1 {
		t.Fatalf("oversized aggregate status/callbacks/auth = %d/%d/%d", recorder.Code, observed.callbacks.Load(), access.authentications.Load())
	}
}

func TestMCPBatchAdmitsLooseUTF16Params(t *testing.T) {
	registry, access, observed := newBatchTestRegistry(t, mcpserver.Options{})
	body := `[{"jsonrpc":"2.0","id":"\ud800","method":"tools/call","params":{"name":"fixture_id","arguments":{},"\ud800":{"kept":true},"_meta":{"\udc00":{"kept":true}}}}]`
	recorder := batchRecorded(t, registry, "reader", body)
	if recorder.Code != 200 || observed.callbacks.Load() != 1 || access.authentications.Load() != 1 ||
		observed.wrongInput.Load() != 0 || observed.wrongVersion.Load() != 0 {
		t.Fatalf("loose UTF-16 params status/callbacks/auth/input/version = %d/%d/%d/%d/%d; body %q",
			recorder.Code, observed.callbacks.Load(), access.authentications.Load(), observed.wrongInput.Load(),
			observed.wrongVersion.Load(), recorder.Body.String())
	}
	messages := batchMessages(t, recorder.Header().Get("Content-Type"), recorder.Body.Bytes())
	if len(messages) != 1 {
		t.Fatalf("loose UTF-16 params response count %d, want 1", len(messages))
	}
	response := batchResponseByID(t, messages, `"\ud800"`)
	if _, failed := response["error"]; failed || len(response["result"]) == 0 {
		t.Fatalf("loose UTF-16 params were not admitted: %#v", response)
	}
}

func TestMCPBatchSDKErrorKeepsPublicID(t *testing.T) {
	for _, id := range []string{"7", `"\ud800"`} {
		t.Run(id, func(t *testing.T) {
			registry, access, observed := newBatchTestRegistry(t, mcpserver.Options{})
			body := `[{"jsonrpc":"2.0","id":` + id + `,"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}]`
			request := batchTestRequest(context.Background(), "http://isolated-fixture.invalid/mcp", "reader", body)
			request.Header.Set("Mcp-Method", "tools/list")
			recorder := httptest.NewRecorder()
			httpserver.ErrorHandler{}.Wrap(registry.Handle).ServeHTTP(recorder, request)
			if recorder.Code != 400 || observed.callbacks.Load() != 0 || access.authentications.Load() != 1 {
				t.Fatalf("SDK header error status/callbacks/auth = %d/%d/%d", recorder.Code, observed.callbacks.Load(), access.authentications.Load())
			}
			messages := batchMessages(t, recorder.Header().Get("Content-Type"), recorder.Body.Bytes())
			if len(messages) != 1 {
				t.Fatalf("SDK header error response count %d, want 1", len(messages))
			}
			response := batchResponseByID(t, messages, id)
			var failure struct{ Code int `json:"code"` }
			if err := json.Unmarshal(response["error"], &failure); err != nil || failure.Code != mcp.CodeHeaderMismatch {
				t.Fatalf("SDK header error = %s, decode error %v", response["error"], err)
			}
		})
	}
}

func TestMCPBatchPreservesSDKCloseEvent(t *testing.T) {
	registry, _, _ := newBatchTestRegistry(t, mcpserver.Options{})
	var callbacks atomic.Int32
	registry.RegisterTool(&mcp.Tool{Name: "fixture_close", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		batchEmptyInput, func(_ context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			callbacks.Add(1)
			if request.Extra == nil || request.Extra.CloseSSEStream == nil {
				return nil, errors.New("sdk did not expose its stream close callback")
			}
			request.Extra.CloseSSEStream(mcp.CloseSSEStreamArgs{RetryAfter: time.Second})
			return mcpserver.ToolResult(map[string]any{"closed": true})
		})
	recorder := batchRecorded(t, registry, "reader",
		`[{"jsonrpc":"2.0","id":"\ud800","method":"tools/call","params":{"name":"fixture_close","arguments":{}}}]`)
	body := recorder.Body.String()
	if recorder.Code != 200 || callbacks.Load() != 1 || !strings.Contains(body, "event: close\n") ||
		!strings.Contains(body, "retry: 1000\n") || !strings.Contains(body, "data: \n\n") {
		t.Fatalf("SDK close event status/callbacks/body = %d/%d/%q", recorder.Code, callbacks.Load(), body)
	}
}

func batchResponseByID(t *testing.T, messages []json.RawMessage, id string) map[string]json.RawMessage {
	t.Helper()
	wanted := batchResponseKey(t, []byte(`{"id":`+id+`}`))
	for _, message := range messages {
		if batchResponseKey(t, message) == wanted {
			var result map[string]json.RawMessage
			if err := json.Unmarshal(message, &result); err != nil {
				t.Fatal(err)
			}
			return result
		}
	}
	t.Fatalf("missing response ID %s", id)
	return nil
}

func TestMCPBatchReadOnlyCatalogAndDenial(t *testing.T) {
	registry, access, _ := newBatchTestRegistry(t, mcpserver.Options{})
	var writes atomic.Int32
	for _, name := range []string{"fixture_read", "fixture_write"} {
		registry.RegisterTool(&mcp.Tool{Name: name, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
			batchEmptyInput, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				if name == "fixture_write" {
					writes.Add(1)
				}
				return mcpserver.ToolResult(map[string]any{"value": writes.Load()})
			})
	}
	body := `[{"jsonrpc":"2.0","id":7,"method":"tools/list"},{"jsonrpc":"2.0","id":"\ud800","method":"tools/call","params":{"name":"fixture_write","arguments":{}}},{"jsonrpc":"2.0","id":"7","method":"tools/call","params":{"name":"fixture_read","arguments":{}}}]`
	recorder := batchRecorded(t, registry, "reader", body)
	if recorder.Code != 200 || writes.Load() != 0 || access.authentications.Load() != 1 {
		t.Fatalf("read-only batch status/writes/auth = %d/%d/%d", recorder.Code, writes.Load(), access.authentications.Load())
	}
	messages := batchMessages(t, recorder.Header().Get("Content-Type"), recorder.Body.Bytes())
	if len(messages) != 3 {
		t.Fatalf("read-only response count %d, want 3", len(messages))
	}
	var catalog struct {
		Tools []struct{ Name string `json:"name"` } `json:"tools"`
	}
	if err := json.Unmarshal(batchResponseByID(t, messages, "7")["result"], &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Tools) != 2 {
		t.Fatalf("visible catalog = %#v", catalog.Tools)
	}
	for _, tool := range catalog.Tools {
		if tool.Name == "fixture_write" {
			t.Fatal("read-only batch catalog exposed hidden write")
		}
	}
	var denied struct {
		IsError           bool            `json:"isError"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		Content           []struct{ Text string `json:"text"` } `json:"content"`
	}
	if err := json.Unmarshal(batchResponseByID(t, messages, `"\ud800"`)["result"], &denied); err != nil {
		t.Fatal(err)
	}
	if !denied.IsError || len(denied.StructuredContent) != 0 || len(denied.Content) != 1 {
		t.Fatalf("hidden write result = %#v", denied)
	}
	var publicError struct {
		Error struct{ Code string `json:"code"` } `json:"error"`
	}
	if err := json.Unmarshal([]byte(denied.Content[0].Text), &publicError); err != nil || publicError.Error.Code != "ACCESS_DENIED" {
		t.Fatalf("hidden write denial = %q, error %v", denied.Content[0].Text, err)
	}
	var readback struct {
		StructuredContent struct{ Value int32 `json:"value"` } `json:"structuredContent"`
	}
	if err := json.Unmarshal(batchResponseByID(t, messages, `"7"`)["result"], &readback); err != nil || readback.StructuredContent.Value != 0 {
		t.Fatalf("readback = %#v, error %v", readback, err)
	}
}

func TestMCPBatchUnknownMethodKeepsOtherResponses(t *testing.T) {
	runBatchUnknownMethod(t, mcpserver.Options{})
}

func runBatchUnknownMethod(t *testing.T, options mcpserver.Options) {
	t.Helper()
	registry, _, observed := newBatchTestRegistry(t, options)
	body := `[{"jsonrpc":"2.0","id":7,"method":"fixture/unknown","params":{}},{"jsonrpc":"2.0","id":"\ud800","method":"tools/call","params":{"name":"fixture_id","arguments":{}}}]`
	recorder := batchRecorded(t, registry, "reader", body)
	if recorder.Code != 200 || observed.callbacks.Load() != 1 {
		t.Fatalf("mixed batch status/callbacks = %d/%d, body %q", recorder.Code, observed.callbacks.Load(), recorder.Body.String())
	}
	messages := batchMessages(t, recorder.Header().Get("Content-Type"), recorder.Body.Bytes())
	if len(messages) != 2 {
		t.Fatalf("mixed response count %d, want 2", len(messages))
	}
	failure := batchResponseByID(t, messages, "7")
	if _, exists := failure["result"]; exists {
		t.Fatalf("unknown method returned a result: %s", failure["result"])
	}
	var rpcError struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(failure["error"], &rpcError); err != nil || rpcError.Code != -32601 || rpcError.Message != "Method not found" {
		t.Fatalf("unknown method error = %#v, decode error %v", rpcError, err)
	}
	success := batchResponseByID(t, messages, `"\ud800"`)
	if _, exists := success["error"]; exists || len(success["result"]) == 0 {
		t.Fatalf("unrelated successful result changed: %#v", success)
	}
}

type batchTestActivity struct {
	label   string
	ctx     context.Context
	session *mcp.ServerSession
}

func batchRegisterWaitingTool(t *testing.T, registry *mcpserver.Registry, entered chan<- batchTestActivity, releases map[string]<-chan struct{}) {
	t.Helper()
	registry.RegisterTool(&mcp.Tool{Name: "fixture_wait", InputSchema: json.RawMessage(`{"type":"object","properties":{"label":{"type":"string"}},"required":["label"],"additionalProperties":false}`)},
		func(raw json.RawMessage) error {
			var input struct{ Label string `json:"label"` }
			if err := json.Unmarshal(raw, &input); err != nil || input.Label == "" {
				return errors.New("fixture label is required")
			}
			return nil
		}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input struct{ Label string `json:"label"` }
			if err := json.Unmarshal(request.Params.Arguments, &input); err != nil {
				return nil, err
			}
			entered <- batchTestActivity{label: input.Label, ctx: ctx, session: request.Session}
			select {
			case <-releases[input.Label]:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return mcpserver.ToolResult(map[string]any{"label": input.Label})
		})
}

func batchAwaitActivities(t *testing.T, entered <-chan batchTestActivity, count int) map[string]batchTestActivity {
	t.Helper()
	result := make(map[string]batchTestActivity, count)
	timer := time.NewTimer(batchTestWait)
	defer timer.Stop()
	for len(result) < count {
		select {
		case activity := <-entered:
			if _, exists := result[activity.label]; exists {
				t.Fatalf("duplicate callback label %q", activity.label)
			}
			result[activity.label] = activity
		case <-timer.C:
			t.Fatalf("only %d/%d callbacks entered", len(result), count)
		}
	}
	return result
}

type batchHTTPReply struct {
	response *http.Response
	err      error
}

func batchStartHTTP(client *http.Client, request *http.Request) <-chan batchHTTPReply {
	replies := make(chan batchHTTPReply, 1)
	go func() {
		response, err := client.Do(request)
		replies <- batchHTTPReply{response: response, err: err}
	}()
	return replies
}

func batchAwaitHTTP(t *testing.T, replies <-chan batchHTTPReply) *http.Response {
	t.Helper()
	select {
	case reply := <-replies:
		if reply.err != nil {
			t.Fatal(reply.err)
		}
		return reply.response
	case <-time.After(batchTestWait):
		t.Fatal("batch HTTP response timed out")
		return nil
	}
}

func TestMCPBatchCancellationStaysWithinHTTPRequest(t *testing.T) {
	registry, access, _ := newBatchTestRegistry(t, mcpserver.Options{})
	entered := make(chan batchTestActivity, 3)
	otherRelease := make(chan struct{})
	var releaseOnce sync.Once
	releaseOther := func() { releaseOnce.Do(func() { close(otherRelease) }) }
	batchRegisterWaitingTool(t, registry, entered, map[string]<-chan struct{}{"other": otherRelease})
	server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	otherCtx, cancelOther := context.WithTimeout(context.Background(), batchTestWait)
	t.Cleanup(func() {
		cancel()
		cancelOther()
		releaseOther()
		server.Close()
	})
	first := batchStartHTTP(server.Client(), batchTestRequest(ctx, server.URL, "reader",
		`[{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"first"}}},{"jsonrpc":"2.0","id":"7","method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"second"}}}]`))
	other := batchStartHTTP(server.Client(), batchTestRequest(otherCtx, server.URL, "reader",
		`[{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"other"}}}]`))
	activities := batchAwaitActivities(t, entered, 3)
	cancel()
	for _, label := range []string{"first", "second"} {
		select {
		case <-activities[label].ctx.Done():
		case <-time.After(batchTestWait):
			t.Fatalf("%s tool context was not canceled", label)
		}
	}
	select {
	case reply := <-first:
		if reply.response != nil {
			reply.response.Body.Close()
		}
	case <-time.After(batchTestWait):
		t.Fatal("canceled batch HTTP request did not finish")
	}
	select {
	case <-activities["other"].ctx.Done():
		t.Fatal("canceling one batch canceled an independent request with the same ID")
	default:
	}
	releaseOther()
	response := batchAwaitHTTP(t, other)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || access.authentications.Load() != 2 {
		t.Fatalf("independent batch status/auth/error = %d/%d/%v", response.StatusCode, access.authentications.Load(), err)
	}
	messages := batchMessages(t, response.Header.Get("Content-Type"), body)
	if len(messages) != 1 || len(batchResponseByID(t, messages, "7")["result"]) == 0 {
		t.Fatalf("independent response = %q", body)
	}
}

func TestMCPBatchCompletionOrder(t *testing.T) {
	runBatchCompletionOrder(t, mcpserver.Options{}, false)
}

func runBatchCompletionOrder(t *testing.T, options mcpserver.Options, jsonMode bool) {
	t.Helper()
	registry, _, _ := newBatchTestRegistry(t, options)
	entered := make(chan batchTestActivity, 2)
	firstRelease, secondRelease := make(chan struct{}), make(chan struct{})
	var firstOnce, secondOnce sync.Once
	releaseFirst := func() { firstOnce.Do(func() { close(firstRelease) }) }
	releaseSecond := func() { secondOnce.Do(func() { close(secondRelease) }) }
	batchRegisterWaitingTool(t, registry, entered, map[string]<-chan struct{}{"first": firstRelease, "second": secondRelease})
	server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	t.Cleanup(func() {
		cancel()
		releaseFirst()
		releaseSecond()
		server.Close()
	})
	replies := batchStartHTTP(server.Client(), batchTestRequest(ctx, server.URL, "reader",
		`[{"jsonrpc":"2.0","id":"\ud800","method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"first"}}},{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"second"}}}]`))
	activities := batchAwaitActivities(t, entered, 2)
	releaseSecond()
	if jsonMode {
		// For this pinned SDK route, an ephemeral member session closes only
		// after its HTTP response has been delivered. Observe that public
		// lifecycle before releasing the first tool; a pre-return callback
		// signal would still race response serialization. The final HTTP
		// assertions below determine success, independently of Wait's error.
		secondClosed := make(chan struct{})
		go func() {
			_ = activities["second"].session.Wait()
			close(secondClosed)
		}()
		t.Cleanup(func() {
			cancel()
			select {
			case <-secondClosed:
			case <-time.After(batchTestWait):
				t.Error("second SDK session did not close during cleanup")
			}
		})
		select {
		case <-secondClosed:
		case <-ctx.Done():
			t.Fatal("second SDK delivery did not complete while first was blocked")
		}
		if ctx.Err() != nil || activities["first"].ctx.Err() != nil {
			t.Fatal("first tool or original request ended before its release")
		}
		select {
		case reply := <-replies:
			if reply.response != nil {
				reply.response.Body.Close()
			}
			t.Fatalf("JSON batch returned before first tool completed: %v", reply.err)
		default:
		}
		releaseFirst()
		response := batchAwaitHTTP(t, replies)
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != 200 || response.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("JSON batch status/type/error = %d/%q/%v", response.StatusCode, response.Header.Get("Content-Type"), err)
		}
		messages := batchMessages(t, "application/json", body)
		if len(messages) != 2 || batchResponseKey(t, messages[0]) != batchResponseKey(t, []byte(`{"id":"\ud800"}`)) ||
			batchResponseKey(t, messages[1]) != batchResponseKey(t, []byte(`{"id":7}`)) {
			t.Fatalf("JSON batch did not preserve input order: %s", body)
		}
		return
	}
	// The second member must be visible while the first is still blocked.
	response := batchAwaitHTTP(t, replies)
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("SSE batch status/type = %d/%q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	scanner := bufio.NewScanner(response.Body)
	var messages []json.RawMessage
	for scanner.Scan() {
		if data, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
			messages = append(messages, json.RawMessage(data))
			break
		}
	}
	if len(messages) != 1 || batchResponseKey(t, messages[0]) != batchResponseKey(t, []byte(`{"id":7}`)) {
		t.Fatalf("later completion was not streamed first: %q; error %v", messages, scanner.Err())
	}
	releaseFirst()
	for scanner.Scan() {
		if data, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
			messages = append(messages, json.RawMessage(data))
		}
	}
	if err := scanner.Err(); err != nil || len(messages) != 2 ||
		batchResponseKey(t, messages[1]) != batchResponseKey(t, []byte(`{"id":"\ud800"}`)) {
		t.Fatalf("remaining SSE completion = %q, error %v", messages, err)
	}
}
