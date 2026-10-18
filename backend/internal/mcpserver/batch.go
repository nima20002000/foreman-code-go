package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

type batchMessage struct {
	body          []byte
	id            []byte
	method        string
	requestedTool string
	call          bool
}

// serveBatch adapts only the batch envelope. Each member still goes through the
// official Streamable HTTP handler, with its original headers and protocol.
// A separate ephemeral SDK session per member keeps SDK-normalized IDs from
// colliding. The request-local response slot restores only that member's ID.
func (r *Registry) serveBatch(w http.ResponseWriter, request *http.Request, body []byte) error {
	messages, ok := parseBatch(body)
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, err := io.WriteString(w, `{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: Invalid JSON-RPC message"},"id":null}`)
		return err
	}

	// At the negotiated 2025-11-25 version the SDK detaches handler contexts.
	// Bind both serverFor/authorized and the HTTP clones to this derived context
	// so cancellation and failed response writes reach this batch's tools only.
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	output := &batchOutput{writer: w, ctx: ctx, cancel: cancel}
	handlers := make([]*mcp.StreamableHTTPHandler, len(messages))
	for i, message := range messages {
		server, err := r.serverFor(ctx, message.requestedTool)
		if err != nil {
			return err
		}
		if message.call {
			addBatchMethodFallback(server, message.method)
		}
		handlers[i] = r.streamableHandler(server)
	}

	// The frozen TS transport dispatches without awaiting earlier members.
	// SSE therefore streams completions; explicit JSON uses the input slots.
	replies := make([]*batchMemberWriter, len(messages))
	var pending sync.WaitGroup
	for i, message := range messages {
		reply := &batchMemberWriter{header: make(http.Header), output: output, id: message.id}
		replies[i] = reply
		memberRequest := request.Clone(ctx)
		memberRequest.Body = io.NopCloser(bytes.NewReader(message.body))
		memberRequest.ContentLength = int64(len(message.body))
		memberRequest.GetBody = nil
		pending.Add(1)
		go func() {
			defer pending.Done()
			handlers[i].ServeHTTP(reply, memberRequest)
		}()
	}
	pending.Wait()
	if err := output.failure(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return nil
	}

	for i, reply := range replies {
		if reply.status >= http.StatusBadRequest {
			// SDK HTTP admission errors (for example a shared invalid protocol
			// header) retain the SDK response. A committed stream cannot carry a
			// second HTTP response; net/http's abort sentinel closes that stream.
			if output.started {
				panic(http.ErrAbortHandler)
			}
			data := reply.body.Bytes()
			if strings.HasPrefix(reply.header.Get("Content-Type"), "application/json") {
				var err error
				data, err = restoreBatchResponseID(data, messages[i].id)
				if err != nil {
					return err
				}
			}
			copyBatchHeaders(w.Header(), reply.header)
			w.WriteHeader(reply.status)
			_, err := w.Write(data)
			return err
		}
	}

	if r.opts.JSONResponse {
		var results [][]byte
		for i, reply := range replies {
			if !messages[i].call || reply.status == http.StatusAccepted {
				continue
			}
			result, err := restoreBatchResponseID(reply.body.Bytes(), messages[i].id)
			if err != nil {
				return err
			}
			results = append(results, result)
		}
		if len(results) > 0 {
			w.Header().Set("Content-Type", "application/json")
			var data []byte
			if len(results) == 1 {
				data = results[0]
			} else {
				data = append([]byte{'['}, bytes.Join(results, []byte{','})...)
				data = append(data, ']')
			}
			_, err := w.Write(data)
			return err
		}
	}
	if !output.started {
		w.WriteHeader(http.StatusAccepted)
	}
	return nil
}

func addBatchMethodFallback(server *mcp.Server, method string) {
	err := mcp.AddReceivingCustomMethod(server, method,
		func(context.Context, *mcp.ServerSession, *mcp.ParamsBase) (*mcp.EmptyResult, error) {
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeMethodNotFound, Message: "Method not found"}
		})
	if err != nil {
		// v1.7.0 documents exactly one refusal: a standard method name.
		// It leaves that standard handler untouched. The fallback is used
		// only for calls; custom method registration is not notification-shaped.
		return
	}
}

