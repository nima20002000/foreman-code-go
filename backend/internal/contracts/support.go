package contracts

import (
	"fmt"
	"math"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

func admitNode(id string, node *sourceNode, path []string) error {
	failure := func(reason string) error { return &SchemaSupportError{SchemaID: id, Path: path, Reason: reason} }
	if node == nil || node.Checks == nil { return failure("missing ordered source node/check descriptor") }
	children := []struct { node *sourceNode; path []string }{}
	switch node.Kind {
	case "string", "number", "boolean", "null":
	case "enum", "literal":
		if len(node.Values) == 0 { return failure("empty/non-string enum or literal needs an adapter") }
		seen := map[string]bool{}
		for _, value := range node.Values {
			if !asciiText(value) || seen[value] { return failure("only distinct ASCII string enum/literal values are currently supported for generation") }
			seen[value] = true
		}
	case "optional", "nullable":
		children = append(children, struct { node *sourceNode; path []string }{node.Inner, appendPath(path, "inner")})
	case "array":
		children = append(children, struct { node *sourceNode; path []string }{node.Element, appendPath(path, "element")})
	case "object":
		if node.UnknownKeys != "strict" || node.Properties == nil { return failure("only explicit strict source objects are supported") }
		seen := map[string]bool{}
		for _, property := range node.Properties {
			if !asciiText(property.Key) || !sourcePropertySupported(property.Key) || seen[property.Key] {
				return failure("object property naming/lookup needs an explicit adapter")
			}
			seen[property.Key] = true
			children = append(children, struct { node *sourceNode; path []string }{property.Node, appendPath(path, "properties", property.Key)})
		}
	default:
		return failure("unsupported execution node " + node.Kind)
	}
	if node.Kind != "optional" && node.Kind != "nullable" && node.Inner != nil ||
		node.Kind != "array" && node.Element != nil || node.Kind != "object" && (node.Properties != nil || node.UnknownKeys != "") ||
		node.Kind != "enum" && node.Kind != "literal" && node.Values != nil {
		return failure("descriptor contains unrelated child/value semantics")
	}
	for index := range node.Checks {
		if err := admitCheck(node, &node.Checks[index]); err != nil {
			return &SchemaSupportError{SchemaID: id, Path: appendPath(path, "checks", fmt.Sprint(index)), Reason: err.Error()}
		}
	}
	for _, child := range children { if err := admitNode(id, child.node, child.path); err != nil { return err } }
	return nil
}

func admitCheck(node *sourceNode, check *sourceCheck) error {
	if check.Abort == nil || check.When != "length" && check.When != "unaborted" {
		return fmt.Errorf("missing or unsupported source abort/when policy")
	}
	lengthCheck := check.Kind == "min_length" || check.Kind == "max_length" || check.Kind == "length_equals"
	if (check.When == "length") != lengthCheck { return fmt.Errorf("source conditional check policy is unsupported") }
	for _, number := range []*float64{check.Minimum, check.Maximum, check.Length, check.Value} {
		if number != nil && (math.IsNaN(*number) || math.IsInf(*number, 0)) { return fmt.Errorf("nonfinite source check bound") }
	}
	if (check.Minimum != nil) != (check.Kind == "min_length") ||
		(check.Maximum != nil) != (check.Kind == "max_length") ||
		(check.Length != nil) != (check.Kind == "length_equals") ||
		(check.Value != nil) != (check.Kind == "greater_than" || check.Kind == "less_than") ||
		(check.Inclusive != nil) != (check.Kind == "greater_than" || check.Kind == "less_than") ||
		(check.Rule != nil) != (check.Kind == "overwrite" || check.Kind == "custom") ||
		(check.Format != "") != (check.Kind == "string_format" || check.Kind == "number_format") ||
		check.Kind != "string_format" && (check.Pattern != "" || check.PatternDisplay != "") {
		return fmt.Errorf("check contains missing or unrelated execution semantics")
	}
	switch check.Kind {
	case "overwrite":
		if node.Kind != "string" || check.Rule == nil || check.Rule.Kind != "trim" || !emptyRuleFields(check.Rule) {
			return fmt.Errorf("overwrite is not a supported bound trim declaration")
		}
	case "custom":
		rule := check.Rule
		if node.Kind != "object" || rule == nil || rule.Kind != "conditionalPresence" || rule.Presence != "truthy" ||
			!hasProperty(node, rule.Discriminator) || !hasProperty(node, rule.Field) || rule.RequiredMessage == "" || rule.ForbiddenMessage == "" {
			return fmt.Errorf("custom check is not a supported bound conditional presence declaration")
		}
	case "min_length", "max_length", "length_equals":
		if node.Kind != "string" && node.Kind != "array" { return fmt.Errorf("length guard is unsupported on this source node") }
		bound := check.Minimum
		if check.Kind == "max_length" { bound = check.Maximum }
		if check.Kind == "length_equals" { bound = check.Length }
		if bound == nil || *bound < 0 || math.Trunc(*bound) != *bound || *bound > 9007199254740991 {
			return fmt.Errorf("source length requires a nonnegative safe integer bound")
		}
	case "string_format":
		if node.Kind != "string" || check.PatternDisplay == "" { return fmt.Errorf("missing source string pattern display") }
		switch check.Format {
		case "regex", "uuid", "guid", "datetime", "date", "time":
		default: return fmt.Errorf("unsupported source string format %s", check.Format)
		}
		pattern, err := compileSourcePattern(check.Pattern)
		if err != nil { return err }
		check.patternMatch = func(value jsonvalue.UTF16String) bool { return pattern.MatchString(validationString(value)) }
	case "number_format":
		if node.Kind != "number" || check.Format != "safeint" { return fmt.Errorf("only pinned safeint number_format is supported") }
	case "greater_than", "less_than":
		if node.Kind != "number" || check.Value == nil || check.Inclusive == nil { return fmt.Errorf("missing numeric comparison semantics") }
	default:
		return fmt.Errorf("unsupported source check %s", check.Kind)
	}
	return nil
}

func hasProperty(node *sourceNode, key string) bool {
	for _, property := range node.Properties { if property.Key == key { return true } }
	return false
}

func emptyRuleFields(rule *sourceRule) bool {
	return rule.Discriminator == "" && rule.Equals == "" && rule.Field == "" && rule.Presence == "" && rule.RequiredMessage == "" && rule.ForbiddenMessage == ""
}

func asciiText(value string) bool {
	for _, char := range value { if char > 0x7f { return false } }
	return true
}

func appendPath(path []string, values ...string) []string { return append(append([]string{}, path...), values...) }

func inspectJSONSchema(id string, schema any, path []string) error {
	object, ok := schema.(map[string]any)
	if !ok {
		if _, boolean := schema.(bool); boolean { return nil }
		return &SchemaSupportError{SchemaID: id, Path: path, Reason: "JSON Schema must be an object or boolean"}
	}
	for key, value := range object {
		if !schemaKeywordSupported(key) {
			return &SchemaSupportError{SchemaID: id, Path: appendPath(path, key), Reason: "JSON Schema keyword is outside the bounded consumer"}
		}
		if key == "$schema" && value != "https://json-schema.org/draft/2020-12/schema" {
			return &SchemaSupportError{SchemaID: id, Path: appendPath(path, key), Reason: "schema draft differs from manifest"}
		}
		if strings.HasPrefix(key, "x-") && key != "x-foreman-normalization" && key != "x-foreman-refinements" &&
			key != "x-foreman-regexp" && key != "x-foreman-format-assertion" {
			return &SchemaSupportError{SchemaID: id, Path: appendPath(path, key), Reason: "unknown schema execution extension"}
		}
		if key == "$ref" {
			if reference, ok := value.(string); !ok || !strings.HasPrefix(reference, "#") {
				return &SchemaSupportError{SchemaID: id, Path: appendPath(path, key), Reason: "external schema references are disabled"}
			}
		}
		if key == "pattern" {
			source, ok := value.(string)
			if !ok || object["x-foreman-regexp"] != "ecmascript-no-flags" { return &SchemaSupportError{SchemaID: id, Path: path, Reason: "pattern lacks exact dialect declaration"} }
			if _, err := compileSourcePattern(source); err != nil { return &SchemaSupportError{SchemaID: id, Path: path, Reason: err.Error()} }
		}
		if key == "format" && object["x-foreman-format-assertion"] != "source-pattern" {
			return &SchemaSupportError{SchemaID: id, Path: path, Reason: "format assertion is not source-pattern backed"}
		}
	}
	for _, key := range []string{"properties", "$defs"} {
		if children, ok := object[key].(map[string]any); ok {
			for name, child := range children { if err := inspectJSONSchema(id, child, appendPath(path, key, name)); err != nil { return err } }
		}
	}
	for _, key := range []string{"allOf", "anyOf", "oneOf"} {
		if children, ok := object[key].([]any); ok {
			for index, child := range children { if err := inspectJSONSchema(id, child, appendPath(path, key, fmt.Sprint(index))); err != nil { return err } }
		}
	}
	for _, key := range []string{"items", "additionalProperties", "if", "then", "else", "not"} {
		if child, exists := object[key]; exists { if err := inspectJSONSchema(id, child, appendPath(path, key)); err != nil { return err } }
	}
	return nil
}

func schemaKeywordSupported(key string) bool {
	switch key {
	case "$schema", "$ref", "$defs", "type", "properties", "required", "additionalProperties", "items",
		"allOf", "anyOf", "oneOf", "if", "then", "else", "not", "enum", "const", "minLength", "maxLength",
		"minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "format",
		"description", "title", "deprecated", "readOnly", "writeOnly", "examples",
		"x-foreman-normalization", "x-foreman-refinements", "x-foreman-regexp", "x-foreman-format-assertion":
		return true
	default: return false
	}
}
