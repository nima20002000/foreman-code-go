package contracts_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
)

func TestGeneratedCLISelectedArtifact(t *testing.T) {
	t.Run("contracts.codegen.selected-output", func(t *testing.T) {
		manifest := executionManifest(t)
		runtime, script, input := os.Getenv("GO_CONTRACT_GENERATOR_RUNTIME"), os.Getenv("GO_CONTRACT_GENERATOR_SCRIPT"), os.Getenv("GO_CONTRACT_MANIFEST_FILE")
		if !filepath.IsAbs(runtime) || !filepath.IsAbs(script) || input == "" { t.Fatal("unmet setup: actual terminal generator runtime, candidate script and source manifest are required") }
		for _, path := range []string{runtime, script, input} { if _, err := os.Stat(path); err != nil { t.Fatalf("unmet setup: %v", err) } }
		output := t.TempDir()
		args := []string{script, "--manifest", input, "--output-dir", output}
		coverage, ok := manifest["coverage"].(map[string]any)
		if !ok { t.Fatal("unmet setup: selected source coverage is required") }
		selected, ok := coverage["selected"].([]any)
		if !ok || len(selected) == 0 { t.Fatal("unmet setup: actual selected schemas are required") }
		for _, item := range selected {
			id, ok := item.(string)
			if !ok { t.Fatal("unmet setup: invalid selection record") }
			args = append(args, "--select", id)
		}
		// This invokes only the public selected generator, never a build/test
		// wrapper. Terminal compiled this consumer against authentic prepared
		// generated setup before selecting the original or corrected CLI source.
		command := exec.Command(runtime, args...)
		command.Dir = t.TempDir()
		logs, err := command.CombinedOutput()
		if err != nil { t.Fatalf("selected generator failed its public artifact production assertion: %v\n%s", err, logs) }
		data, err := os.ReadFile(filepath.Join(output, "schemas.json"))
		if err != nil { t.Fatalf("generator did not produce its consumable artifact: %v", err) }
		registry, err := contracts.NewRegistry(data)
		if err != nil { t.Fatalf("generated artifact cannot be consumed: %v", err) }
		value, err := contracts.ParseID(registry, json.RawMessage(`" \ud800 "`))
		if err != nil { t.Fatalf("compiled public generated decoder rejected emitted schema: %v", err) }
		if !value.Equal(contracts.TextFromUTF16([]uint16{0xd800})) { t.Fatal("actual generated artifact consumption changed normalized UTF-16 readback") }
	})
}

func TestGeneratedPresenceWrapperFixture(t *testing.T) {
	registry := generatedRegistry(t)
	path := os.Getenv("GO_CONTRACT_PRESENCE_VECTORS_FILE")
	if path == "" { t.Fatal("unmet setup: actual pinned source optional/nullable capture is required") }
	data, err := os.ReadFile(path)
	if err != nil { t.Fatal(err) }
	var fixture struct { Schema string `json:"schema"`; Vectors []contractVector `json:"vectors"` }
	if err := json.Unmarshal(data, &fixture); err != nil { t.Fatal(err) }
	if fixture.Schema != "./test-fixture#OptionalNullableFixtureSchema" || len(fixture.Vectors) != 3 { t.Fatal("unmet setup: complete source presence capture is required") }
	for _, vector := range fixture.Vectors {
		t.Run(vector.ID, func(t *testing.T) {
			if !vector.Frozen.Accepted || len(vector.Frozen.Threw) != 0 { t.Fatal("unmet setup: actual accepted source presence outcomes required") }
			value, err := contracts.ParseGenerated(registry, fixture.Schema, json.RawMessage(vector.Input.JSON))
			if err != nil { t.Fatalf("generated public DTO decode failed: %v", err) }
			decoded, err := contracts.JSONValue(value)
			if err != nil { t.Fatal(err) }
			actual := canonicalValue(t, readback(t, decoded, true, true))
			expected := canonicalValue(t, readback(t, parsed(t, vector.Frozen.JSON), true, true))
			if actual != expected { t.Fatalf("actual generated DTO lost source missing/null/value readback\ngot %s\nwant %s", actual, expected) }
		})
	}
}

func TestGeneratedDirectionAliases(t *testing.T) {
	registry := generatedRegistry(t)
	var input contracts.IDInput = contracts.TextFromUTF16([]uint16{' ', 'x', ' '})
	encoded, err := json.Marshal(input)
	if err != nil { t.Fatal(err) }
	var output contracts.IDOutput
	output, err = contracts.ParseID(registry, encoded)
	if err != nil { t.Fatal(err) }
	if !output.Equal(contracts.TextFromUTF16([]uint16{'x'})) { t.Fatal("compiled generated input/output aliases changed source normalization") }
	var principalInput contracts.ManagementPrincipalInput
	var principalOutput contracts.ManagementPrincipalOutput = principalInput
	if _, present := principalOutput.AgentID.Get(); present { t.Fatal("zero alias value lost optional absence") }
}
