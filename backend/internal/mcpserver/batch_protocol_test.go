package mcpserver_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

func batchProtocolModes(t *testing.T, run func(*testing.T, mcpserver.Options)) {
	t.Helper()
	for _, mode := range []struct {
		name string
		json bool
	}{{"sse", false}, {"json", true}} {
		t.Run(mode.name, func(t *testing.T) { run(t, mcpserver.Options{JSONResponse: mode.json}) })
	}
}

// These public tests use only APIs present at the exact pre-fix 98c46ed2.
// The same file is overlaid unchanged on the immutable old witness.
func TestMCPBatchInitializeRejectsSiblingBeforeCallbacks(t *testing.T) {
	batchProtocolModes(t, func(t *testing.T, options mcpserver.Options) {
		for _, test := range []struct {
			name string
			init string
		}{
			{"request", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}`},
			{"notification", `{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}`},
			{"record_proto_keys", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"experimental":{"__proto__":false,"fixture":{"__proto__":1e999}},"extensions":{"__proto__":null}},"clientInfo":{"name":"fixture","version":"1"}}}`},
			{"extended", `{"jsonrpc":"2.0","id":"\ud800","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"experimental":{"fixture":{"nested":[null,true,7,"\ud800"]}},"sampling":{"context":{},"tools":{}},"roots":{"listChanged":true},"elicitation":{"form":{"applyDefaults":false},"url":{}},"tasks":{"list":{},"cancel":{},"requests":{"sampling":{"createMessage":{}},"elicitation":{"create":{}}}},"extensions":{"fixture/one":{}}},"clientInfo":{"name":"fixture","version":"1","title":"\ud800","description":"fixture","websiteUrl":"fixture:","icons":[{"src":"fixture:","mimeType":"image/png","sizes":["any"],"theme":"dark"}]}}}`},
		} {
			t.Run(test.name, func(t *testing.T) {
				registry, access, observed := newBatchTestRegistry(t, options)
				body := `[` + test.init + `,{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}]`
				server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
				t.Cleanup(server.Close)
				ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
				defer cancel()
				response, err := server.Client().Do(batchTestRequest(ctx, server.URL, "reader", body))
				if err != nil {
					t.Fatalf("initialize batch HTTP failed or aborted: %v", err)
				}
				defer response.Body.Close()
				responseBody, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatalf("initialize batch response aborted: %v", err)
				}
				const expected = `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request: Only one initialization request is allowed"}}`
				if response.StatusCode != http.StatusBadRequest || response.Header.Get("Content-Type") != "application/json" ||
					observed.callbacks.Load() != 0 || access.authentications.Load() != 1 {
					t.Fatalf("initialize batch status/type/callbacks/auth = %d/%q/%d/%d; body %q", response.StatusCode,
						response.Header.Get("Content-Type"), observed.callbacks.Load(), access.authentications.Load(), responseBody)
				}
				if !reflect.DeepEqual(batchPublicValue(t, responseBody), batchPublicValue(t, []byte(expected))) {
					t.Fatalf("initialize batch error = %s, want full error %s", responseBody, expected)
				}
			})
		}
	})
}

func TestMCPBatchInitializeGuardChecksOptionalFields(t *testing.T) {
	batchProtocolModes(t, func(t *testing.T, options mcpserver.Options) {
		registry, _, observed := newBatchTestRegistry(t, options)
		// title:null is invalid under the frozen InitializeRequestSchema even
		// though its required fields are present. It must not trigger the
		// whole-batch initialization guard or prevent the valid sibling call.
		body := `[{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1","title":null}}},{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}]`
		recorder := batchRecorded(t, registry, "reader", body)
		if recorder.Code != http.StatusOK || observed.callbacks.Load() != 1 {
			t.Fatalf("malformed initialize blocked sibling: status/callbacks = %d/%d; body %q", recorder.Code, observed.callbacks.Load(), recorder.Body.String())
		}
		messages := batchMessages(t, recorder.Header().Get("Content-Type"), recorder.Body.Bytes())
		if len(batchResponseByID(t, messages, "7")["result"]) == 0 {
			t.Fatal("valid sibling lost its response")
		}
	})
}

