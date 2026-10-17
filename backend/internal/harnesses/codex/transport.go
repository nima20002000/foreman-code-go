package codex

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
)

const (
	maxFrameBytes  = 4 * 1024 * 1024
	maxOperations  = 256
	defaultTimeout = 30 * time.Second
)

type operation struct {
	request   Request
	submitted bool
	result    chan Result
	late      func(Result)
	finished  chan struct{}
}

// Transport correlates concurrent requests over newline-delimited stdio. It never
// retries a provider submission and retains uncertain operations for late replies.
type Transport struct {
	streams Streams
	options Options
	prefix  string

	mu         sync.Mutex
	nextID     uint64
	started    bool
	stopped    bool
	operations map[string]*operation
	uncertain  map[string]*operation
	writes     int
	done       chan struct{}
	writer     chan struct{}
	lifetime   context.Context
	cancel     context.CancelFunc
	closeMu    sync.Mutex
	inputDone  bool
	outputDone bool
}

// NewTransport consumes a required validation port and an explicit owned stream.
// It performs no process launch, global discovery, credential reads, or permission changes.
func NewTransport(streams Streams, options Options) (*Transport, error) {
	if streams.Input == nil || streams.Output == nil || options.Protocol == nil {
		return nil, failure("CODEX_PROTOCOL_INVALID", "Codex requires owned streams and a qualified protocol validator.", nil)
	}
	if options.RequestTimeout <= 0 {
		options.RequestTimeout = defaultTimeout
	}
	options.KnownSecrets = prepareSecrets(options.KnownSecrets)
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, failure("CODEX_PROTOCOL_INVALID", "Codex request identity could not be created.", err)
	}
	lifetime, cancel := context.WithCancel(context.Background())
	transport := &Transport{
		streams: streams, options: options, prefix: hex.EncodeToString(nonce[:]),
		operations: make(map[string]*operation), uncertain: make(map[string]*operation),
		done: make(chan struct{}), writer: make(chan struct{}, 1), lifetime: lifetime, cancel: cancel,
	}
	transport.writer <- struct{}{}
	return transport, nil
}

// Start initializes the app-server with the frozen Foreman client capabilities.
// Successful initialization is not a provider-account or qualification receipt.
func (t *Transport) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	t.mu.Lock()
	if t.started || t.stopped {
		t.mu.Unlock()
		return failure("CODEX_TRANSPORT_REUSED", "Create a new provider transport.", nil)
	}
	t.started = true
	t.mu.Unlock()
	go t.readFrames()
	params := protocol.InitializeParams{
		ClientInfo: &protocol.ClientInfo{Name: "foreman-code", Title: protocol.Some("Foreman Code"), Version: "0.1.0"},
		Capabilities: protocol.Some(&protocol.InitializeCapabilities{
			ExperimentalApi: protocol.Some(true),
			Extensions:      protocol.Some(map[string]json.RawMessage{"openai/form": json.RawMessage(`{}`)}),
		}),
	}
	data, err := json.Marshal(params)
	if err == nil {
		_, err = t.Request(ctx, "initialize", data, nil)
	}
	if err == nil {
		_, err = t.write(ctx, Notification{Method: "initialized"})
	}
	if err != nil {
		return errors.Join(err, t.Close())
	}
	return nil
}

// Request validates and submits exactly one native command. A late callback may
// observe a final answer after timeout/cancellation; callers must reconcile it.
func (t *Transport) Request(ctx context.Context, method string, params json.RawMessage, late func(Result)) (json.RawMessage, error) {
	t.mu.Lock()
	t.nextID++
	id, _ := json.Marshal(t.prefix + ":" + strconv.FormatUint(t.nextID, 10))
	t.mu.Unlock()
	request := Request{ID: id, Method: method, Params: append(json.RawMessage(nil), params...)}
	frame, err := t.preflight(ctx, request)
	if err != nil {
		code := "CODEX_PROTOCOL_INVALID"
		var native *Error
		if errors.As(err, &native) {
			code = native.Code
		} else if ctx.Err() != nil {
			code = "CODEX_APP_SERVER_REQUEST_CANCELED"
		}
		return nil, rpcError(method, id, false, code, t.options.Protocol.ProviderVersion(), err)
	}
	requestContext, cancel := context.WithTimeout(ctx, t.options.RequestTimeout)
	defer cancel()
	op := &operation{request: request, result: make(chan Result, 1), late: late, finished: make(chan struct{})}
	key := string(id)
	t.mu.Lock()
	if !t.started || t.stopped {
		t.mu.Unlock()
		return nil, rpcError(method, id, false, "CODEX_APP_SERVER_DISCONNECTED", t.options.Protocol.ProviderVersion(), nil)
	}
	if len(t.operations)+len(t.uncertain) >= maxOperations {
		t.mu.Unlock()
		cause := failure("CODEX_OPERATION_LIMIT", "Too many unresolved provider operations; reconcile before submitting more.", nil)
		return nil, rpcError(method, id, false, cause.Code, t.options.Protocol.ProviderVersion(), cause)
	}
	t.operations[key] = op
	t.mu.Unlock()
	go t.submit(requestContext, ctx, key, op, frame)
	select {
	case result := <-op.result:
		return result.Value, result.Err
	case <-requestContext.Done():
		t.settleFailure(key, requestCancellationCode(ctx))
	case <-t.done:
		t.settleFailure(key, "CODEX_APP_SERVER_DISCONNECTED")
	}
	result := <-op.result
	return result.Value, result.Err
}

