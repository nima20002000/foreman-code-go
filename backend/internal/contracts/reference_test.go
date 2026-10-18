package contracts_test

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"reflect"
	"sort"
	"strconv"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

type sourceOutcome struct {
	Accepted bool `json:"accepted"`
	Value json.RawMessage `json:"value"`
	JSON string `json:"json"`
	Issues json.RawMessage `json:"issues"`
	Threw json.RawMessage `json:"threw"`
}

type contractVector struct {
	ID string `json:"id"`
	Schema string `json:"schema"`
	Input struct { JSON string `json:"json"`; Undefined bool `json:"undefined"`; UndefinedFields []string `json:"undefinedFields"` } `json:"input"`
	GoApplicable bool `json:"goApplicable"`
	Frozen sourceOutcome `json:"frozen"`
	Candidate sourceOutcome `json:"candidate"`
	Parity bool `json:"parity"`
}

type contractCapture struct {
	SchemaVersion int `json:"schemaVersion"`
	Source struct {
		Reference string `json:"reference"`
		MergedBase string `json:"mergedBase"`
		Candidate struct { Reference string `json:"reference"`; Tree string `json:"tree"` } `json:"candidate"`
	} `json:"source"`
	Vectors []contractVector `json:"vectors"`
	Mismatches []string `json:"mismatches"`
	Thrown []string `json:"thrown"`
	Failures []string `json:"failures"`
}

func generatedRegistry(t *testing.T) *contracts.Registry {
	t.Helper()
	registry, err := contracts.NewGeneratedRegistry()
	if err != nil { t.Fatalf("unmet generated-schema/dependency setup: %v", err) }
	return registry
}

func loadCapture(t *testing.T, environment string, count int, registry *contracts.Registry) contractCapture {
	t.Helper()
	path := os.Getenv(environment)
	if path == "" { t.Fatalf("unmet setup: %s must name actual frozen/candidate capture from terminal CI", environment) }
	data, err := os.ReadFile(path)
	if err != nil { t.Fatal(err) }
	var capture contractCapture
	if err := json.Unmarshal(data, &capture); err != nil { t.Fatal(err) }
	if capture.SchemaVersion != 1 || capture.Source.Reference != contracts.FrozenReference || capture.Source.MergedBase != contracts.MergedBase ||
		capture.Source.Candidate.Reference != registry.Source().Candidate || capture.Source.Candidate.Tree != registry.Source().Tree {
		t.Fatal("unmet setup: capture source differs from this generated candidate")
	}
	if len(capture.Vectors) != count || capture.Mismatches == nil || capture.Thrown == nil || capture.Failures == nil ||
		len(capture.Mismatches) != 0 || len(capture.Thrown) != 0 || len(capture.Failures) != 0 {
		t.Fatal("unmet setup: complete successful source captures are required, independently verified by the terminal ticket")
	}
	seen := map[string]bool{}
	for _, vector := range capture.Vectors {
		if vector.ID == "" || seen[vector.ID] || !vector.Parity || len(vector.Frozen.Threw) != 0 || len(vector.Candidate.Threw) != 0 {
			t.Fatal("unmet setup: duplicate/incomplete source outcomes or unexpected throws")
		}
		seen[vector.ID] = true
	}
	return capture
}

func canonicalValue(t *testing.T, value any) string {
	t.Helper()
	encoded, err := canonicaljson.Canonical(value)
	if err != nil { t.Fatal(err) }
	return encoded
}

func parsed(t *testing.T, data string) any {
	t.Helper()
	value, err := jsonvalue.Parse([]byte(data))
	if err != nil { t.Fatal(err) }
	return value
}