func TestMCPBatchUnknownNotificationKeepsSiblingAndPersistedReadback(t *testing.T) {
	batchProtocolModes(t, func(t *testing.T, options mcpserver.Options) {
		for _, test := range []struct{ name, notification string }{
			{"unknown", `{"jsonrpc":"2.0","method":"fixture/unknown","params":{}}`},
			{"request_only_list", `{"jsonrpc":"2.0","method":"tools/list","params":{}}`},
			{"request_only_call", `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"fixture_id","arguments":{}}}`},
			{"progress_without_params", `{"jsonrpc":"2.0","method":"notifications/progress"}`},
		} {
			t.Run(test.name, func(t *testing.T) { batchRunIgnoredNotification(t, options, test.notification) })
		}
	})
}

func batchRunIgnoredNotification(t *testing.T, options mcpserver.Options, notification string) {
	t.Helper()
	access := &batchTestAccess{}
	options.Access = access
	registry := mcpserver.New(options)
	var callbacks atomic.Int32
	statePath := filepath.Join(t.TempDir(), "fixture-state.json")
	registry.RegisterTool(&mcp.Tool{Name: "fixture_id", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		batchEmptyInput, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			count := callbacks.Add(1)
			data, err := json.Marshal(map[string]any{"count": count})
			if err != nil {
				return nil, err
			}
			if err := os.WriteFile(statePath, data, 0600); err != nil {
				return nil, err
			}
			return mcpserver.ToolResult(map[string]any{"count": count})
		})
	registry.RegisterTool(&mcp.Tool{Name: "fixture_read", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		batchEmptyInput, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			data, err := os.ReadFile(statePath)
			if err != nil {
				return nil, err
			}
			var state map[string]any
			if err := json.Unmarshal(data, &state); err != nil {
				return nil, err
			}
			return mcpserver.ToolResult(state)
		})
	server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	body := `[` + notification + `,{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}]`
	messages := batchProtocolExchange(t, server, batchTestRequest(ctx, server.URL, "writer", body), options.JSONResponse)
	if len(messages) != 1 || callbacks.Load() != 1 {
		t.Fatalf("unknown notification sibling responses/callbacks = %d/%d", len(messages), callbacks.Load())
	}
	batchAssertStoredCount(t, batchResponseByID(t, messages, "7"), 1)
	readback := `[{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"fixture_read","arguments":{}}}]`
	messages = batchProtocolExchange(t, server, batchTestRequest(ctx, server.URL, "writer", readback), options.JSONResponse)
	if len(messages) != 1 || callbacks.Load() != 1 || access.authentications.Load() != 2 {
		t.Fatalf("public persisted readback responses/callbacks/auth = %d/%d/%d", len(messages), callbacks.Load(), access.authentications.Load())
	}
	batchAssertStoredCount(t, batchResponseByID(t, messages, "8"), 1)
}

