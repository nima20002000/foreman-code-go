package mcpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

func responseIDWriter(t *testing.T, writer http.ResponseWriter) *mcpserver.ResponseIDWriter {
	t.Helper()
	result, err := mcpserver.NewResponseIDWriter(writer, jsonvalue.UTF16String{0xd800})
	if err != nil { t.Fatal(err) }
	return result
}

func writeResponseParts(t *testing.T, writer *mcpserver.ResponseIDWriter, data string, size int) {
	t.Helper()
	for start := 0; start < len(data); start += size {
		end := start+size
		if end > len(data) { end = len(data) }
		if n, err := writer.Write([]byte(data[start:end])); err != nil || n != end-start {
			t.Fatalf("public Write consumed %d of %d bytes: %v", n, end-start, err)
		}
	}
}

func TestResponseIDWriterRequiresWriter(t *testing.T) {
	if writer, err := mcpserver.NewResponseIDWriter(nil, nil); err == nil || writer != nil {
		t.Fatalf("nil writer returned writer=%v error=%v", writer != nil, err)
	}
}

func TestResponseIDWriterRestoresOnlyMatchingRPCResponses(t *testing.T) {
	for _, test := range []struct { name, input, expected string }{
		{"result", ` { "result" : {"id":"�","text":"literal \"id\":\"�\"","nested":{"id":"�"}}, "id" : "�", "jsonrpc" : "2.0" } `,
			` { "result" : {"id":"�","text":"literal \"id\":\"�\"","nested":{"id":"�"}}, "id" : "\ud800", "jsonrpc" : "2.0" } `},
		{"error", `{"jsonrpc":"2.0","id":"\ufffd","error":{"code":-32601,"message":"�"}}`,
			`{"jsonrpc":"2.0","id":"\ud800","error":{"code":-32601,"message":"�"}}`},
		{"escaped_key", `{"jsonrpc":"2.0","\u0069d":"�","result":{}}`, `{"jsonrpc":"2.0","\u0069d":"\ud800","result":{}}`},
		{"null_error", `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`, ""},
		{"different_id", `{"jsonrpc":"2.0","id":"another","result":{}}`, ""},
		{"number_id", `{"jsonrpc":"2.0","id":7,"result":{}}`, ""},
		{"server_request", `{"jsonrpc":"2.0","id":"�","method":"sampling/createMessage","params":{}}`, ""},
		{"notification", `{"jsonrpc":"2.0","method":"notifications/message","params":{"id":"�"}}`, ""},
		{"method_with_result", `{"jsonrpc":"2.0","id":"�","method":null,"result":{}}`, ""},
		{"not_rpc", `{"id":"�","result":{}}`, ""},
		{"ambiguous_result_error", `{"jsonrpc":"2.0","id":"�","result":{},"error":{}}`, ""},
		{"invalid_error", `{"jsonrpc":"2.0","id":"�","error":null}`, ""},
		{"duplicate_id", `{"jsonrpc":"2.0","id":"other","id":"�","result":{}}`, ""},
		{"array_body", `[{"jsonrpc":"2.0","id":"�","result":{}}]`, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.expected == "" { test.expected = test.input }
			for _, size := range []int{1, 7, len(test.input)} {
				recorder := httptest.NewRecorder()
				writer := responseIDWriter(t, recorder)
				writer.Header().Set("Content-Type", "application/json; charset=utf-8")
				writeResponseParts(t, writer, test.input, size)
				if err := writer.Finish(); err != nil { t.Fatal(err) }
				if actual := recorder.Body.String(); actual != test.expected {
					t.Fatalf("chunk %d changed response bytes\ngot %s\nwant %s", size, actual, test.expected)
				}
			}
		})
	}
}

func TestResponseIDWriterPreservesSSEFraming(t *testing.T) {
	for _, ending := range []string{"\n", "\r\n", "\r"} {
		t.Run(strconv.Quote(ending), func(t *testing.T) {
			input := strings.Join([]string{
				": keepalive", "", "event: message", "id: �", "retry: 17",
				`data: {"jsonrpc":"2.0",`, `data: "id":"�","result":{"id":"�","text":"payload \"id\":\"�\""}}`, "",
				"event: another", `data: {"jsonrpc":"2.0","id":"�","result":{}}`, "",
				`data: {"jsonrpc":"2.0","id":"�","error":{"code":-32601,"message":"fixture"}}`, "", "",
			}, ending)
			expected := strings.Replace(input, `data: "id":"�","result"`, `data: "id":"\ud800","result"`, 1)
			expected = strings.Replace(expected, `"id":"�","error"`, `"id":"\ud800","error"`, 1)
			for _, size := range []int{1, 11, len(input)} {
				recorder := httptest.NewRecorder()
				writer := responseIDWriter(t, recorder)
				writer.Header().Set("Content-Type", "text/event-stream")
				writeResponseParts(t, writer, input, size)
				if err := writer.FlushError(); err != nil { t.Fatal(err) }
				if err := writer.Finish(); err != nil { t.Fatal(err) }
				if actual := recorder.Body.String(); actual != expected || !recorder.Flushed {
					t.Fatalf("chunk %d changed SSE framing\ngot %q\nwant %q; flushed=%v", size, actual, expected, recorder.Flushed)
				}
			}
		})
	}
}