// This public readback matches the capture's tagged JSON representation. The
// separate ordered mode checks JSON.stringify's visible object order as well.
func readback(t *testing.T, input any, ordered, stringify bool) any {
	t.Helper()
	switch value := input.(type) {
	case nil: return map[string]any{"kind": "null"}
	case jsonvalue.UTF16String:
		units := make([]uint16, len(value))
		copy(units, value)
		return map[string]any{"kind": "string", "units": units}
	case bool: return map[string]any{"kind": "boolean", "value": strconv.FormatBool(value)}
	case json.Number:
		number, err := jsonvalue.NumberFloat64(value)
		if err != nil { t.Fatal(err) }
		return readback(t, number, ordered, stringify)
	case float64:
		text := canonicalValue(t, value)
		if !stringify && value == 0 && math.Signbit(value) { text = "-0" }
		return map[string]any{"kind": "number", "value": text}
	case []any:
		items := make([]any, len(value))
		for index, item := range value { items[index] = readback(t, item, ordered, stringify) }
		return map[string]any{"kind": "array", "items": items}
	case jsonvalue.Object:
		members := append(jsonvalue.Object{}, value...)
		if !ordered { sort.Slice(members, func(left, right int) bool { return members[left].Key.IdentityKey() < members[right].Key.IdentityKey() }) }
		result := make([]any, len(members))
		for index, member := range members {
			result[index] = map[string]any{"key": member.Key, "value": readback(t, member.Value, ordered, stringify)}
		}
		return map[string]any{"kind": "object", "members": result}
	default: t.Fatalf("unexpected normalized contract representation %T", input); return nil
	}
}

func assertOutcome(t *testing.T, vector contractVector, value any, err error) {
	t.Helper()
	if vector.Frozen.Accepted {
		if err != nil { t.Fatalf("frozen accepted but generated validator rejected: %v", err) }
		actual := canonicalValue(t, readback(t, value, false, false))
		expected := canonicalValue(t, parsed(t, string(vector.Frozen.Value)))
		if actual != expected { t.Fatalf("normalized readback\ngot %s\nwant %s", actual, expected) }
		actual = canonicalValue(t, readback(t, value, true, true))
		expected = canonicalValue(t, readback(t, parsed(t, vector.Frozen.JSON), true, true))
		if actual != expected { t.Fatalf("JSON readback/order\ngot %s\nwant %s", actual, expected) }
		return
	}
	var rejected *contracts.ValidationError
	if !errors.As(err, &rejected) { t.Fatalf("frozen rejection must reach generated public validation issues, got %v", err) }
	issues := make([]any, len(rejected.Issues))
	for index, issue := range rejected.Issues { issues[index] = issue.JSONValue() }
	actual := canonicalValue(t, issues)
	expected := canonicalValue(t, parsed(t, string(vector.Frozen.Issues)))
	if actual != expected { t.Fatalf("full ordered source issues\ngot %s\nwant %s", actual, expected) }
}

func TestGeneratedAuthReferenceVectors(t *testing.T) {
	registry := generatedRegistry(t)
	capture := loadCapture(t, "AUTH_CONTRACT_VECTORS_FILE", 47, registry)
	count := 0
	for _, vector := range capture.Vectors {
		if !vector.GoApplicable {
			// These two TS-only inputs have no JSON representation. The capture
			// producer checks them; they are not skipped Go behavior test cases.
			if vector.ID != "auth.id.undefined" && vector.ID != "auth.principal.explicit-undefined-agent" { t.Fatalf("unexpected non-JSON case %s", vector.ID) }
			continue
		}
		count++
		t.Run(vector.ID, func(t *testing.T) {
			value, err := registry.Parse(vector.Schema, json.RawMessage(vector.Input.JSON))
			assertOutcome(t, vector, value, err)
		})
	}
	if count != 45 { t.Fatalf("JSON applicable auth cases = %d, want 45", count) }
}

