package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

const FrozenReference = "8d2ea76c5028ef4458bf8cd64ef8624422e71d9f"
const MergedBase = "7fa547058109519a99c904493c916662fde6a474"

// Provenance records source identities. It is not a compilation, test or
// qualification receipt; terminal/controller must independently verify tickets.
type Provenance struct {
	Package string `json:"package"`
	Reference string `json:"reference"`
	MergedBase string `json:"mergedBase"`
	Candidate string `json:"candidate"`
	Tree string `json:"tree"`
	ContractsTree string `json:"contractsTree"`
	ZodVersion string `json:"zodVersion"`
}

type manifest struct {
	SchemaVersion int `json:"schemaVersion"`
	Draft string `json:"draft"`
	Source Provenance `json:"source"`
	Validation map[string]string `json:"validation"`
	Schemas []manifestSchema `json:"schemas"`
	Coverage struct { Selected []string `json:"selected"`; Exported []string `json:"exported"`; Unsupported []string `json:"unsupported"` } `json:"coverage"`
	Unsupported []json.RawMessage `json:"unsupported"`
}

type manifestSchema struct {
	ID string `json:"id"`
	Module string `json:"module"`
	Export string `json:"export"`
	Input json.RawMessage `json:"input"`
	Output json.RawMessage `json:"output"`
	Runtime json.RawMessage `json:"runtime"`
}

type runtimeDescriptor struct {
	Version int `json:"version"`
	ZodVersion string `json:"zodVersion"`
	Selector string `json:"selector"`
	ErrorPolicy string `json:"errorPolicy"`
	Locale executionLocale `json:"locale"`
	Root *sourceNode `json:"root"`
}

type executionLocale struct {
	Repository string `json:"repository"`
	Reference string `json:"reference"`
	SourceFile string `json:"sourceFile"`
	SourceBlob string `json:"sourceBlob"`
	InstalledFile string `json:"installedFile"`
	InstalledSHA256 string `json:"installedSHA256"`
	ModuleFormat string `json:"moduleFormat"`
	Binding string `json:"binding"`
	Phase string `json:"phase"`
}

type compiledContract struct {
	node *sourceNode
	standard *jsonschema.Schema
	input json.RawMessage
	output json.RawMessage
}

// Registry is immutable after construction and can be shared by handlers.
// Every selected root must have supported source execution metadata. Merely
// emitting a JSON Schema does not admit a root into this runtime.
type Registry struct {
	source Provenance
	contracts map[string]compiledContract
	ids []string
}

func NewRegistry(data []byte) (*Registry, error) {
	if err := metadataUTF8(data); err != nil { return nil, err }
	var source manifest
	if err := json.Unmarshal(data, &source); err != nil { return nil, err }
	if err := validateManifest(&source); err != nil { return nil, err }
	registry := &Registry{source: source.Source, contracts: make(map[string]compiledContract, len(source.Schemas))}
	for index, entry := range source.Schemas {
		var descriptor runtimeDescriptor
		if err := strictJSON(entry.Runtime, &descriptor); err != nil {
			return nil, &SchemaSupportError{SchemaID: entry.ID, Reason: "execution descriptor: " + err.Error()}
		}
		if descriptor.Version != 1 || descriptor.ZodVersion != "4.6.3" || descriptor.Selector != "zod-default-en" || descriptor.ErrorPolicy != "default-en" || !descriptor.Locale.supported() {
			return nil, &SchemaSupportError{SchemaID: entry.ID, Reason: "unsupported execution version or source error policy"}
		}
		if err := admitNode(entry.ID, descriptor.Root, []string{"runtime", "root"}); err != nil { return nil, err }
		for direction, data := range map[string]json.RawMessage{"input": entry.Input, "output": entry.Output} {
			var schema any
			if err := json.Unmarshal(data, &schema); err != nil { return nil, err }
			if err := inspectJSONSchema(entry.ID, schema, []string{direction}); err != nil { return nil, err }
		}
		var output any
		if err := json.Unmarshal(entry.Output, &output); err != nil { return nil, err }
		compiler := jsonschema.NewCompiler()
		compiler.DefaultDraft(jsonschema.Draft2020)
		compiler.UseLoader(disabledLoader{})
		// Source patterns are authoritative. Draft2020 format stays annotation,
		// matching the exporter; no generic RFC3339/UUID assertion is substituted.
		location := fmt.Sprintf("https://foreman.invalid/generated/%d.json", index)
		if err := compiler.AddResource(location, output); err != nil { return nil, err }
		compiled, err := compiler.Compile(location)
		if err != nil { return nil, fmt.Errorf("compile generated schema %s: %w", entry.ID, err) }
		registry.contracts[entry.ID] = compiledContract{node: descriptor.Root, standard: compiled,
			input: bytes.Clone(entry.Input), output: bytes.Clone(entry.Output)}
		registry.ids = append(registry.ids, entry.ID)
	}
	sort.Strings(registry.ids)
	return registry, nil
}

