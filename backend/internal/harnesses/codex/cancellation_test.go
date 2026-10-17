package codex_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
)

// gatedInput is an owned stdio endpoint. It lets tests observe a write attempt
// and hold that attempt without requiring a native installation or real process.
type gatedInput struct {
	input io.WriteCloser
	match func(map[string]json.RawMessage) bool
	entered chan struct{}
	release chan struct{}
	closed chan struct{}
	enterOnce sync.Once
	releaseOnce sync.Once
	closeOnce sync.Once
}

func newGatedInput(input io.WriteCloser, match func(map[string]json.RawMessage) bool) *gatedInput {
	return &gatedInput{input: input, match: match, entered: make(chan struct{}), release: make(chan struct{}), closed: make(chan struct{})}
}

func (input *gatedInput) Write(frame []byte) (int, error) {
	var message map[string]json.RawMessage
	if json.Unmarshal(frame, &message) == nil && input.match(message) {
		input.enterOnce.Do(func() { close(input.entered) })
		select {
		case <-input.release:
		case <-input.closed:
			return 0, io.ErrClosedPipe
		}
	}
	return input.input.Write(frame)
}

func (input *gatedInput) Close() error {
	input.closeOnce.Do(func() { close(input.closed) })
	return input.input.Close()
}

func (input *gatedInput) allow() {
	input.releaseOnce.Do(func() { close(input.release) })
}

func (input *gatedInput) wait(t *testing.T) {
	t.Helper()
	select {
	case <-input.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("owned provider input did not receive the gated write")
	}
}

func blockingMethod(message map[string]json.RawMessage) bool {
	return string(message["method"]) == `"test/blocked-write"`
}

func deliveryFailure(t *testing.T, err error, code string) {
	t.Helper()
	var native *codex.Error
	if !errors.As(err, &native) || native.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func finishBlockedRequest(t *testing.T, f *transportFixture, gate *gatedInput, pending <-chan codex.Result) {
	t.Helper()
	gate.allow()
	request := f.request(t)
	if !blockingMethod(request) {
		t.Fatalf("unexpected native command before blocked request: %s", request["method"])
	}
	f.send(t, map[string]any{"id": request["id"], "result": map[string]any{}})
	if value := result(t, pending); value.Err != nil {
		t.Fatalf("original blocked request failed: %v", value.Err)
	}
	// A subsequent correlated request proves that a canceled command or callback
	// did not remain queued behind the earlier writer.
	next := asyncRequest(f.transport, context.Background(), "test/after-cancel", json.RawMessage(`{}`), nil)
	request = f.request(t)
	if string(request["method"]) != `"test/after-cancel"` {
		t.Fatalf("canceled command or callback reached native input: %#v", request)
	}
	f.send(t, map[string]any{"id": request["id"], "result": map[string]any{}})
	if value := result(t, next); value.Err != nil {
		t.Fatalf("provider connection did not recover after cancellation: %v", value.Err)
	}
}

func TestTransportCancellationDuringValidationSendsNothing(t *testing.T) {
	// Repetition exercises the native write boundary under either scheduler order;
	// no private transport fields or source text are inspected.
	for attempt := 0; attempt < 32; attempt++ {
		ctx, cancel := context.WithCancel(context.Background())
		f := newTransportFixture(t, func(options *codex.Options, _ *transportFixture) {
			options.Protocol = testProtocol{request: func(request codex.Request) error {
				if request.Method == "turn/start" {
					cancel()
				}
				return objectValue(request.Params)
			}}
		})
		_, err := f.transport.Request(ctx, "turn/start", json.RawMessage(`{}`), nil)
		cancel()
		rpcFailure(t, err, "CODEX_APP_SERVER_REQUEST_CANCELED", false)
		select {
		case request := <-f.requests:
			t.Fatalf("command canceled during validation reached native input: %s", request["method"])
		default:
		}
		if err := f.transport.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTransportQueuedRequestCancellationSendsNothing(t *testing.T) {
	var gate *gatedInput
	validated := make(chan struct{})
	f := newTransportFixture(t, func(options *codex.Options, fixture *transportFixture) {
		fixture.wrapInput = func(input io.WriteCloser) io.WriteCloser {
			gate = newGatedInput(input, blockingMethod)
			return gate
		}
		options.Protocol = testProtocol{request: func(request codex.Request) error {
			if request.Method == "turn/start" {
				close(validated)
			}
			return objectValue(request.Params)
		}}
	})
	blocked := asyncRequest(f.transport, context.Background(), "test/blocked-write", json.RawMessage(`{}`), nil)
	gate.wait(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	queued := asyncRequest(f.transport, ctx, "turn/start", json.RawMessage(`{}`), nil)
	select {
	case <-validated:
	case <-time.After(5 * time.Second):
		t.Fatal("queued request did not reach the public validation port")
	}
	cancel()
	rpcFailure(t, result(t, queued).Err, "CODEX_APP_SERVER_REQUEST_CANCELED", false)
	finishBlockedRequest(t, f, gate, blocked)
}

func TestTransportCanceledResponseBeforeWriteIsDefinite(t *testing.T) {
	var gate *gatedInput
	f := newTransportFixture(t, func(_ *codex.Options, fixture *transportFixture) {
		fixture.wrapInput = func(input io.WriteCloser) io.WriteCloser {
			gate = newGatedInput(input, blockingMethod)
			return gate
		}
	})
	blocked := asyncRequest(f.transport, context.Background(), "test/blocked-write", json.RawMessage(`{}`), nil)
	gate.wait(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := f.transport.Respond(ctx, json.RawMessage(`17`), "item/commandExecution/requestApproval", json.RawMessage(`{"decision":"decline"}`))
	deliveryFailure(t, err, "NATIVE_RESPONSE_DELIVERY_FAILED")
	finishBlockedRequest(t, f, gate, blocked)
}

func TestTransportResponseCancellationAfterWriteIsUncertain(t *testing.T) {
	var gate *gatedInput
	f := newTransportFixture(t, func(_ *codex.Options, fixture *transportFixture) {
		fixture.wrapInput = func(input io.WriteCloser) io.WriteCloser {
			gate = newGatedInput(input, func(message map[string]json.RawMessage) bool { return string(message["id"]) == "17" })
			return gate
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	response := make(chan error, 1)
	go func() {
		response <- f.transport.Respond(ctx, json.RawMessage(`17`), "item/commandExecution/requestApproval", json.RawMessage(`{"decision":"decline"}`))
	}()
	gate.wait(t)
	cancel()
	select {
	case err := <-response:
		deliveryFailure(t, err, "NATIVE_RESPONSE_DELIVERY_UNCERTAIN")
	case <-time.After(5 * time.Second):
		t.Fatal("submitted callback cancellation did not settle")
	}
	gate.allow()
	written := f.request(t)
	if string(written["id"]) != "17" || string(written["result"]) != `{"decision":"decline"}` {
		t.Fatalf("submitted callback changed after caller cancellation: %#v", written)
	}
}