func TestGeneratedAuthTypesPreserveReadback(t *testing.T) {
	registry := generatedRegistry(t)
	capture := loadCapture(t, "AUTH_CONTRACT_VECTORS_FILE", 47, registry)
	for _, vector := range capture.Vectors {
		if !vector.GoApplicable { continue }
		t.Run(vector.ID, func(t *testing.T) {
			var typed any
			var err error
			switch vector.Schema {
			case contracts.IDSchemaID: typed, err = contracts.ParseID(registry, json.RawMessage(vector.Input.JSON))
			case contracts.ManagementActionSchemaID: typed, err = contracts.ParseManagementAction(registry, json.RawMessage(vector.Input.JSON))
			case contracts.ManagementGrantSchemaID: typed, err = contracts.ParseManagementGrant(registry, json.RawMessage(vector.Input.JSON))
			case contracts.ManagementPrincipalSchemaID: typed, err = contracts.ParseManagementPrincipal(registry, json.RawMessage(vector.Input.JSON))
			default: t.Fatalf("unexpected generated auth schema %s", vector.Schema)
			}
			if !vector.Frozen.Accepted { assertOutcome(t, vector, nil, err); return }
			if err != nil { t.Fatal(err) }
			value, err := contracts.JSONValue(typed)
			if err != nil { t.Fatal(err) }
			actual := canonicalValue(t, readback(t, value, true, true))
			expected := canonicalValue(t, readback(t, parsed(t, vector.Frozen.JSON), true, true))
			if actual != expected { t.Fatalf("generated DTO changed source readback\ngot %s\nwant %s", actual, expected) }
		})
	}
}

func TestGeneratedDecodePreservesCachedJSONAndIdentity(t *testing.T) {
	registry := generatedRegistry(t)
	input := parsed(t, `{"id":" \ud800 ","name":" n ","audience":"worker","agentId":" agent ","grants":[{"actions":["agents:read"],"scope":{"workspaceIds":[" w "]}}],"expiresAt":"9999-12-31T23:59:59.999Z","revokedAt":null}`)
	before := canonicalValue(t, input)
	var value contracts.ManagementPrincipal
	if err := registry.DecodeValue(contracts.ManagementPrincipalSchemaID, input, &value); err != nil { t.Fatal(err) }
	if canonicalValue(t, input) != before { t.Fatal("contract normalization mutated the shared parsed request cache") }
	if value.ID.IdentityKey() != (jsonvalue.UTF16String{0xd800}).IdentityKey() || value.ID.IdentityKey() == (jsonvalue.UTF16String{0xfffd}).IdentityKey() {
		t.Fatal("generated principal identity replaced or collapsed lone units")
	}
	agent, present := value.AgentID.Get()
	if !present || !agent.Equal(contracts.TextFromUTF16([]uint16{'a','g','e','n','t'})) { t.Fatal("normalized optional Agent subject changed") }
	workspaceIDs, present := value.Grants[0].Scope.WorkspaceIDs.Get()
	if !present || len(workspaceIDs) != 1 || !workspaceIDs[0].Equal(contracts.TextFromUTF16([]uint16{'w'})) { t.Fatal("generated scope ID array changed") }
	prior := value
	if err := registry.Decode(contracts.ManagementPrincipalSchemaID, json.RawMessage(`{}`), &value); !errors.Is(err, contracts.ErrValidation) { t.Fatalf("invalid public decode = %v", err) }
	if !reflect.DeepEqual(value, prior) { t.Fatal("failed validation mutated destination") }
}

func TestGeneratedCodePointLengthFixture(t *testing.T) {
	registry := generatedRegistry(t)
	path := os.Getenv("GO_CONTRACT_LENGTH_VECTORS_FILE")
	if path == "" { t.Fatal("unmet setup: actual Zod maxLength1 fixture capture is required") }
	data, err := os.ReadFile(path)
	if err != nil { t.Fatal(err) }
	var fixture struct { Schema string `json:"schema"`; Vectors []contractVector `json:"vectors"` }
	if err := json.Unmarshal(data, &fixture); err != nil { t.Fatal(err) }
	if fixture.Schema != "./test-fixture#CodePointLengthOneSchema" || len(fixture.Vectors) != 6 { t.Fatal("unmet setup: complete source code-point fixture is required") }
	seen := map[string]bool{}
	for _, vector := range fixture.Vectors {
		if seen[vector.ID] || len(vector.Frozen.Threw) != 0 { t.Fatal("incomplete/throwing source fixture") }
		seen[vector.ID] = true
		t.Run(vector.ID, func(t *testing.T) {
			value, err := registry.Parse(fixture.Schema, json.RawMessage(vector.Input.JSON))
			assertOutcome(t, vector, value, err)
		})
	}
}
