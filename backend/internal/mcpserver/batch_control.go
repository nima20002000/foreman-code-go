package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

type batchCall struct {
	ctx             context.Context
	cancel          context.CancelFunc
	cancelled       atomic.Bool
	handlerFinished atomic.Bool
}

func newBatchCall(parent context.Context) *batchCall {
	ctx, cancel := context.WithCancel(parent)
	return &batchCall{ctx: ctx, cancel: cancel}
}

func (call *batchCall) abort() {
	call.cancelled.Store(true)
	call.cancel()
}

// These are the installed request handlers in the frozen tool-only server:
// Protocol supplies ping, Server supplies initialize, and McpServer supplies
// tools/list and tools/call. An unregistered standard Go method has no frozen
// abort controller and must not displace a real handler with the same public ID.
func batchHasController(method string) bool {
	switch method {
	case "ping", "initialize", "tools/list", "tools/call":
		return true
	default:
		return false
	}
}

// batchCancellationID follows CancelledNotificationSchema and the frozen
// protocol's truthiness guard. Public identity never passes through Go's string
// or float-to-integer SDK ID conversion. The map is local to one HTTP request.
func batchCancellationID(fields map[string]any) []byte {
	if !batchStringEquals(fields["method"], "notifications/cancelled") {
		return nil
	}
	params, ok := batchFields(fields["params"])
	if !ok || !batchOptional(params, "reason", batchText) {
		return nil
	}
	id, ok := batchID(params["requestId"])
	if !ok || bytes.Equal(id, []byte("0")) || bytes.Equal(id, []byte(`""`)) {
		return nil
	}
	return id
}

// v1.7.0 checks unknown methods before its receiving middleware and offers no
// custom-notification registration. Let the original request pass through the
// official HTTP gates, then ignore only the three exact notification dispatch
// errors. Frozen unknown/request-only notifications are ignored, and missing
// notification params fail inside its asynchronous handler, never as HTTP400.
// Source: mcp/shared.go checkRequest and internal/jsonrpc2/{jsonrpc2,wire}.go.
func (reply *batchMemberWriter) ignoredNotification(message batchMessage) bool {
	if !message.notification || !reply.methodDispatchError() {
		return false
	}
	body := reply.body.String()
	return body == fmt.Sprintf("JSON RPC not handled: %q unsupported\n", message.method) ||
		body == fmt.Sprintf("invalid request: missing id for %q\n", message.method) ||
		body == "invalid request: missing required \"params\"\n"
}

func (reply *batchMemberWriter) methodDispatchError() bool {
	return reply.status == http.StatusBadRequest &&
		reply.header.Get("Content-Type") == "text/plain; charset=utf-8" &&
		reply.header.Get("X-Content-Type-Options") == "nosniff"
}

func (reply *batchMemberWriter) unregisteredDispatchError(message batchMessage) bool {
	if !message.call || !reply.unregistered || !reply.methodDispatchError() {
		return false
	}
	body := reply.body.String()
	return body == fmt.Sprintf("JSON RPC not handled: %q unsupported\n", message.method) ||
		body == fmt.Sprintf("invalid request: unexpected id for %q\n", message.method) ||
		body == "invalid request: missing required \"params\"\n"
}

const batchMethodNotFoundResponse = `{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"Method not found"}}`

// A Go-standard method can be absent from the frozen server. Preserve the
// official handler's HTTP gates, then translate only its exact dispatch error
// into the frozen absent-handler response. No domain callback is dispatched.
func (reply *batchMemberWriter) writeMethodNotFound(jsonMode bool) {
	reply.status = http.StatusOK
	reply.body.Reset()
	reply.header = make(http.Header)
	data := []byte(batchMethodNotFoundResponse)
	if jsonMode {
		reply.header.Set("Content-Type", "application/json")
	} else {
		reply.header.Set("Content-Type", "text/event-stream")
		reply.header.Set("Cache-Control", "no-cache, no-transform")
		reply.header.Set("Connection", "keep-alive")
		data = append([]byte("event: message\ndata: "), data...)
		data = append(data, '\n', '\n')
	}
	reply.allowAdmission()
	_, err := reply.Write(data)
	if err == nil && !jsonMode {
		err = reply.FlushError()
	}
	if err != nil && reply.output.ctx.Err() == nil && !reply.output.finished() {
		reply.output.fail(err)
	}
}

type batchHTTPError struct {
	header http.Header
	status int
	body   []byte
}

func (failure *batchHTTPError) write(w http.ResponseWriter, id []byte) error {
	data := failure.body
	if strings.HasPrefix(failure.header.Get("Content-Type"), "application/json") {
		var err error
		data, err = restoreBatchResponseID(data, id)
		if err != nil {
			return err
		}
	}
	copyBatchHeaders(w.Header(), failure.header)
	w.WriteHeader(failure.status)
	_, err := w.Write(data)
	return err
}

// Receiving middleware observes admission after the official SDK's method,
// params and HTTP checks, then narrows dispatch to the frozen installed handlers.
// Existing handlers keep their SDK path; absent handlers never grant access.
func (reply *batchMemberWriter) receivingMiddleware(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
		reply.allowAdmission()
		if reply.call != nil {
			defer reply.call.handlerFinished.Store(true)
		}
		if reply.unregistered {
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeMethodNotFound, Message: "Method not found"}
		}
		return next(ctx, method, request)
	}
}

func (reply *batchMemberWriter) allowAdmission() {
	reply.admissionOnce.Do(reply.admitted)
}

func (reply *batchMemberWriter) finishAdmission(message batchMessage) {
	reply.admissionOnce.Do(func() {
		if reply.status >= http.StatusBadRequest && !reply.ignoredNotification(message) {
			reply.admissionError = &batchHTTPError{
				header: reply.header.Clone(), status: reply.status,
				body: append([]byte(nil), reply.body.Bytes()...),
			}
		}
		reply.admitted()
	})
}

func batchFinalResponse(data []byte) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return false
	}
	_, result := fields["result"]
	_, failure := fields["error"]
	_, method := fields["method"]
	return !method && (result || failure) && bytes.Equal(fields["id"], []byte("0"))
}

func batchText(value any) bool {
	_, ok := value.(jsonvalue.UTF16String)
	return ok
}

func batchOptional(fields map[string]any, key string, validate func(any) bool) bool {
	value, exists := fields[key]
	return !exists || validate(value)
}
