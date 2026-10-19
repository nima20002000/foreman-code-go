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
	"sync/atomic"

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
	notification  bool
	initialize    bool
	cancelID      []byte
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
	for _, message := range messages {
		if message.initialize && len(messages) > 1 {
			w.Header().Set("Content-Type", "application/json")
			accept := request.Header.Get("Accept")
			if !strings.Contains(accept, "application/json") || !strings.Contains(accept, "text/event-stream") {
				w.WriteHeader(http.StatusNotAcceptable)
				_, err := io.WriteString(w, `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}`)
				return err
			}
			w.WriteHeader(http.StatusBadRequest)
			_, err := io.WriteString(w, `{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request: Only one initialization request is allowed"},"id":null}`)
			return err
		}
	}

	return r.runBatch(w, request, messages)
}

func (r *Registry) runBatch(w http.ResponseWriter, request *http.Request, messages []batchMessage) error {
	// Follow caller cancellation while its response is pending. Once all public
	// response slots are filled, an older overwritten duplicate controller can
	// outlive the frozen server's close. Keep its SDK handler alive to finish.
	ctx, cancel := context.WithCancel(context.WithoutCancel(request.Context()))
	output := newBatchOutput(w, ctx, cancel, messages)
	stopCancellation := context.AfterFunc(request.Context(), output.cancelRequest)
	output.stopCancellation = stopCancellation
	pendingDone := make(chan struct{})
	byID := make(map[string]*batchCall)
	defer func() {
		stopCancellation()
		if output.finished() {
			// Foreman's frozen HTTP close closes the server. Protocol close
			// aborts the controller still mapped by public ID, while an older
			// overwritten controller is no longer in that map.
			for _, call := range byID {
				if !call.handlerFinished.Load() {
					call.abort()
				}
			}
			go func() { <-pendingDone; cancel() }()
		} else {
			cancel()
		}
	}()
	handlers := make([]*mcp.StreamableHTTPHandler, len(messages))
	calls := make([]*batchCall, len(messages))
	replies := make([]*batchMemberWriter, len(messages))
	var admissions sync.WaitGroup
	admissions.Add(len(messages))
	admissionsDone := make(chan struct{})
	for i, message := range messages {
		toolContext := ctx
		if message.call {
			calls[i] = newBatchCall(ctx)
			toolContext = calls[i].ctx
		}
		server, err := r.serverFor(toolContext, message.requestedTool)
		if err != nil {
			return err
		}
		if message.call {
			addBatchMethodFallback(server, message.method)
		}
		if message.call && batchHasController(message.method) {
			// The frozen protocol registers controllers before notification
			// microtasks, with the last controller winning a duplicate ID.
			// Its tool-only server has fewer handlers than the Go method table.
			byID[string(message.id)] = calls[i]
		}
		reply := &batchMemberWriter{
			header: make(http.Header), output: output, id: message.id,
			call: calls[i], admissionsDone: admissionsDone, admitted: admissions.Done,
			unregistered: message.call && !batchHasController(message.method),
		}
		replies[i] = reply
		server.AddReceivingMiddleware(reply.receivingMiddleware)
		handlers[i] = r.streamableHandler(server)
	}

	// The frozen TS transport dispatches without awaiting earlier members.
	// SSE streams completions; JSON uses distinct public IDs in input order.
	var pending sync.WaitGroup
	var notifications sync.WaitGroup
	for i, message := range messages {
		reply := replies[i]
		memberRequest := request.Clone(ctx)
		memberRequest.Body = io.NopCloser(bytes.NewReader(message.body))
		memberRequest.ContentLength = int64(len(message.body))
		memberRequest.GetBody = nil
		pending.Add(1)
		if message.notification {
			notifications.Add(1)
		}
		go func() {
			defer pending.Done()
			defer reply.finishAdmission(message)
			if message.notification {
				defer notifications.Done()
			}
			handlers[i].ServeHTTP(reply, memberRequest)
			if reply.unregisteredDispatchError(message) {
				reply.writeMethodNotFound(r.opts.JSONResponse)
			}
			// Keep the real HTTP transport alive. This cancellation signal is
			// for the selected tool only, after the SDK admits the notification.
			if reply.status == http.StatusAccepted && len(message.cancelID) > 0 {
				if call := byID[string(message.cancelID)]; call != nil {
					call.abort()
				}
			}
		}()
	}
	go func() { pending.Wait(); close(pendingDone) }()
	admissions.Wait()
	notifications.Wait()
	for i, reply := range replies {
		if reply.admissionError != nil {
			return reply.admissionError.write(w, messages[i].id)
		}
	}
	// Every member has passed the official HTTP gates or returned its exact
	// ignored-notification result. Cancellation notifications are applied before
	// a final response can be published, matching frozen Promise continuations.
	close(admissionsDone)
	select {
	case <-ctx.Done():
		return output.failure()
	case <-output.done:
		return nil
	case <-pendingDone:
	}
	if err := output.failure(); err != nil || ctx.Err() != nil || output.finished() {
		return err
	}
	for i, reply := range replies {
		if reply.status >= http.StatusBadRequest && !reply.ignoredNotification(messages[i]) {
			// Retain a post-dispatch SDK HTTP error too. Once SSE has started,
			// net/http's abort sentinel prevents a fabricated second response.
			if output.started {
				panic(http.ErrAbortHandler)
			}
			failure := &batchHTTPError{header: reply.header, status: reply.status, body: reply.body.Bytes()}
			return failure.write(w, messages[i].id)
		}
	}
	if output.cancelledSlotPending(messages, calls) {
		// An aborted unique public ID has no response. Another completion with
		// that same ID can fill the slot; otherwise the real HTTP peer must end
		// the pending JSON response or SSE stream itself.
		<-ctx.Done()
		return output.failure()
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
		message.initialize = batchInitialize(fields)
		if transport.Method == "tools/call" {
			message.requestedTool = transport.Params.Name
		}
		_, hasMethod := fields["method"]
		id, hasID := fields["id"]
		message.call = hasMethod && hasID
		message.notification = hasMethod && !hasID
		if message.notification {
			message.cancelID = batchCancellationID(fields)
		}
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
	writer           http.ResponseWriter
	ctx              context.Context
	cancel           context.CancelFunc
	stopCancellation func() bool
	mu               sync.Mutex
	started          bool
	complete         bool
	delivery         atomic.Uint32
	err              error
	ids              []string
	responses        map[string][]byte
	received         int
	done             chan struct{}
}

func newBatchOutput(w http.ResponseWriter, ctx context.Context, cancel context.CancelFunc, messages []batchMessage) *batchOutput {
	output := &batchOutput{
		writer: w, ctx: ctx, cancel: cancel,
		responses: make(map[string][]byte), done: make(chan struct{}),
	}
	for _, message := range messages {
		if !message.call {
			continue
		}
		id := string(message.id)
		if _, exists := output.responses[id]; !exists {
			output.ids = append(output.ids, id)
			output.responses[id] = nil
		}
	}
	return output
}

func (output *batchOutput) write(header http.Header, data, id []byte, final bool) error {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.complete {
		return io.ErrClosedPipe
	}
	if output.err != nil {
		return output.err
	}
	if err := output.ctx.Err(); err != nil {
		return err
	}
	finishes := false
	if final {
		finishes = output.recordResponseLocked(string(id), data)
	}
	if err := output.writeLocked(header, data); err != nil {
		return err
	}
	if finishes {
		if err := output.flushLocked(); err != nil {
			return err
		}
		return output.retireLocked()
	}
	return nil
}

// Frozen JSON response slots use public Map keys: insertion order is the first
// occurrence of an ID, and a later response replaces that ID's earlier value
// while other distinct IDs are pending. SSE still emits every such completion.
func (output *batchOutput) writeJSON(id, data []byte) error {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.complete {
		return io.ErrClosedPipe
	}
	if output.err != nil {
		return output.err
	}
	if err := output.ctx.Err(); err != nil {
		return err
	}
	if !output.recordResponseLocked(string(id), data) {
		return nil
	}
	results := make([][]byte, 0, len(output.ids))
	for _, id := range output.ids {
		results = append(results, output.responses[id])
	}
	body := results[0]
	if len(results) > 1 {
		body = append([]byte{'['}, bytes.Join(results, []byte{','})...)
		body = append(body, ']')
	}
	if err := output.writeLocked(http.Header{"Content-Type": {"application/json"}}, body); err != nil {
		return err
	}
	return output.retireLocked()
}

func (output *batchOutput) retireLocked() error {
	// A caller disconnect and successful final delivery have one ordering. The
	// caller path never waits for the writer mutex, so a stalled Write or Flush
	// cannot keep live tool contexts from observing a real HTTP cancellation.
	if !output.delivery.CompareAndSwap(0, 1) {
		output.cancel()
		return context.Canceled
	}
	output.complete = true
	output.stopCancellation()
	close(output.done)
	return nil
}

func (output *batchOutput) recordResponseLocked(id string, data []byte) bool {
	if output.responses[id] == nil {
		output.received++
	}
	output.responses[id] = append([]byte(nil), data...)
	return output.received == len(output.responses)
}

func (output *batchOutput) writeLocked(header http.Header, data []byte) error {
	if !output.started {
		copyBatchHeaders(output.writer.Header(), header)
		if strings.HasPrefix(header.Get("Content-Type"), "text/event-stream") {
			output.writer.Header().Set("X-Accel-Buffering", "no")
		}
		output.started = true
	}
	n, err := output.writer.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		output.err = err
		output.delivery.CompareAndSwap(0, 2)
		output.cancel()
	}
	return err
}

