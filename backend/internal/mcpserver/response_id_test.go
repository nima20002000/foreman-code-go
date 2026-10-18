package mcpserver_test

import (
	"bytes"
	"encoding/json"
	"testing"
)

// This regression stays compatible with the unmodified merged-base public app
// interface, so terminal can obtain a real pre-fix response-readback failure.
func TestMCPResponseRetainsLosslessStringID(t *testing.T) {
	for _, test := range []struct { name, id, want string }{
		{"lone_high", `"\ud800"`, `"\ud800"`},
		{"lone_low", `"\udc00"`, `"\udc00"`},
		{"surrogate_pair", `"\ud83d\ude00"`, `"😀"`},
		{"literal_replacement", `"\ufffd"`, `"�"`},
		{"lone_and_literal_replacement", `"\ud800\ufffd"`, `"\ud800�"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			const label = `payload � and literal text "id":"�" must survive`
			call, _ := fixture.start(t, "caller-a", test.id, cancellationArguments{Label: label})
			reply := replyWithin(t, call)
			requireToolState(t, reply, "completed")
			object := rpcBody(t, reply)
			if !bytes.Equal(object["id"], []byte(test.want)) {
				t.Fatalf("completed public tool response lost the source string ID: got %s, want %s", object["id"], test.want)
			}
			var result struct { Structured struct { Label string `json:"label"` } `json:"structuredContent"` }
			if err := json.Unmarshal(object["result"], &result); err != nil { t.Fatal(err) }
			if result.Structured.Label != label {
				t.Fatalf("restoring the RPC ID changed tool payload text: got %q", result.Structured.Label)
			}
		})
	}
}

func TestMCPResponseKeepsStringAndNumberIDsDistinct(t *testing.T) {
	for _, test := range []struct { name, id, want string }{
		{"string", `"7"`, `"7"`},
		{"number", `7.0`, `7`},
		{"empty_string", `""`, `""`},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			call, _ := fixture.start(t, "caller-a", test.id, cancellationArguments{Label: "typed-id"})
			reply := replyWithin(t, call)
			requireToolState(t, reply, "completed")
			if id := rpcBody(t, reply)["id"]; !bytes.Equal(id, []byte(test.want)) {
				t.Fatalf("public response ID type/value changed: got%s want%s", id, test.want)
			}
		})
	}
}