func (t *Transport) preflight(ctx context.Context, request Request) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !t.IsConnected() {
		return nil, failure("CODEX_APP_SERVER_DISCONNECTED", "Codex app-server is not connected.", nil)
	}
	if err := t.options.Protocol.Request(request); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	frame, err := encodeFrame(request)
	if err == nil {
		err = ctx.Err()
	}
	return frame, err
}

func requestCancellationCode(caller context.Context) string {
	if caller.Err() != nil {
		return "CODEX_APP_SERVER_REQUEST_CANCELED"
	}
	return "CODEX_APP_SERVER_TIMEOUT"
}

func (t *Transport) submit(ctx, caller context.Context, key string, op *operation, frame []byte) {
	select {
	case <-ctx.Done():
		t.settleFailure(key, requestCancellationCode(caller))
		return
	case <-op.finished:
		return
	case <-t.done:
		return
	case <-t.writer:
	}
	defer func() { t.writer <- struct{}{} }()
	t.mu.Lock()
	if t.stopped || t.operations[key] != op {
		t.mu.Unlock()
		return
	}
	if ctx.Err() != nil {
		t.settleFailureLocked(key, requestCancellationCode(caller))
		t.mu.Unlock()
		return
	}
	// Any attempted write can have reached the provider, including partial writes or EPIPE.
	op.submitted = true
	t.mu.Unlock()
	if err := writeFrame(t.streams.Input, frame); err != nil {
		t.settleFailure(key, "CODEX_APP_SERVER_REQUEST_UNCERTAIN")
	}
}

func encodeFrame(message any) ([]byte, error) {
	frame, err := json.Marshal(message)
	if err != nil {
		return nil, failure("CODEX_PROTOCOL_INVALID", "Codex requires a valid structured request.", err)
	}
	frame = append(frame, '\n')
	if len(frame) > maxFrameBytes {
		return nil, failure("CODEX_OUTBOUND_FRAME_LIMIT", "The provider request exceeds the bounded frame size; nothing was submitted.", nil)
	}
	return frame, nil
}

func writeFrame(writer io.Writer, frame []byte) error {
	for len(frame) > 0 {
		written, err := writer.Write(frame)
		if err != nil {
			return err
		}
		if written <= 0 || written > len(frame) {
			return io.ErrShortWrite
		}
		frame = frame[written:]
	}
	return nil
}

func reconnectRead(method string) bool {
	return method == "thread/read" || method == "thread/turns/list" || method == "thread/items/list"
}

func (t *Transport) settleFailure(key, code string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.settleFailureLocked(key, code)
}

func (t *Transport) settleFailureLocked(key, code string) {
	op := t.operations[key]
	if op == nil {
		return
	}
	delete(t.operations, key)
	close(op.finished)
	if op.submitted && (!reconnectRead(op.request.Method) || op.late != nil) {
		t.uncertain[key] = op
	}
	op.result <- Result{Err: rpcError(op.request.Method, op.request.ID, op.submitted, code, t.options.Protocol.ProviderVersion(), nil)}
}

// IsConnected is a process-local observation, never delivery or physical-exit evidence.
func (t *Transport) IsConnected() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.started && !t.stopped
}

func (t *Transport) stop() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped {
		return false
	}
	t.stopped = true
	t.cancel()
	for key := range t.operations {
		t.settleFailureLocked(key, "CODEX_APP_SERVER_DISCONNECTED")
	}
	close(t.done)
	return true
}

// Close fences requests and closes owned stdio. Failed endpoint cleanup is retried
// by the next explicit Close call; this does not claim that a native process exited.
func (t *Transport) Close() error {
	t.stop()
	t.closeMu.Lock()
	defer t.closeMu.Unlock()
	var inputErr, outputErr error
	if !t.inputDone {
		inputErr = t.streams.Input.Close()
		t.inputDone = inputErr == nil
	}
	if !t.outputDone {
		outputErr = t.streams.Output.Close()
		t.outputDone = outputErr == nil
	}
	return errors.Join(inputErr, outputErr)
}

func (t *Transport) fail(err error) {
	if !t.stop() {
		return
	}
	t.notifyDisconnect(err)
	if closeErr := t.Close(); closeErr != nil && t.options.OnNotification != nil {
		t.malformed("cleanup_failed", "")
	}
}
