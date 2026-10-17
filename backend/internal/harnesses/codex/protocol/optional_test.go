package protocol_test

import (
	"encoding/json"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
)

func TestGeneratedNativeParametersPreserveOmissionNullAndFalse(t *testing.T) {
	params := protocol.V2ThreadStartParams{
		Ephemeral: protocol.Some(false), ServiceTier: protocol.Null[string](),
		Sandbox: protocol.Some(protocol.V2SandboxMode("read-only")),
	}
	data, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(data, &body) != nil {
		t.Fatalf("invalid native params: %s", data)
	}
	if len(body) != 3 || string(body["ephemeral"]) != "false" || string(body["serviceTier"]) != "null" || string(body["sandbox"]) != `"read-only"` {
		t.Fatalf("native optional settings changed meaning: %s", data)
	}
	var decoded protocol.V2ThreadStartParams
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if value, present, null := decoded.Ephemeral.Value(); value || !present || null {
		t.Fatal("explicit false did not survive native readback")
	}
	if _, present, null := decoded.ServiceTier.Value(); !present || !null {
		t.Fatal("explicit native reset did not survive readback")
	}
	if _, present, _ := decoded.Cwd.Value(); present {
		t.Fatal("omitted native cwd became explicit")
	}
}

func TestGeneratedNativeTurnPreservesUnionPayload(t *testing.T) {
	params := protocol.V2TurnStartParams{
		ThreadID: "native-thread", Input: []protocol.V2UserInput{json.RawMessage(`{"type":"text","text":"hello","text_elements":[]}`)},
	}
	data, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var decoded protocol.V2TurnStartParams
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ThreadID != "native-thread" || len(decoded.Input) != 1 || string(decoded.Input[0]) != string(params.Input[0]) {
		t.Fatalf("native union payload changed in roundtrip: %s", data)
	}
}