func batchProtocolExchange(t *testing.T, server *httptest.Server, request *http.Request, jsonMode bool) []json.RawMessage {
	t.Helper()
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("batch HTTP failed or aborted: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	wantType := "text/event-stream"
	if jsonMode {
		wantType = "application/json"
	}
	if err != nil || response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != wantType {
		t.Fatalf("batch status/type/read error = %d/%q/%v; body %q", response.StatusCode, response.Header.Get("Content-Type"), err, body)
	}
	return batchMessages(t, wantType, body)
}

func TestMCPBatchIgnoredNotificationPreservesSDKHTTPGates(t *testing.T) {
	batchProtocolModes(t, func(t *testing.T, options mcpserver.Options) {
		for _, test := range []struct {
			name   string
			status int
			change func(*http.Request)
		}{
			{"missing_accept", http.StatusBadRequest, func(r *http.Request) { r.Header.Del("Accept") }},
			{"invalid_protocol", http.StatusBadRequest, func(r *http.Request) { r.Header.Set("Mcp-Protocol-Version", "fixture-invalid") }},
			{"post_event_id", http.StatusBadRequest, func(r *http.Request) { r.Header.Set("Last-Event-ID", "fixture-event") }},
			{"method_header", http.StatusBadRequest, func(r *http.Request) { r.Header.Set("Mcp-Method", "tools/list") }},
		} {
			t.Run(test.name, func(t *testing.T) {
				registry, access, observed := newBatchTestRegistry(t, options)
				server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
				t.Cleanup(server.Close)
				ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
				defer cancel()
				const call = `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}`
				var firstBody []byte
				var firstType string
				for i, body := range []string{
					`[` + call + `]`,
					`[{"jsonrpc":"2.0","method":"fixture/unknown","params":{}},` + call + `]`,
				} {
					request := batchTestRequest(ctx, server.URL, "reader", body)
					test.change(request)
					response, err := server.Client().Do(request)
					if err != nil {
						t.Fatalf("SDK admission response failed: %v", err)
					}
					data, err := io.ReadAll(response.Body)
					response.Body.Close()
					if err != nil || response.StatusCode != test.status || observed.callbacks.Load() != 0 {
						t.Fatalf("SDK gate status/callbacks/error = %d/%d/%v; body %s", response.StatusCode, observed.callbacks.Load(), err, data)
					}
					if i == 0 {
						firstBody, firstType = data, response.Header.Get("Content-Type")
					} else if string(data) != string(firstBody) || response.Header.Get("Content-Type") != firstType {
						t.Fatalf("ignored notification changed full SDK gate response: type/body %q/%s; want %q/%s", response.Header.Get("Content-Type"), data, firstType, firstBody)
					}
				}
				if access.authentications.Load() != 2 {
					t.Fatalf("SDK admission changed authentication count: %d", access.authentications.Load())
				}
			})
		}
	})
}

func batchAssertStoredCount(t *testing.T, response map[string]json.RawMessage, expected int) {
	t.Helper()
	if len(response["error"]) != 0 {
		t.Fatalf("unexpected RPC error: %s", response["error"])
	}
	var result struct {
		IsError           bool `json:"isError"`
		StructuredContent struct {
			Count int `json:"count"`
		} `json:"structuredContent"`
	}
	if err := json.Unmarshal(response["result"], &result); err != nil || result.IsError || result.StructuredContent.Count != expected {
		t.Fatalf("public persisted result = %s; decode error %v", response["result"], err)
	}
}

func TestMCPBatchCancellationTargetsPublicIDAndKeepsHTTPPending(t *testing.T) {
	batchProtocolModes(t, func(t *testing.T, options mcpserver.Options) {
		for _, ids := range []struct{ name, target, sibling string }{
			{"number_and_string", "7", `"7"`},
			{"lone_surrogate_and_replacement", `"\ud800"`, `"\ufffd"`},
		} {
			t.Run(ids.name, func(t *testing.T) { batchRunSelectiveCancellation(t, options, ids.target, ids.sibling) })
		}
	})
}

func TestMCPBatchDuplicateIDCompletionAndCancellation(t *testing.T) {
	batchProtocolModes(t, func(t *testing.T, options mcpserver.Options) {
		t.Run("canceled_last", func(t *testing.T) { batchRunDuplicateCancellation(t, options) })
		t.Run("older_overwritten_stays_live", func(t *testing.T) { batchRunLiveDuplicate(t, options, false) })
		t.Run("last_mapped_aborts_on_close", func(t *testing.T) { batchRunLiveDuplicate(t, options, true) })
		t.Run("overwrite_before_distinct_completion", func(t *testing.T) { batchRunDuplicateOverwrite(t, options) })
	})
}

func batchRunDuplicateCancellation(t *testing.T, options mcpserver.Options) {
	t.Helper()
	registry, access, _ := newBatchTestRegistry(t, options)
	entered := make(chan batchTestActivity, 2)
	survivorRelease, cleanupRelease := make(chan struct{}), make(chan struct{})
	var survivorOnce, cleanupOnce sync.Once
	releaseSurvivor := func() { survivorOnce.Do(func() { close(survivorRelease) }) }
	releaseCleanup := func() { cleanupOnce.Do(func() { close(cleanupRelease) }) }
	selectedFinished := make(chan struct{})
	batchRegisterWaitingTool(t, registry, entered, map[string]<-chan struct{}{"survivor": survivorRelease})
	registry.RegisterTool(&mcp.Tool{Name: "fixture_delayed_cancel", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		batchEmptyInput, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			defer close(selectedFinished)
			entered <- batchTestActivity{label: "selected", ctx: ctx, session: request.Session}
			<-ctx.Done()
			// Deliberately finish cleanup later. A filled duplicate public slot
			// must complete HTTP without waiting for this canceled callback.
			<-cleanupRelease
			return mcpserver.ToolResult(map[string]any{"label": "selected"})
		})
	server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); releaseSurvivor(); releaseCleanup(); server.Close() })
	body := `[{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"survivor"}}},{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_delayed_cancel","arguments":{}}},{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}]`
	replies := batchStartHTTP(server.Client(), batchTestRequest(ctx, server.URL, "reader", body))
	activities := batchAwaitActivities(t, entered, 2)
	select {
	case <-activities["selected"].ctx.Done():
	case <-time.After(batchTestWait):
		t.Fatal("duplicate public ID did not cancel the last registered tool context")
	}
	if activities["survivor"].ctx.Err() != nil || ctx.Err() != nil {
		t.Fatal("last-controller cancellation ended the surviving duplicate or HTTP context")
	}
	releaseSurvivor()
	messages := batchAwaitProtocolCompletion(t, replies, options.JSONResponse)
	if len(messages) != 1 {
		t.Fatalf("duplicate cancellation emitted %d responses, want the sole surviving public slot", len(messages))
	}
	batchAssertLabel(t, batchResponseByID(t, messages, "7"), "survivor")
	select {
	case <-selectedFinished:
		t.Fatal("HTTP completion waited for canceled callback cleanup")
	default:
	}
	if ctx.Err() != nil || access.authentications.Load() != 1 {
		t.Fatalf("duplicate completion HTTP context/auth = %v/%d", ctx.Err(), access.authentications.Load())
	}
	releaseCleanup()
	batchAwaitSession(t, activities["selected"].session)
}