// parseBatch applies the frozen JSON-RPC envelope/ID admission to every member
// before dispatch. Domain params remain byte-for-byte raw for the SDK and the
// registered generated validator; no domain DTO is materialized here.
func parseBatch(body []byte) ([]batchMessage, bool) {
	value, err := jsonvalue.Parse(body)
	if err != nil {
		return nil, false
	}
	values, ok := value.([]any)
	if !ok {
		return nil, false
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil || len(raw) != len(values) {
		return nil, false
	}
	messages := make([]batchMessage, len(values))
	for i, value := range values {
		fields, ok := batchFields(value)
		if !ok || len(fields) != len(value.(jsonvalue.Object)) || !batchStringEquals(fields["jsonrpc"], "2.0") || !validBatchEnvelope(fields) {
			return nil, false
		}
		message := batchMessage{body: raw[i]}
		var transport struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		// Other valid JSON-RPC kinds have no requested tool to expose.
		_ = json.Unmarshal(raw[i], &transport)
		message.method = transport.Method
		if transport.Method == "tools/call" {
			message.requestedTool = transport.Params.Name
		}
		_, hasMethod := fields["method"]
		id, hasID := fields["id"]
		message.call = hasMethod && hasID
		if message.call {
			message.id, ok = batchID(id)
			if !ok {
				return nil, false
			}
			// Each member has its own SDK session, so the one-byte ID 0 is
			// sufficient correlation and cannot enlarge its admitted body.
			message.body, err = replaceEnvelopeID(raw[i], []byte("0"), false)
			if err != nil {
				return nil, false
			}
		}
		messages[i] = message
	}
	return messages, true
}

func validBatchEnvelope(fields map[string]any) bool {
	if id, exists := fields["id"]; exists {
		if _, ok := batchID(id); !ok {
			return false
		}
	}
	if method, exists := fields["method"]; exists {
		if _, ok := method.(jsonvalue.UTF16String); !ok || !batchKeys(fields, "jsonrpc", "id", "method", "params") {
			return false
		}
		if params, exists := fields["params"]; exists {
			object, ok := batchFields(params)
			return ok && validBatchMeta(object)
		}
		return true
	}
	if result, exists := fields["result"]; exists {
		_, hasID := fields["id"]
		object, ok := batchFields(result)
		if !hasID || !ok || !batchKeys(fields, "jsonrpc", "id", "result") {
			return false
		}
		if meta, exists := object["_meta"]; exists {
			_, ok = meta.(jsonvalue.Object)
		}
		return ok
	}
	if failure, exists := fields["error"]; exists && batchKeys(fields, "jsonrpc", "id", "error") {
		object, ok := batchFields(failure)
		if !ok {
			return false
		}
		_, messageOK := object["message"].(jsonvalue.UTF16String)
		_, numberOK := object["code"].(json.Number)
		_, codeOK := batchID(object["code"])
		return messageOK && numberOK && codeOK
	}
	return false
}

func validBatchMeta(params map[string]any) bool {
	meta, exists := params["_meta"]
	if !exists {
		return true
	}
	object, ok := batchFields(meta)
	if !ok {
		return false
	}
	if progress, exists := object["progressToken"]; exists {
		if _, ok := batchID(progress); !ok {
			return false
		}
	}
	if related, exists := object["io.modelcontextprotocol/related-task"]; exists {
		task, ok := batchFields(related)
		if !ok {
			return false
		}
		if _, ok := task["taskId"].(jsonvalue.UTF16String); !ok {
			return false
		}
	}
	return true
}

func batchFields(value any) (map[string]any, bool) {
	object, ok := value.(jsonvalue.Object)
	if !ok {
		return nil, false
	}
	fields := make(map[string]any, len(object))
	for _, member := range object {
		key, err := member.Key.UTF8()
		if err != nil {
			// Loose params/metadata may have unknown UTF-16 property names.
			// They remain in the original raw body; only ASCII-known fields
			// are consulted here. The strict envelope checks the member count.
			continue
		}
		fields[key] = member.Value
	}
	return fields, true
}

func batchKeys(fields map[string]any, allowed ...string) bool {
	for key := range fields {
		found := false
		for _, candidate := range allowed {
			if key == candidate {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func batchStringEquals(value any, expected string) bool {
	units, ok := value.(jsonvalue.UTF16String)
	if !ok {
		return false
	}
	actual, err := units.UTF8()
	return err == nil && actual == expected
}

func batchID(value any) ([]byte, bool) {
	switch number := value.(type) {
	case jsonvalue.UTF16String:
	case json.Number:
		f, err := jsonvalue.NumberFloat64(number)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f || math.Abs(f) > 9007199254740991 {
			return nil, false
		}
		value = f
	default:
		return nil, false
	}
	encoded, err := canonicaljson.Canonical(value)
	return []byte(encoded), err == nil
}

// replaceEnvelopeID finds the top-level ID token with Decoder.InputOffset.
// It copies every other byte, including nested result/error IDs and text that
// resembles an ID field. Standard JSON decoding is never used for public IDs.
func replaceEnvelopeID(data, id []byte, responseOnly bool) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("mcp batch response must be a JSON-RPC object")
	}
	start, end := -1, -1
	response, method, correlated := false, false, false
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, err
		}
		switch key {
		case "id":
			end = int(decoder.InputOffset())
			start = end - len(raw)
			correlated = bytes.Equal(raw, []byte("0"))
		case "result", "error":
			response = true
		case "method":
			method = true
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if responseOnly && (!response || method || !correlated) {
		return data, nil
	}
	if start < 0 {
		return nil, errors.New("mcp batch response has no correlation ID")
	}
	result := make([]byte, 0, len(data)-end+start+len(id))
	result = append(result, data[:start]...)
	result = append(result, id...)
	result = append(result, data[end:]...)
	return result, nil
}

func restoreBatchResponseID(data, id []byte) ([]byte, error) {
	if len(id) == 0 {
		return data, nil
	}
	return replaceEnvelopeID(data, id, true)
}

type batchOutput struct {
	writer  http.ResponseWriter
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	started bool
	err     error
}

func (output *batchOutput) write(header http.Header, data []byte) error {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.err != nil {
		return output.err
	}
	if err := output.ctx.Err(); err != nil {
		return err
	}
	if !output.started {
		copyBatchHeaders(output.writer.Header(), header)
		output.writer.Header().Set("X-Accel-Buffering", "no")
		output.started = true
	}
	n, err := output.writer.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		output.err = err
		output.cancel()
	}
	return err
}

func (output *batchOutput) flush() error {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.err != nil || !output.started {
		return output.err
	}
	err := http.NewResponseController(output.writer).Flush()
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		output.err = err
		output.cancel()
		return err
	}
	return nil
}

func (output *batchOutput) failure() error {
	output.mu.Lock()
	defer output.mu.Unlock()
	return output.err
}

func (output *batchOutput) fail(err error) error {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.err == nil {
		output.err = err
		output.cancel()
	}
	return output.err
}

type batchMemberWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
	output *batchOutput
	id     []byte
}

