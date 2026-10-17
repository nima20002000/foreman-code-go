package codex_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
)

func TestTransportRequiresProtocolValidator(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	if _, err := codex.NewTransport(codex.Streams{Input: writer, Output: reader}, codex.Options{}); err == nil {
		t.Fatal("transport accepted an absent protocol validator")
	}
}

func TestTransportCannotBeStartedTwice(t *testing.T) {
	f := newTransportFixture(t, nil)
	var native *codex.Error
	if err := f.transport.Start(context.Background()); !errors.As(err, &native) || native.Code != "CODEX_TRANSPORT_REUSED" {
		t.Fatalf("unexpected second start: %v", err)
	}
}

func TestTransportCorrelatesOutOfOrderResponses(t *testing.T) {
	f := newTransportFixture(t, nil)
	a := asyncRequest(f.transport, context.Background(), "test/echo", json.RawMessage(`{"tag":"a"}`), nil)
	b := asyncRequest(f.transport, context.Background(), "test/echo", json.RawMessage(`{"tag":"b"}`), nil)
	first, second := f.request(t), f.request(t)
	if string(first["id"]) == string(second["id"]) {
		t.Fatal("concurrent native requests reused an identity")
	}
	f.send(t, map[string]any{"id": second["id"], "result": second["params"]})
	f.send(t, map[string]any{"id": first["id"], "result": first["params"]})
	for tag, results := range map[string]<-chan codex.Result{"a": a, "b": b} {
		value := result(t, results)
		var body map[string]string
		if value.Err != nil || json.Unmarshal(value.Value, &body) != nil || body["tag"] != tag {
			t.Fatalf("response crossed request identity: %s %s %v", tag, value.Value, value.Err)
		}
	}
}

func TestTransportAcceptsFragmentedUnicodeAndCRLF(t *testing.T) {
	f := newTransportFixture(t, nil)
	data := []byte("\r\n  \n{\"method\":\"test/event\",\"params\":{\"text\":\"سلام 🌿\"}}\r\n")
	for _, value := range data {
		if _, err := f.output.Write([]byte{value}); err != nil {
			t.Fatal(err)
		}
	}
	value := event(t, f.events)
	var body map[string]string
	if value.Method != "test/event" || json.Unmarshal(value.Params, &body) != nil || body["text"] != "سلام 🌿" {
		t.Fatalf("fragmented native event changed: %#v", value)
	}
}

func TestTransportMalformedFramesDoNotPoisonNextEvent(t *testing.T) {
	f := newTransportFixture(t, nil)
	if _, err := f.output.Write([]byte("{not json}\n[]\n{}\n")); err != nil {
		t.Fatal(err)
	}
	for _, reason := range []string{"invalid_json", "invalid_envelope", "invalid_envelope"} {
		value := event(t, f.events)
		var params map[string]string
		if value.Method != "protocol/malformed" || json.Unmarshal(value.Params, &params) != nil || params["reason"] != reason {
			t.Fatalf("expected malformed %s, got %#v", reason, value)
		}
	}
	f.send(t, map[string]any{"method": "test/after-malformed", "params": map[string]any{"ready": true}})
	if value := event(t, f.events); value.Method != "test/after-malformed" {
		t.Fatalf("transport did not recover framing: %#v", value)
	}
}

func TestTransportCanceledBeforeSubmissionSendsNothing(t *testing.T) {
	f := newTransportFixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := f.transport.Request(ctx, "turn/start", json.RawMessage(`{}`), nil)
	rpcFailure(t, err, "CODEX_APP_SERVER_REQUEST_CANCELED", false)
	select {
	case request := <-f.requests:
		t.Fatalf("canceled command reached native input: %s", request["method"])
	default:
	}
}

func TestTransportCancellationReconcilesLateResponseWithoutReplay(t *testing.T) {
	f := newTransportFixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	late := make(chan codex.Result, 1)
	results := asyncRequest(f.transport, ctx, "turn/start", json.RawMessage(`{}`), func(value codex.Result) { late <- value })
	request := f.request(t)
	cancel()
	failure := rpcFailure(t, result(t, results).Err, "CODEX_APP_SERVER_REQUEST_CANCELED", true)
	if string(failure.OperationID) != string(request["id"]) {
		t.Fatal("uncertain result lost its native operation identity")
	}
	f.send(t, map[string]any{"id": request["id"], "result": map[string]string{"turnId": "accepted-turn"}})
	value := result(t, late)
	if value.Err != nil || !strings.Contains(string(value.Value), "accepted-turn") {
		t.Fatalf("late native result was not reconciled: %s %v", value.Value, value.Err)
	}
	select {
	case duplicate := <-f.requests:
		t.Fatalf("transport replayed native command: %s", duplicate["method"])
	default:
	}
}

func TestTransportTimeoutKeepsSubmissionUncertain(t *testing.T) {
	f := newTransportFixture(t, func(options *codex.Options, _ *transportFixture) { options.RequestTimeout = time.Second })
	results := asyncRequest(f.transport, context.Background(), "thread/start", json.RawMessage(`{}`), nil)
	f.request(t)
	rpcFailure(t, result(t, results).Err, "CODEX_APP_SERVER_TIMEOUT", true)
}

