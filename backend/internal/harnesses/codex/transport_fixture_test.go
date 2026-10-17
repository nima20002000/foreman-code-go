package codex_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
)

// This is an injected test validator, not a qualification/admission receipt.
// Production validation must come from the installed binary's emitted schema.
type testProtocol struct {
	request        func(codex.Request) error
	response       func(string, json.RawMessage) error
	serverRequest  func(codex.Request) error
	serverResponse func(string, json.RawMessage) error
}

func (testProtocol) ProviderVersion() string { return "codex-cli 0.154.0" }

func (p testProtocol) Request(request codex.Request) error {
	if p.request != nil {
		return p.request(request)
	}
	return objectValue(request.Params)
}

func (p testProtocol) Response(method string, value json.RawMessage) error {
	if p.response != nil {
		return p.response(method, value)
	}
	return objectValue(value)
}

func (testProtocol) Notification(notification codex.Notification) error {
	return objectValue(notification.Params)
}

func (p testProtocol) ServerRequest(request codex.Request) error {
	if p.serverRequest != nil {
		return p.serverRequest(request)
	}
	return objectValue(request.Params)
}

func (p testProtocol) ServerResponse(method string, value json.RawMessage) error {
	if p.serverResponse != nil {
		return p.serverResponse(method, value)
	}
	return objectValue(value)
}

func objectValue(value json.RawMessage) error {
	var object map[string]json.RawMessage
	if json.Unmarshal(value, &object) != nil || object == nil {
		return errors.New("test protocol requires an object")
	}
	return nil
}

type transportFixture struct {
	transport *codex.Transport
	input     *io.PipeReader
	output    *io.PipeWriter
	requests  chan map[string]json.RawMessage
	events    chan codex.Notification
	closed    chan error
	wrapInput func(io.WriteCloser) io.WriteCloser
}

func newTransportFixture(t *testing.T, configure func(*codex.Options, *transportFixture)) *transportFixture {
	t.Helper()
	providerInput, clientInput := io.Pipe()
	clientOutput, providerOutput := io.Pipe()
	f := &transportFixture{
		input: providerInput, output: providerOutput,
		requests: make(chan map[string]json.RawMessage, 512),
		events: make(chan codex.Notification, 512), closed: make(chan error, 4),
	}
	options := codex.Options{
		Protocol: testProtocol{}, RequestTimeout: 5 * time.Second,
		OnNotification: func(value codex.Notification) { f.events <- value },
		OnDisconnect: func(err error) { f.closed <- err },
	}
	if configure != nil {
		configure(&options, f)
	}
	var input io.WriteCloser = clientInput
	if f.wrapInput != nil {
		input = f.wrapInput(input)
	}
	var err error
	f.transport, err = codex.NewTransport(codex.Streams{Input: input, Output: clientOutput}, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := f.transport.Close(); err != nil {
			t.Error(err)
		}
		_ = f.input.Close()
		_ = f.output.Close()
	})
	go func() {
		decoder := json.NewDecoder(f.input)
		for {
			var request map[string]json.RawMessage
			if decoder.Decode(&request) != nil {
				return
			}
			var method string
			_ = json.Unmarshal(request["method"], &method)
			if method == "initialize" {
				response, _ := json.Marshal(map[string]any{"id": request["id"], "result": map[string]any{
					"userAgent": "codex-cli 0.154.0", "codexHome": "/test-only", "platformFamily": "unix", "platformOs": "linux",
				}})
				if _, err := f.output.Write(append(response, '\n')); err != nil {
					return
				}
			} else if method != "initialized" {
				f.requests <- request
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.transport.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *transportFixture) request(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	select {
	case request := <-f.requests:
		return request
	case <-time.After(5 * time.Second):
		t.Fatal("no native request arrived")
		return nil
	}
}

func (f *transportFixture) send(t *testing.T, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.output.Write(append(data, '\n')); err != nil {
		t.Fatal(err)
	}
}

func event(t *testing.T, events <-chan codex.Notification) codex.Notification {
	t.Helper()
	select {
	case value := <-events:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("no native event arrived")
		return codex.Notification{}
	}
}

func result(t *testing.T, results <-chan codex.Result) codex.Result {
	t.Helper()
	select {
	case value := <-results:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("native request did not settle")
		return codex.Result{}
	}
}

func asyncRequest(transport *codex.Transport, ctx context.Context, method string, params json.RawMessage, late func(codex.Result)) <-chan codex.Result {
	results := make(chan codex.Result, 1)
	go func() {
		value, err := transport.Request(ctx, method, params, late)
		results <- codex.Result{Value: value, Err: err}
	}()
	return results
}

func rpcFailure(t *testing.T, err error, code string, uncertain bool) *codex.RPCError {
	t.Helper()
	var rpc *codex.RPCError
	if !errors.As(err, &rpc) || rpc.FailureCode() != code || rpc.Uncertain != uncertain {
		t.Fatalf("expected %s uncertain=%v; got %#v", code, uncertain, err)
	}
	return rpc
}