func (registry *Registry) Source() Provenance { return registry.source }
func (registry *Registry) IDs() []string { return slices.Clone(registry.ids) }

type SchemaDirection string
const InputSchema SchemaDirection = "input"
const OutputSchema SchemaDirection = "output"

func (registry *Registry) JSONSchema(id string, direction SchemaDirection) (json.RawMessage, error) {
	contract, err := registry.lookup(id)
	if err != nil { return nil, err }
	switch direction {
	case InputSchema: return bytes.Clone(contract.input), nil
	case OutputSchema: return bytes.Clone(contract.output), nil
	default: return nil, errors.New("schema direction must be input or output")
	}
}

func (registry *Registry) Parse(id string, data json.RawMessage) (any, error) {
	value, err := jsonvalue.Parse(data)
	if err != nil { return nil, err }
	return registry.ParseValue(id, value)
}

// ParseValue accepts jsonvalue.Parse's lossless representation or a previous
// normalized result. It clones before normalization, including parsed request
// caches. Numbers are binary64 before checking; readback retains original
// UTF-16 units and negative zero. No transport policy is imported here.
func (registry *Registry) ParseValue(id string, value any) (any, error) {
	contract, err := registry.lookup(id)
	if err != nil { return nil, err }
	input, err := cloneParsedValue(value)
	if err != nil { return nil, err }
	result := contract.node.run(input)
	if result.err != nil { return nil, result.err }
	if len(result.issues) != 0 {
		issues := make([]Issue, len(result.issues))
		for index, issue := range result.issues { issues[index] = issue.issue }
		return nil, &ValidationError{SchemaID: id, Issues: issues}
	}
	standard, err := standardValue(result.value)
	if err != nil { return nil, err }
	if err := contract.standard.Validate(standard); err != nil {
		return nil, fmt.Errorf("%w for %s: %v", ErrSchemaDisagreement, id, err)
	}
	return result.value, nil
}

func (registry *Registry) Decode(id string, data json.RawMessage, destination any) error {
	value, err := registry.Parse(id, data)
	if err != nil { return err }
	return decodeValue(destination, value)
}

func (registry *Registry) DecodeValue(id string, value any, destination any) error {
	parsed, err := registry.ParseValue(id, value)
	if err != nil { return err }
	return decodeValue(destination, parsed)
}

func (registry *Registry) Validate(id string, value any) error {
	parsed, err := JSONValue(value)
	if err != nil { return err }
	_, err = registry.ParseValue(id, parsed)
	return err
}

func (registry *Registry) lookup(id string) (compiledContract, error) {
	if registry == nil { return compiledContract{}, errors.New("generated contract registry is unavailable") }
	contract, found := registry.contracts[id]
	if !found { return compiledContract{}, &SchemaSupportError{SchemaID: id, Reason: "schema was not generated into this registry"} }
	return contract, nil
}

type disabledLoader struct{}
func (disabledLoader) Load(url string) (any, error) { return nil, fmt.Errorf("external contract schema resource is disabled: %s", url) }

func strictJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil { return err }
	if _, err := decoder.Token(); err != io.EOF { return errors.New("trailing execution descriptor data") }
	return nil
}