func TestTransportNativeRejectionIsDefiniteAndRedacted(t *testing.T) {
	f := newTransportFixture(t, func(options *codex.Options, _ *transportFixture) {
		options.KnownSecrets = []string{"test-mcp-secret"}
	})
	results := asyncRequest(f.transport, context.Background(), "thread/start", json.RawMessage(`{}`), nil)
	request := f.request(t)
	f.send(t, map[string]any{"id": request["id"], "error": map[string]any{"code": -32601, "message": "private test-mcp-secret native detail"}})
	failure := rpcFailure(t, result(t, results).Err, "CODEX_CONTRACT_UNSUPPORTED", false)
	if strings.Contains(failure.Error(), "native detail") || strings.Contains(failure.NativeMessage, "test-mcp-secret") || !strings.Contains(failure.NativeMessage, "[REDACTED]") {
		t.Fatal("native rejection leaked provider text or an app token")
	}
}

func TestTransportInvalidResponseRetainsLateReconciliation(t *testing.T) {
	f := newTransportFixture(t, nil)
	late := make(chan codex.Result, 1)
	results := asyncRequest(f.transport, context.Background(), "thread/start", json.RawMessage(`{}`), func(value codex.Result) { late <- value })
	request := f.request(t)
	f.send(t, map[string]any{"id": request["id"], "result": "wrong native shape"})
	rpcFailure(t, result(t, results).Err, "CODEX_APP_SERVER_RESPONSE_INVALID", true)
	if value := event(t, f.events); value.Method != "protocol/malformed" {
		t.Fatalf("invalid native response was not reported: %#v", value)
	}
	f.send(t, map[string]any{"id": request["id"], "result": map[string]string{"threadId": "late-thread"}})
	if value := result(t, late); value.Err != nil {
		t.Fatalf("late native identity failed reconciliation: %v", value.Err)
	}
}

func TestTransportRejectsOutboundByteLimitBeforeSubmission(t *testing.T) {
	f := newTransportFixture(t, nil)
	params, err := json.Marshal(map[string]string{"text": strings.Repeat("界", 4*1024*1024/3+1)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.transport.Request(context.Background(), "turn/start", params, nil)
	rpcFailure(t, err, "CODEX_OUTBOUND_FRAME_LIMIT", false)
	select {
	case request := <-f.requests:
		t.Fatalf("oversized request reached native input: %s", request["method"])
	default:
	}
}

func TestTransportRejectsInvalidRequestThroughValidationPort(t *testing.T) {
	f := newTransportFixture(t, func(options *codex.Options, _ *transportFixture) {
		options.Protocol = testProtocol{request: func(request codex.Request) error {
			if request.Method == "turn/start" {
				return &codex.Error{Code: "CODEX_METHOD_UNQUALIFIED", Message: "Native turn method is unavailable."}
			}
			return objectValue(request.Params)
		}}
	})
	_, err := f.transport.Request(context.Background(), "turn/start", json.RawMessage(`{}`), nil)
	rpcFailure(t, err, "CODEX_METHOD_UNQUALIFIED", false)
	select {
	case request := <-f.requests:
		t.Fatalf("unqualified request reached native input: %s", request["method"])
	default:
	}
}

func TestTransportUnknownResponseDoesNotStealCurrentRequest(t *testing.T) {
	f := newTransportFixture(t, nil)
	results := asyncRequest(f.transport, context.Background(), "test/echo", json.RawMessage(`{}`), nil)
	request := f.request(t)
	f.send(t, map[string]any{"id": "unrelated-request", "result": map[string]string{"answer": "wrong"}})
	f.send(t, map[string]any{"id": request["id"], "result": map[string]string{"answer": "right"}})
	value := result(t, results)
	if value.Err != nil || !strings.Contains(string(value.Value), "right") {
		t.Fatalf("uncorrelated native result was accepted: %s %v", value.Value, value.Err)
	}
}

func TestTransportClosesIncompleteFrameAndPendingOperation(t *testing.T) {
	f := newTransportFixture(t, nil)
	results := asyncRequest(f.transport, context.Background(), "thread/start", json.RawMessage(`{}`), nil)
	f.request(t)
	if _, err := f.output.Write([]byte(`{"method":"unfinished`)); err != nil {
		t.Fatal(err)
	}
	if err := f.output.Close(); err != nil {
		t.Fatal(err)
	}
	value := event(t, f.events)
	if !strings.Contains(string(value.Params), "incomplete_frame") {
		t.Fatalf("incomplete provider output was not reported: %#v", value)
	}
	rpcFailure(t, result(t, results).Err, "CODEX_APP_SERVER_DISCONNECTED", true)
	select {
	case <-f.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("missing disconnect notification")
	}
	if f.transport.IsConnected() {
		t.Fatal("closed provider stream remained connected")
	}
}