func batchRunLiveDuplicate(t *testing.T, options mcpserver.Options, firstCompletes bool) {
	t.Helper()
	registry, _, _ := newBatchTestRegistry(t, options)
	entered := make(chan batchTestActivity, 2)
	firstRelease, lateRelease := make(chan struct{}), make(chan struct{})
	var firstOnce, lateOnce sync.Once
	releaseFirst := func() { firstOnce.Do(func() { close(firstRelease) }) }
	releaseLate := func() { lateOnce.Do(func() { close(lateRelease) }) }
	batchRegisterWaitingTool(t, registry, entered, map[string]<-chan struct{}{"first": firstRelease, "late": lateRelease})
	server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); releaseFirst(); releaseLate(); server.Close() })
	body := `[{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"first"}}},{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"late"}}}]`
	replies := batchStartHTTP(server.Client(), batchTestRequest(ctx, server.URL, "reader", body))
	activities := batchAwaitActivities(t, entered, 2)
	wantLabel, pendingLabel := "late", "first"
	if firstCompletes {
		wantLabel, pendingLabel = "first", "late"
		releaseFirst()
	} else {
		releaseLate()
	}
	messages := batchAwaitProtocolCompletion(t, replies, options.JSONResponse)
	if len(messages) != 1 {
		t.Fatalf("first duplicate response produced %d public slots, want one", len(messages))
	}
	batchAssertLabel(t, batchResponseByID(t, messages, "7"), wantLabel)
	if firstCompletes {
		select {
		case <-activities[pendingLabel].ctx.Done():
		case <-time.After(batchTestWait):
			t.Fatal("normal HTTP close did not abort the remaining mapped controller")
		}
	} else {
		select {
		case <-activities[pendingLabel].ctx.Done():
			t.Fatal("normal public-slot completion canceled an older overwritten controller")
		case <-time.After(100 * time.Millisecond):
		}
	}
	if ctx.Err() != nil {
		t.Fatal("caller context ended before explicit caller cleanup")
	}
	releaseLate()
	releaseFirst()
	batchAwaitSession(t, activities[pendingLabel].session)
}

