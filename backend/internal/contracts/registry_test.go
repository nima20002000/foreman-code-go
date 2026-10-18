package contracts_test

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
)

func executionManifest(t *testing.T) map[string]any {
	t.Helper()
	path := os.Getenv("GO_CONTRACT_MANIFEST_FILE")
	if path == "" { t.Fatal("unmet setup: actual selected execution manifest is required") }
	data, err := os.ReadFile(path)
	if err != nil { t.Fatal(err) }
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil { t.Fatal(err) }
	return value
}

func TestRegistryRejectsUnsupportedExecution(t *testing.T) {
	for _, test := range []struct {
		name string
		mutate func(map[string]any)
	}{
		{"missing_descriptor", func(value map[string]any) { delete(value["schemas"].([]any)[0].(map[string]any), "runtime") }},
		{"custom_error_policy", func(value map[string]any) { value["schemas"].([]any)[0].(map[string]any)["runtime"].(map[string]any)["errorPolicy"] = "custom" }},
		{"unknown_node", func(value map[string]any) { value["schemas"].([]any)[0].(map[string]any)["runtime"].(map[string]any)["root"] = map[string]any{"kind": "transform", "checks": []any{}} }},
		{"unknown_extension", func(value map[string]any) { value["schemas"].([]any)[0].(map[string]any)["output"].(map[string]any)["x-unhandled"] = true }},
		{"external_ref", func(value map[string]any) { value["schemas"].([]any)[0].(map[string]any)["output"].(map[string]any)["$ref"] = "https://invalid.example/never-requested" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			manifest := executionManifest(t)
			test.mutate(manifest)
			data, err := json.Marshal(manifest)
			if err != nil { t.Fatal(err) }
			if _, err := contracts.NewRegistry(data); !errors.Is(err, contracts.ErrUnsupportedSchema) { t.Fatalf("unsupported public registry input = %v", err) }
		})
	}
}

func TestRegistrySchemaReadbackIsIndependent(t *testing.T) {
	registry := generatedRegistry(t)
	before, err := registry.JSONSchema(contracts.IDSchemaID, contracts.InputSchema)
	if err != nil { t.Fatal(err) }
	expected := string(before)
	for index := range before { before[index] = ' ' }
	after, err := registry.JSONSchema(contracts.IDSchemaID, contracts.InputSchema)
	if err != nil || string(after) != expected { t.Fatal("schema readback changed immutable registry state") }
	if _, err := registry.Parse("./unselected#Schema", json.RawMessage(`null`)); !errors.Is(err, contracts.ErrUnsupportedSchema) { t.Fatalf("unselected schema = %v", err) }
}