type responseWriterProbe struct {
	header http.Header
	body bytes.Buffer
	status int
	writes int
	flushes int
	writeError error
	short bool
	flushError error
	flushAfterWrite bool
	deadline time.Time
	duplex bool
}

func (writer *responseWriterProbe) Header() http.Header {
	if writer.header == nil { writer.header = make(http.Header) }
	return writer.header
}
func (writer *responseWriterProbe) WriteHeader(status int) { writer.status = status }
func (writer *responseWriterProbe) Write(data []byte) (int, error) {
	writer.writes++
	if writer.writeError != nil || writer.short {
		n := len(data)
		if n > 2 { n = 2 }
		writer.body.Write(data[:n])
		return n, writer.writeError
	}
	return writer.body.Write(data)
}
func (writer *responseWriterProbe) FlushError() error {
	writer.flushes++
	if !writer.flushAfterWrite || writer.writes != 0 { return writer.flushError }
	return nil
}
func (writer *responseWriterProbe) SetWriteDeadline(value time.Time) error { writer.deadline = value; return nil }
func (writer *responseWriterProbe) EnableFullDuplex() error { writer.duplex = true; return nil }

func TestResponseIDWriterPreservesHeadersAndController(t *testing.T) {
	probe := &responseWriterProbe{}
	writer := responseIDWriter(t, probe)
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("Mcp-Session-Id", "isolated-session-fixture")
	writer.Header().Set("Content-Length", "7")
	writer.WriteHeader(202)
	if writer.Unwrap() != probe || probe.status != 202 || probe.Header().Get("Cache-Control") != "no-cache" || probe.Header().Get("Mcp-Session-Id") != "isolated-session-fixture" || probe.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("status/header/unwrap changed: status=%d header=%v", probe.status, probe.Header())
	}
	if probe.Header().Get("Content-Length") != "" { t.Fatal("potential rewritten output retained a stale content length") }
	deadline := time.Unix(7, 0)
	controller := http.NewResponseController(writer)
	if err := controller.SetWriteDeadline(deadline); err != nil { t.Fatal(err) }
	if err := controller.EnableFullDuplex(); err != nil { t.Fatal(err) }
	if err := controller.Flush(); err != nil { t.Fatal(err) }
	if !probe.deadline.Equal(deadline) || !probe.duplex || probe.flushes != 1 { t.Fatal("ResponseController transport operations were lost") }
	if err := writer.Finish(); err != nil { t.Fatal(err) }
}

func TestResponseIDWriterPreservesPassThroughBodies(t *testing.T) {
	const body = `{"jsonrpc":"2.0","id":"�","result":{"text":"�"}}`
	for _, test := range []struct { name, media, encoding string; id jsonvalue.UTF16String }{
		{"well_formed", "application/json", "", jsonvalue.UTF16String{0xfffd}},
		{"empty_id", "application/json", "", nil},
		{"unknown_media", "text/plain", "", jsonvalue.UTF16String{0xd800}},
		{"encoded_body", "application/json", "fixture-encoding", jsonvalue.UTF16String{0xd800}},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writer, err := mcpserver.NewResponseIDWriter(recorder, test.id)
			if err != nil { t.Fatal(err) }
			writer.Header().Set("Content-Type", test.media)
			writer.Header().Set("Content-Encoding", test.encoding)
			writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
			writeResponseParts(t, writer, body, 1)
			if err := writer.Finish(); err != nil { t.Fatal(err) }
			if recorder.Body.String() != body || recorder.Header().Get("Content-Length") != strconv.Itoa(len(body)) {
				t.Fatal("pass-through response bytes or headers changed")
			}
		})
	}
}

func TestResponseIDWriterPreservesIncompleteTail(t *testing.T) {
	for _, test := range []struct { media, tail string }{
		{"application/json", `{"jsonrpc":"2.0","id":"�`},
		{"text/event-stream", "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"�\",\"result\":{}}"},
	} {
		t.Run(test.media, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writer := responseIDWriter(t, recorder)
			writer.Header().Set("Content-Type", test.media)
			writeResponseParts(t, writer, test.tail, 1)
			if err := writer.FlushError(); err != nil { t.Fatal(err) }
			if recorder.Body.Len() != 0 { t.Fatal("an incomplete token/event escaped before its boundary") }
			if err := writer.Finish(); err != nil { t.Fatal(err) }
			if recorder.Body.String() != test.tail { t.Fatal("Finish invented an event boundary or changed incomplete bytes") }
			if err := writer.Finish(); err != nil || recorder.Body.String() != test.tail { t.Fatal("repeated Finish replayed output") }
			if _, err := writer.Write([]byte("late")); !errors.Is(err, io.ErrClosedPipe) { t.Fatalf("late Write=%v", err) }
		})
	}
}

