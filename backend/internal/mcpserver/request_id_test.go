package mcpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strings"
	"testing"
)

// These calls use the actual registered HTTP/SDK boundary. A registry-key unit
// check cannot establish request admission or response ID readback parity.
func TestMCPPreservesValidNumericRequestResponseIDs(t *testing.T) {
	for _, test := range []struct {
		name string
		id   string
		want float64
	}{
		{"integer", "7", 7},
		{"decimal", "7.0", 7},
		{"exponent", "7e0", 7},
		{"negative_zero", "-0", 0},
		{"rounded_integer", "1.0000000000000001", 1},
		{"underflow_zero", "1e-5000", 0},
		{"maximum_safe", "9007199254740991", 9007199254740991},
		{"minimum_safe", "-9007199254740991", -9007199254740991},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			call, _ := fixture.start(t, "caller-a", test.id, cancellationArguments{Label: "numeric"})
			reply := replyWithin(t, call)
			requireToolState(t, reply, "completed")
			var id float64
			if err := json.Unmarshal(rpcBody(t, reply)["id"], &id); err != nil {
				t.Fatalf("numeric response ID did not remain a JSON number: %v", err)
			}
			if id != test.want || id == 0 && math.Signbit(id) {
				t.Fatalf("public response ID %v, want JavaScript JSON readback %v", id, test.want)
			}
			if fixture.invocations.Load() != 1 { t.Fatal("valid numeric request did not invoke exactly one tool") }
		})
	}
}

func TestMCPRejectsSourceInvalidNumericAndNullIDs(t *testing.T) {
	for _, test := range []struct { name, id string }{
		{"fraction", "1.5"},
		{"negative_fraction", "-1.5"},
		{"above_safe", "9007199254740992"},
		{"below_safe", "-9007199254740992"},
		{"rounded_unsafe", "9007199254740993"},
		{"large_integer", "1e30"},
		{"positive_overflow", "1e400"},
		{"negative_overflow", "-1e400"},
		{"null", "null"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			ctx, cancel := context.WithTimeout(context.Background(), cancellationWait)
			defer cancel()
			reply := fixture.post(ctx, "caller-a", idCall(test.id))
			if reply.err != nil { t.Fatal(reply.err) }
			if reply.status != 400 || !strings.HasPrefix(reply.header.Get("Content-Type"), "application/json") {
				t.Fatalf("source-invalid ID %s reached the wrong public response: status%d %s", test.id, reply.status, reply.body)
			}
			requireRPCIDFailure(t, reply, -32700, "Parse error: Invalid JSON-RPC message")
			if fixture.invocations.Load() != 0 { t.Fatal("source-invalid ID invoked a public tool") }
		})
	}
}

func TestMCPNumericIDAdmissionPreservesHeaderAndAuthOrder(t *testing.T) {
	for _, test := range []struct {
		name, token, body, accept string
		status int
		code string
	}{
		{"accept_before_id", "caller-a", idCall("1.5"), "application/json", 406, "rpc"},
		{"body_before_accept", "caller-a", `{"jsonrpc":"2.0","id":1.5`, "application/json", 400, "INVALID_REQUEST"},
		{"auth_before_body_and_accept", "invalid", `{"jsonrpc":"2.0","id":1.5`, "application/json", 401, "AUTH_REQUIRED"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			ctx, cancel := context.WithTimeout(context.Background(), cancellationWait)
			defer cancel()
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, fixture.server.URL+"/mcp", strings.NewReader(test.body))
			if err != nil { t.Fatal(err) }
			request.Header.Set("Authorization", "Bearer "+test.token)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Accept", test.accept)
			request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
			response, err := fixture.client.Do(request)
			if err != nil { t.Fatal(err) }
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil { t.Fatal(err) }
			if response.StatusCode != test.status {
				t.Fatalf("ordered public rejection status%d, want%d: %s", response.StatusCode, test.status, body)
			}
			if test.code == "rpc" {
				requireRPCIDFailure(t, cancellationReply{status: response.StatusCode, header: response.Header, body: body},
					-32000, "Not Acceptable: Client must accept both application/json and text/event-stream")
			} else if !bytes.Contains(body, []byte(`"code":"`+test.code+`"`)) {
				t.Fatalf("ordered domain rejection lost code %s: %s", test.code, body)
			}
			if fixture.invocations.Load() != 0 { t.Fatal("rejected request invoked a public tool") }
		})
	}
}

func idCall(id string) string {
	return `{"jsonrpc":"2.0","id":`+id+`,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"id"}}}`
}

func requireRPCIDFailure(t *testing.T, reply cancellationReply, code int, message string) {
	t.Helper()
	object := rpcBody(t, reply)
	if !bytes.Equal(object["id"], []byte("null")) { t.Fatalf("protocol rejection ID must remain null: %s", reply.body) }
	var failure struct { Code int `json:"code"`; Message string `json:"message"` }
	if err := json.Unmarshal(object["error"], &failure); err != nil { t.Fatal(err) }
	if failure.Code != code || failure.Message != message {
		t.Fatalf("protocol rejection %#v, want code%d and %q", failure, code, message)
	}
}