func batchRunDuplicateOverwrite(t *testing.T, options mcpserver.Options) {
	t.Helper()
	registry, _, _ := newBatchTestRegistry(t, options)
	entered := make(chan batchTestActivity, 3)
	releases := make(map[string]<-chan struct{})
	closeRelease := make(map[string]func())
	for _, label := range []string{"first", "second", "tail"} {
		release := make(chan struct{})
		var once sync.Once
		releases[label] = release
		closeRelease[label] = func() { once.Do(func() { close(release) }) }
	}
	batchRegisterWaitingTool(t, registry, entered, releases)
	server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		for _, release := range closeRelease {
			release()
		}
		server.Close()
	})
	body := `[{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"first"}}},{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"second"}}},{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"tail"}}}]`
	replies := batchStartHTTP(server.Client(), batchTestRequest(ctx, server.URL, "reader", body))
	activities := batchAwaitActivities(t, entered, 3)
	for _, label := range []string{"first", "second"} {
		closeRelease[label]()
		batchAwaitSession(t, activities[label].session)
	}
	if activities["tail"].ctx.Err() != nil || ctx.Err() != nil {
		t.Fatal("duplicate replies ended a still-pending distinct public slot")
	}
	closeRelease["tail"]()
	messages := batchAwaitProtocolCompletion(t, replies, options.JSONResponse)
	wantLabels, wantIDs := []string{"first", "second", "tail"}, []string{"7", "7", "9"}
	if options.JSONResponse {
		wantLabels, wantIDs = []string{"second", "tail"}, []string{"7", "9"}
	}
	if len(messages) != len(wantLabels) {
		t.Fatalf("duplicate completion response count = %d, want %d", len(messages), len(wantLabels))
	}
	for i, message := range messages {
		if batchResponseKey(t, message) != batchResponseKey(t, []byte(`{"id":`+wantIDs[i]+`}`)) {
			t.Fatalf("response %d public ID/order changed: %s", i, message)
		}
		var response map[string]json.RawMessage
		if err := json.Unmarshal(message, &response); err != nil {
			t.Fatal(err)
		}
		batchAssertLabel(t, response, wantLabels[i])
	}
}

func TestMCPBatchCancellationIgnoresUnregisteredController(t *testing.T) {
	batchProtocolModes(t, func(t *testing.T, options mcpserver.Options) {
		for _, test := range []struct{ name, request string }{
			{"resources_list", `{"jsonrpc":"2.0","id":7,"method":"resources/list","params":{}}`},
			{"unregistered_bad_params", `{"jsonrpc":"2.0","id":7,"method":"resources/list","params":{"cursor":17}}`},
			{"unregistered_missing_params", `{"jsonrpc":"2.0","id":7,"method":"resources/read"}`},
			{"notification_name_as_call", `{"jsonrpc":"2.0","id":7,"method":"notifications/progress","params":{}}`},
		} {
			t.Run(test.name, func(t *testing.T) {
				registry, access, observed := newBatchTestRegistry(t, options)
				server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
				t.Cleanup(server.Close)
				ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
				defer cancel()
				body := `[` + test.request + `,{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}},{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}]`
				messages := batchProtocolExchange(t, server, batchTestRequest(ctx, server.URL, "reader", body), options.JSONResponse)
				if len(messages) != 2 || observed.callbacks.Load() != 1 || access.authentications.Load() != 1 {
					t.Fatalf("unregistered-controller response/callback/auth count = %d/%d/%d", len(messages), observed.callbacks.Load(), access.authentications.Load())
				}
				response, err := json.Marshal(batchResponseByID(t, messages, "7"))
				if err != nil {
					t.Fatal(err)
				}
				const expected = `{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}`
				if !reflect.DeepEqual(batchPublicValue(t, response), batchPublicValue(t, []byte(expected))) {
					t.Fatalf("unregistered frozen handler reply = %s, want full error %s", response, expected)
				}
				if len(batchResponseByID(t, messages, "9")["result"]) == 0 {
					t.Fatal("unregistered-controller cancellation lost the valid sibling reply")
				}
			})
		}
	})
}

func batchAwaitProtocolCompletion(t *testing.T, replies <-chan batchHTTPReply, jsonMode bool) []json.RawMessage {
	t.Helper()
	response := batchAwaitHTTP(t, replies)
	defer response.Body.Close()
	type completedBody struct {
		body []byte
		err  error
	}
	completed := make(chan completedBody, 1)
	go func() {
		body, err := io.ReadAll(response.Body)
		completed <- completedBody{body: body, err: err}
	}()
	select {
	case result := <-completed:
		wantType := "text/event-stream"
		if jsonMode {
			wantType = "application/json"
		}
		if result.err != nil || response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != wantType {
			t.Fatalf("completed batch status/type/error = %d/%q/%v; body %s", response.StatusCode, response.Header.Get("Content-Type"), result.err, result.body)
		}
		return batchMessages(t, wantType, result.body)
	case <-time.After(batchTestWait):
		t.Fatal("HTTP did not complete after every distinct public response slot was filled")
		return nil
	}
}