func TestResponseIDWriterRetainsOutputFailures(t *testing.T) {
	const frame = "data: {\"jsonrpc\":\"2.0\",\"id\":\"�\",\"result\":{}}\n\n"
	for _, name := range []string{"write", "short_write", "flush", "finish_tail"} {
		t.Run(name, func(t *testing.T) {
			failure := errors.New("isolated " + name + " failure")
			probe := &responseWriterProbe{}
			writer := responseIDWriter(t, probe)
			writer.Header().Set("Content-Type", "text/event-stream")
			var err error
			switch name {
			case "write": probe.writeError = failure; _, err = writer.Write([]byte(frame))
			case "short_write": probe.short = true; failure = io.ErrShortWrite; _, err = writer.Write([]byte(frame))
			case "flush":
				if _, err := writer.Write([]byte(frame)); err != nil { t.Fatal(err) }
				probe.flushError = failure; err = writer.FlushError()
			case "finish_tail":
				if _, err := writer.Write([]byte("data: unfinished")); err != nil { t.Fatal(err) }
				probe.writeError = failure; err = writer.Finish()
			}
			if !errors.Is(err, failure) { t.Fatalf("operation lost expected error: %v", err) }
			before, writes := probe.body.String(), probe.writes
			if err := writer.Finish(); !errors.Is(err, failure) { t.Fatalf("Finish lost output error: %v", err) }
			if err := writer.Finish(); !errors.Is(err, failure) || probe.body.String() != before || probe.writes != writes {
				t.Fatal("Finish lost the failure or replayed partially delivered output")
			}
		})
	}
}

func TestResponseIDWriterPreservesHTTPFraming(t *testing.T) {
	const original = `{"jsonrpc":"2.0","id":"�","result":{"text":"payload"}}`
	const expected = `{"jsonrpc":"2.0","id":"\ud800","result":{"text":"payload"}}`
	result := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writer, err := mcpserver.NewResponseIDWriter(w, jsonvalue.UTF16String{0xd800})
		if err != nil { result <- err; return }
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Content-Length", strconv.Itoa(len(original)))
		writer.Header().Set("Cache-Control", "no-store")
		writer.WriteHeader(200)
		for index := range []byte(original) {
			if _, err := writer.Write([]byte(original[index:index+1])); err != nil { result <- err; return }
		}
		result <- writer.Finish()
	}))
	defer server.Close()
	client := &http.Client{Timeout: 3*time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Get(server.URL)
	if err != nil { t.Fatal(err) }
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || string(data) != expected || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("HTTP framing status=%d body=%q error=%v", response.StatusCode, data, err)
	}
	if response.ContentLength >= 0 && response.ContentLength != int64(len(expected)) { t.Fatal("wire content length disagrees with restored response bytes") }
	select { case err := <-result: if err != nil { t.Fatal(err) }; case <-time.After(3*time.Second): t.Fatal("isolated HTTP response did not finish") }
}

func TestMCPAppRetainsResponseIDTransportFailure(t *testing.T) {
	for _, name := range []string{"write", "ignored_sdk_flush"} {
		t.Run(name, func(t *testing.T) {
			failure := errors.New("isolated response transport " + name)
			probe := &responseWriterProbe{}
			if name == "write" { probe.writeError = failure } else { probe.flushError, probe.flushAfterWrite = failure, true }
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			application, err := app.New(app.Options{MCPAccess: &counterAccess{}, Logger: logger})
			if err != nil { t.Fatal(err) }
			var invoked atomic.Bool
			application.RegisterTool(&mcp.Tool{Name: "counter_get", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
				func(raw json.RawMessage) error { if string(raw) != "{}" { return errors.New("isolated fixture requires empty arguments") }; return nil },
				func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) { invoked.Store(true); return mcpserver.ToolResult(map[string]any{"value": "fixture"}) })
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":"\ud800","method":"tools/call","params":{"name":"counter_get","arguments":{}}}`)).WithContext(ctx)
			request.Header.Set("Authorization", "Bearer reader")
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Accept", "application/json, text/event-stream")
			request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
			application.Handler().ServeHTTP(probe, request)
			if !invoked.Load() { t.Fatal("public MCP tool did not reach the response boundary") }
			if !strings.Contains(logs.String(), failure.Error()) || !strings.Contains(logs.String(), "HTTP response could not complete") {
				t.Fatalf("app composition lost response transport error: %s", logs.String())
			}
			if probe.writes != 1 || strings.Contains(probe.body.String(), "INTERNAL_ERROR") || probe.status != 200 {
				t.Fatalf("app appended an HTTP error envelope after stream commitment: status=%d writes=%d body=%q", probe.status, probe.writes, probe.body.String())
			}
			if name == "ignored_sdk_flush" && !strings.Contains(probe.body.String(), `"id":"\ud800"`) { t.Fatal("completed response did not retain lossless ID before flush failed") }
		})
	}
}