func (reply *batchMemberWriter) Header() http.Header { return reply.header }

func (reply *batchMemberWriter) WriteHeader(status int) {
	if reply.status == 0 {
		reply.status = status
	}
}

func (reply *batchMemberWriter) Write(data []byte) (int, error) {
	if reply.status == 0 {
		reply.status = http.StatusOK
	}
	if reply.status != http.StatusOK || !strings.HasPrefix(reply.header.Get("Content-Type"), "text/event-stream") {
		return reply.body.Write(data)
	}
	// v1.7.0 writeEvent supplies one complete SSE event in one Write call.
	// Its JSON data is a single line; all other SSE fields remain untouched.
	start := bytes.Index(data, []byte("data: "))
	if start < 0 || !bytes.HasSuffix(data, []byte("\n\n")) {
		return 0, reply.output.fail(fmt.Errorf("mcp SDK supplied an incomplete batch SSE event"))
	}
	start += len("data: ")
	end := len(data) - 2
	message := data[start:end]
	// Empty-data prime/close control events are not JSON-RPC messages.
	if len(message) != 0 {
		var err error
		message, err = restoreBatchResponseID(message, reply.id)
		if err != nil {
			return 0, reply.output.fail(err)
		}
	}
	event := make([]byte, 0, start+len(message)+2)
	event = append(event, data[:start]...)
	event = append(event, message...)
	event = append(event, '\n', '\n')
	if err := reply.output.write(reply.header, event); err != nil {
		return 0, err
	}
	return len(data), nil
}

func (reply *batchMemberWriter) FlushError() error { return reply.output.flush() }

func copyBatchHeaders(target, source http.Header) {
	for key, values := range source {
		target[key] = append([]string(nil), values...)
	}
}