func batchAssertLabel(t *testing.T, response map[string]json.RawMessage, label string) {
	t.Helper()
	var result struct {
		IsError           bool `json:"isError"`
		StructuredContent struct {
			Label string `json:"label"`
		} `json:"structuredContent"`
	}
	if len(response["error"]) != 0 {
		t.Fatalf("duplicate response contained RPC error: %s", response["error"])
	}
	if err := json.Unmarshal(response["result"], &result); err != nil || result.IsError || result.StructuredContent.Label != label {
		t.Fatalf("duplicate response label = %s, want %q; decode error %v", response["result"], label, err)
	}
}

func TestMCPBatchCallerCancellationDuringBlockedDelivery(t *testing.T) {
	batchProtocolModes(t, func(t *testing.T, options mcpserver.Options) {
		registry, _, _ := newBatchTestRegistry(t, options)
		entered := make(chan batchTestActivity, 2)
		lastRelease, writeRelease := make(chan struct{}), make(chan struct{})
		var lastOnce, writeOnce sync.Once
		releaseLast := func() { lastOnce.Do(func() { close(lastRelease) }) }
		releaseWrite := func() { writeOnce.Do(func() { close(writeRelease) }) }
		batchRegisterWaitingTool(t, registry, entered, map[string]<-chan struct{}{"last": lastRelease})
		writeStarted := make(chan struct{})
		handler := httpserver.ErrorHandler{}.Wrap(registry.Handle)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			handler.ServeHTTP(&batchBlockedHTTPWriter{ResponseWriter: w, started: writeStarted, release: writeRelease}, request)
		}))
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(func() { cancel(); releaseLast(); releaseWrite(); server.Close() })
		body := `[{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"first"}}},{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"last"}}}]`
		_ = batchStartHTTP(server.Client(), batchTestRequest(ctx, server.URL, "reader", body))
		activities := batchAwaitActivities(t, entered, 2)
		releaseLast()
		select {
		case <-writeStarted:
		case <-time.After(batchTestWait):
			t.Fatal("public final response did not reach the blocked HTTP writer")
		}
		cancel()
		select {
		case <-activities["first"].ctx.Done():
		case <-time.After(batchTestWait):
			t.Fatal("real caller cancellation waited behind blocked response delivery")
		}
		// The writer is still deliberately blocked here: cancellation came
		// from the actual HTTP caller, not a write failure or a release timeout.
		releaseWrite()
	})
}

type batchBlockedHTTPWriter struct {
	http.ResponseWriter
	started chan<- struct{}
	release <-chan struct{}
	once    sync.Once
}

func (writer *batchBlockedHTTPWriter) Write(data []byte) (int, error) {
	writer.once.Do(func() { close(writer.started); <-writer.release })
	return writer.ResponseWriter.Write(data)
}

