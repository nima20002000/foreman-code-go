package contracts

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

type missingValue struct{}

// sourceNode is generated from the actual pinned Zod object graph. Ordered
// properties and checks carry information that JSON Schema cannot reconstruct.
type sourceNode struct {
	Kind string `json:"kind"`
	Checks []sourceCheck `json:"checks"`
	Inner *sourceNode `json:"inner,omitempty"`
	Element *sourceNode `json:"element,omitempty"`
	Properties []sourceProperty `json:"properties,omitempty"`
	UnknownKeys string `json:"unknownKeys,omitempty"`
	Values []string `json:"values,omitempty"`
}

type sourceProperty struct {
	Key string `json:"key"`
	Node *sourceNode `json:"node"`
}

type sourceCheck struct {
	Kind string `json:"kind"`
	Abort *bool `json:"abort"`
	When string `json:"when"`
	Minimum *float64 `json:"minimum,omitempty"`
	Maximum *float64 `json:"maximum,omitempty"`
	Length *float64 `json:"length,omitempty"`
	Value *float64 `json:"value,omitempty"`
	Inclusive *bool `json:"inclusive,omitempty"`
	Format string `json:"format,omitempty"`
	Pattern string `json:"pattern,omitempty"`
	PatternDisplay string `json:"patternDisplay,omitempty"`
	Rule *sourceRule `json:"rule,omitempty"`
	patternMatch func(jsonvalue.UTF16String) bool
}

func (check *sourceCheck) abort() bool { return *check.Abort }

type sourceRule struct {
	Kind string `json:"kind"`
	Discriminator string `json:"discriminator,omitempty"`
	Equals string `json:"equals,omitempty"`
	Field string `json:"field,omitempty"`
	Presence string `json:"presence,omitempty"`
	RequiredMessage string `json:"requiredMessage,omitempty"`
	ForbiddenMessage string `json:"forbiddenMessage,omitempty"`
}

func (node *sourceNode) run(value any) parsePayload {
	payload := parsePayload{value: value}
	switch node.Kind {
	case "optional":
		if _, missing := value.(missingValue); !missing { payload = node.Inner.run(value) }
	case "nullable":
		if value != nil { payload = node.Inner.run(value) }
	case "string":
		if _, ok := value.(jsonvalue.UTF16String); !ok { payload.invalidType("string") }
	case "number":
		if number, ok := value.(float64); !ok || math.IsNaN(number) || math.IsInf(number, 0) { payload.invalidType("number") }
	case "boolean":
		if _, ok := value.(bool); !ok { payload.invalidType("boolean") }
	case "null":
		if value != nil { payload.invalidType("null") }
	case "enum", "literal":
		found := false
		if text, ok := value.(jsonvalue.UTF16String); ok {
			for _, candidate := range node.Values { if text.Equal(units(candidate)) { found = true; break } }
		}
		if !found {
			values := make([]any, 0, len(node.Values))
			quoted := make([]string, 0, len(node.Values))
			for _, value := range node.Values {
				values = append(values, units(value))
				quoted = append(quoted, `"`+value+`"`)
			}
			message := "Invalid option: expected one of " + strings.Join(quoted, "|")
			if len(quoted) == 1 { message = "Invalid input: expected " + quoted[0] }
			payload.add(makeIssue("invalid_value", units(message), field("values", values)), false, false)
		}
	case "array":
		input, ok := value.([]any)
		if !ok { payload.invalidType("array"); break }
		output := make([]any, len(input))
		for index, value := range input {
			item := node.Element.run(value)
			if item.err != nil { return item }
			output[index] = item.value
			payload.issues = append(payload.issues, prefixIssues(index, item.issues)...)
		}
		payload.value = output
	case "object":
		input, ok := value.(jsonvalue.Object)
		if !ok { payload.invalidType("object"); break }
		node.parseObject(&payload, input)
	default:
		panic("unsupported source node passed the registry admission check")
	}
	for index := range node.Checks {
		if payload.err != nil { return payload }
		check := &node.Checks[index]
		if check.When == "length" {
			if payload.explicitlyAborted() { continue }
			if _, _, present := lengthValue(payload.value); !present { continue }
		} else if payload.aborted() { continue }
		check.run(&payload)
	}
	return payload
}

func (node *sourceNode) parseObject(payload *parsePayload, input jsonvalue.Object) {
	values := make(map[string]any, len(input))
	for _, member := range input { values[member.Key.IdentityKey()] = member.Value }
	known := make(map[string]bool, len(node.Properties))
	output := make(jsonvalue.Object, 0, len(node.Properties))
	for _, property := range node.Properties {
		key := units(property.Key)
		identity := key.IdentityKey()
		known[identity] = true
		value, present := values[identity]
		if !present { value = missingValue{} }
		result := property.Node.run(value)
		if result.err != nil { payload.err = result.err; return }
		if !present && property.Node.optional() { continue }
		payload.issues = append(payload.issues, prefixIssues(TextFromUTF16(key), result.issues)...)
		if present { output = append(output, jsonvalue.Member{Key: key, Value: result.value}) }
	}
	unknown := make([]any, 0)
	message := units("Unrecognized key")
	for _, member := range input {
		if !known[member.Key.IdentityKey()] { unknown = append(unknown, slices.Clone(member.Key)) }
	}
	if len(unknown) > 0 {
		if len(unknown) > 1 { message = append(message, 's') }
		message = append(message, ':', ' ')
		for index, key := range unknown {
			if index != 0 { message = append(message, ',', ' ') }
			message = append(message, '"')
			message = append(message, key.(jsonvalue.UTF16String)...)
			message = append(message, '"')
		}
		// Strict unknown-key issues are continuable in pinned Zod 4.6.3.
		payload.add(makeIssue("unrecognized_keys", message, field("keys", unknown)), true, false)
	}
	payload.value = output
}

func (node *sourceNode) optional() bool {
	for node.Kind == "nullable" { node = node.Inner }
	return node.Kind == "optional"
}

func (payload *parsePayload) invalidType(expected string) {
	received := valueType(payload.value)
	properties := []jsonvalue.Member{field("expected", units(expected))}
	if number, ok := payload.value.(float64); expected == "number" && ok && (math.IsNaN(number) || math.IsInf(number, 0)) {
		properties = append(properties, field("received", units(received)))
	}
	message := units(fmt.Sprintf("Invalid input: expected %s, received %s", expected, received))
	payload.add(makeIssue("invalid_type", message, properties...), false, false)
}

func valueType(value any) string {
	switch typed := value.(type) {
	case missingValue: return "undefined"
	case nil: return "null"
	case jsonvalue.UTF16String: return "string"
	case []any: return "array"
	case jsonvalue.Object: return "object"
	case bool: return "boolean"
	case float64:
		if math.IsNaN(typed) { return "NaN" }
		if math.IsInf(typed, 1) { return "Infinity" }
		if math.IsInf(typed, -1) { return "-Infinity" }
		return "number"
	default: panic("non-JSON value reached the generated source runtime")
	}
}
