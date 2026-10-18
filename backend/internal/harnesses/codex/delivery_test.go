package codex_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
)

func TestTransportRespondsToNumericNativeCallback(t *testing.T) {
	f := newTransportFixture(t, func(options *codex.Options, fixture *transportFixture) {
		options.OnRequest = func(ctx context.Context, request codex.Request) error {
			return fixture.transport.Respond(ctx, request.ID, request.Method, json.RawMessage(`{"decision":"decline"}`))
		}
	})
	f.send(t, map[string]any{"id": 17, "method": "item/commandExecution/requestApproval", "params": map[string]string{"threadId": "thread"}})
	response := f.request(t)
	if string(response["id"]) != "17" || string(response["result"]) != `{"decision":"decline"}` {
		t.Fatalf("native callback identity or response changed: %#v", response)
	}
}

func TestTransportRejectsUnsupportedCallbackWithoutEchoingPayload(t *testing.T) {
	f := newTransportFixture(t, func(options *codex.Options, _ *transportFixture) {
		options.OnRequest = func(context.Context, codex.Request) error { return errors.New("private native payload") }
	})
	f.send(t, map[string]any{"id": "native-string-id", "method": "test/unsupported", "params": map[string]string{"text": "private native payload"}})
	response := f.request(t)
	var detail struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(response["error"], &detail) != nil || detail.Code != -32602 || detail.Message != "Invalid or unsupported native interaction." {
		t.Fatalf("unsupported callback exposed a payload: %s", response["error"])
	}
	if string(response["id"]) != `"native-string-id"` {
		t.Fatal("callback rejection lost its native string identity")
	}
}

func TestTransportResponseValidationPrecedesDelivery(t *testing.T) {
	f := newTransportFixture(t, func(options *codex.Options, _ *transportFixture) {
		options.Protocol = testProtocol{serverResponse: func(string, json.RawMessage) error { return errors.New("wrong answer shape") }}
	})
	err := f.transport.Respond(context.Background(), json.RawMessage(`5`), "item/tool/requestUserInput", json.RawMessage(`{}`))
	var native *codex.Error
	if !errors.As(err, &native) || native.Code != "NATIVE_RESPONSE_INVALID" {
		t.Fatalf("invalid response was not rejected before delivery: %v", err)
	}
	select {
	case response := <-f.requests:
		t.Fatalf("invalid response reached the provider: %#v", response)
	default:
	}
}

func TestTransportNullIDRemainsANotification(t *testing.T) {
	f := newTransportFixture(t, func(options *codex.Options, fixture *transportFixture) {
		options.OnRequest = func(context.Context, codex.Request) error {
			fixture.events <- codex.Notification{Method: "unexpected/server-request"}
			return nil
		}
	})
	f.send(t, map[string]any{"id": nil, "method": "test/event", "params": map[string]any{}})
	if value := event(t, f.events); value.Method != "test/event" {
		t.Fatalf("null native ID became a callback: %#v", value)
	}
}

func TestTransportRedactsKeysValuesAndEmbeddedJSONStringLiterals(t *testing.T) {
	f := newTransportFixture(t, func(options *codex.Options, _ *transportFixture) {
		options.KnownSecrets = []string{"test-secret-long", "test-secret"}
	})
	f.send(t, map[string]any{"method": "test/event", "params": map[string]string{
		"test-secret-long": "test-secret-long",
		"embedded":         `{"value":"test-\u0073ecret-long"}`,
	}})
	value := event(t, f.events)
	var params map[string]string
	if json.Unmarshal(value.Params, &params) != nil || params["[REDACTED]"] != "[REDACTED]" {
		t.Fatalf("native key or value was not redacted: %s", value.Params)
	}
	var embedded map[string]string
	if json.Unmarshal([]byte(params["embedded"]), &embedded) != nil || embedded["value"] != "[REDACTED]" {
		t.Fatalf("escaped native token was not redacted: %s", value.Params)
	}
	if strings.Contains(string(value.Params), "test-secret") {
		t.Fatal("native event exposed a known token")
	}
}

func TestTransportRejectsNonObjectNotificationParams(t *testing.T) {
	f := newTransportFixture(t, nil)
	f.send(t, map[string]any{"method": "test/event", "params": "invalid"})
	value := event(t, f.events)
	if value.Method != "protocol/malformed" || !strings.Contains(string(value.Params), "invalid_notification") {
		t.Fatalf("protocol validator did not receive the actual params: %#v", value)
	}
}