func (writer *batchBlockedHTTPWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func batchRunSelectiveCancellation(t *testing.T, options mcpserver.Options, targetID, siblingID string) {
	t.Helper()
	registry, access, _ := newBatchTestRegistry(t, options)
	entered := make(chan batchTestActivity, 3)
	siblingRelease, otherRelease := make(chan struct{}), make(chan struct{})
	var siblingOnce, otherOnce sync.Once
	releaseSibling := func() { siblingOnce.Do(func() { close(siblingRelease) }) }
	releaseOther := func() { otherOnce.Do(func() { close(otherRelease) }) }
	batchRegisterWaitingTool(t, registry, entered, map[string]<-chan struct{}{"sibling": siblingRelease, "other": otherRelease})
	server := httptest.NewServer(httpserver.ErrorHandler{}.Wrap(registry.Handle))
	// There is deliberately no request deadline: only notifications/cancelled
	// may end the selected tool while both real HTTP request contexts stay live.
	ctx, cancel := context.WithCancel(context.Background())
	otherCtx, cancelOther := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); cancelOther(); releaseSibling(); releaseOther(); server.Close() })
	body := `[{"jsonrpc":"2.0","id":` + targetID + `,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"selected"}}},{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":` + targetID + `}},{"jsonrpc":"2.0","id":` + siblingID + `,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"sibling"}}}]`
	replies := batchStartHTTP(server.Client(), batchTestRequest(ctx, server.URL, "reader", body))
	other := batchStartHTTP(server.Client(), batchTestRequest(otherCtx, server.URL, "reader",
		`[{"jsonrpc":"2.0","id":`+targetID+`,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"other"}}}]`))
	activities := batchAwaitActivities(t, entered, 3)
	select {
	case <-activities["selected"].ctx.Done():
	case <-time.After(batchTestWait):
		t.Fatal("notifications/cancelled did not cancel the selected public tool context while HTTP remained live")
	}
	if ctx.Err() != nil || otherCtx.Err() != nil || activities["sibling"].ctx.Err() != nil || activities["other"].ctx.Err() != nil {
		t.Fatal("selected cancellation ended the HTTP request, numeric/string/UTF16 sibling, or unrelated request")
	}
	releaseOther()
	otherResponse := batchAwaitHTTP(t, other)
	otherBody, err := io.ReadAll(otherResponse.Body)
	otherResponse.Body.Close()
	if err != nil || otherResponse.StatusCode != http.StatusOK {
		t.Fatalf("unrelated request failed to complete: status %d, error %v", otherResponse.StatusCode, err)
	}
	otherMessages := batchMessages(t, otherResponse.Header.Get("Content-Type"), otherBody)
	if len(otherMessages) != 1 || len(batchResponseByID(t, otherMessages, targetID)["result"]) == 0 {
		t.Fatalf("unrelated public-ID reply changed: %s", otherBody)
	}
	releaseSibling()
	batchAwaitSession(t, activities["selected"].session)
	batchAwaitSession(t, activities["sibling"].session)
	if options.JSONResponse {
		// The pinned TS transport's canceled response slot remains pending.
		// All SDK callbacks have finished, so an early aggregate response is
		// a wire mismatch rather than a callback scheduling observation.
		select {
		case reply := <-replies:
			if reply.response != nil {
				reply.response.Body.Close()
			}
			t.Fatalf("canceled JSON batch unexpectedly completed: %v", reply.err)
		case <-time.After(100 * time.Millisecond):
		}
	} else {
		response := batchAwaitHTTP(t, replies)
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" {
			t.Fatalf("cancellation SSE status/type = %d/%q", response.StatusCode, response.Header.Get("Content-Type"))
		}
		scanner := bufio.NewScanner(response.Body)
		first := batchReadSSEMessage(t, scanner)
		if batchResponseKey(t, first) != batchResponseKey(t, []byte(`{"id":`+siblingID+`}`)) {
			t.Fatalf("canceled member emitted a reply or sibling ID changed: %s", first)
		}
		batchAssertStreamPending(t, scanner, cancel)
	}
	if ctx.Err() != nil || access.authentications.Load() != 2 {
		t.Fatalf("HTTP context/auth changed before caller cleanup: %v/%d", ctx.Err(), access.authentications.Load())
	}
	cancel()
}

func batchAwaitSession(t *testing.T, session *mcp.ServerSession) {
	t.Helper()
	done := make(chan struct{})
	go func() { _ = session.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(batchTestWait):
		t.Fatal("SDK session did not finish its admitted member")
	}
}

func batchReadSSEMessage(t *testing.T, scanner *bufio.Scanner) json.RawMessage {
	t.Helper()
	for scanner.Scan() {
		if message, ok := strings.CutPrefix(scanner.Text(), "data: "); ok && message != "" {
			return json.RawMessage(message)
		}
	}
	t.Fatalf("SSE ended before sibling response: %v", scanner.Err())
	return nil
}

func batchAssertStreamPending(t *testing.T, scanner *bufio.Scanner, cancel context.CancelFunc) {
	t.Helper()
	ended := make(chan bool, 1)
	go func() {
		for scanner.Scan() {
			if message, ok := strings.CutPrefix(scanner.Text(), "data: "); ok && message != "" {
				ended <- true
				return
			}
		}
		ended <- false
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-ended:
		case <-time.After(batchTestWait):
			t.Error("SSE reader did not stop during caller cleanup")
		}
	})
	select {
	case extra := <-ended:
		ended <- extra
		t.Fatalf("canceled SSE batch unexpectedly emitted another response or ended (extra=%v)", extra)
	case <-time.After(100 * time.Millisecond):
	}
}