func (output *batchOutput) flush() error {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.err != nil || !output.started || output.complete {
		return output.err
	}
	if err := output.ctx.Err(); err != nil {
		return err
	}
	return output.flushLocked()
}

func (output *batchOutput) flushLocked() error {
	err := http.NewResponseController(output.writer).Flush()
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		output.err = err
		output.delivery.CompareAndSwap(0, 2)
		output.cancel()
		return err
	}
	return nil
}

func (output *batchOutput) finished() bool {
	output.mu.Lock()
	defer output.mu.Unlock()
	return output.complete
}

func (output *batchOutput) cancelRequest() {
	if output.delivery.CompareAndSwap(0, 2) {
		output.cancel()
	}
}

func (output *batchOutput) cancelledSlotPending(messages []batchMessage, calls []*batchCall) bool {
	output.mu.Lock()
	defer output.mu.Unlock()
	for i, call := range calls {
		if call != nil && call.cancelled.Load() && output.responses[string(messages[i].id)] == nil {
			return true
		}
	}
	return false
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
		output.delivery.CompareAndSwap(0, 2)
		output.cancel()
	}
	return output.err
}

type batchMemberWriter struct {
	header         http.Header
	status         int
	body           bytes.Buffer
	output         *batchOutput
	id             []byte
	call           *batchCall
	admissionsDone <-chan struct{}
	admitted       func()
	admissionOnce  sync.Once
	admissionError *batchHTTPError
	unregistered   bool
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
	if reply.status != http.StatusOK {
		return reply.body.Write(data)
	}
	reply.allowAdmission()
	select {
	case <-reply.admissionsDone:
	case <-reply.output.ctx.Done():
		return 0, reply.output.ctx.Err()
	}
	if strings.HasPrefix(reply.header.Get("Content-Type"), "application/json") && batchFinalResponse(data) {
		if reply.call != nil && reply.call.cancelled.Load() {
			return len(data), nil
		}
		message := data
		if reply.unregistered {
			message = []byte(batchMethodNotFoundResponse)
		}
		message, err := restoreBatchResponseID(message, reply.id)
		if err != nil {
			return 0, reply.output.fail(err)
		}
		if err := reply.output.writeJSON(reply.id, message); err != nil {
			return 0, err
		}
		return len(data), nil
	}
	if !strings.HasPrefix(reply.header.Get("Content-Type"), "text/event-stream") {
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
	final := batchFinalResponse(message)
	// Empty-data prime/close control events are not JSON-RPC messages.
	if len(message) != 0 {
		if reply.call != nil && final && reply.call.cancelled.Load() {
			return len(data), nil
		}
		if reply.unregistered && final {
			message = []byte(batchMethodNotFoundResponse)
		}
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
	if err := reply.output.write(reply.header, event, reply.id, final); err != nil {
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
