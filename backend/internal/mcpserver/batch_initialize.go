package mcpserver

import (
	"encoding/json"
	"math"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// batchInitialize is the transport admission guard, not a domain DTO/parser.
// It follows isInitializeRequest -> InitializeRequestSchema at frozen SDK
// cc4b41617ce3601b1290d67216ea0b194a3cd9ac (core/src/schemas.ts:235-485).
// Unknown object properties are allowed; every known optional property still
// has its declared type. A method name alone must not reject its siblings.
func batchInitialize(fields map[string]any) bool {
	if !batchStringEquals(fields["method"], "initialize") {
		return false
	}
	params, ok := batchFields(fields["params"])
	return ok && batchText(params["protocolVersion"]) &&
		batchImplementation(params["clientInfo"]) && batchClientCapabilities(params["capabilities"])
}

func batchImplementation(value any) bool {
	fields, ok := batchFields(value)
	if !ok || !batchText(fields["name"]) || !batchText(fields["version"]) {
		return false
	}
	for _, key := range []string{"title", "websiteUrl", "description"} {
		if !batchOptional(fields, key, batchText) {
			return false
		}
	}
	return batchOptional(fields, "icons", batchIcons)
}

func batchIcons(value any) bool {
	icons, ok := value.([]any)
	if !ok {
		return false
	}
	for _, value := range icons {
		fields, ok := batchFields(value)
		if !ok || !batchText(fields["src"]) || !batchOptional(fields, "mimeType", batchText) ||
			!batchOptional(fields, "sizes", batchTextArray) || !batchOptional(fields, "theme", batchIconTheme) {
			return false
		}
	}
	return true
}

func batchTextArray(value any) bool {
	items, ok := value.([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		if !batchText(item) {
			return false
		}
	}
	return true
}

func batchIconTheme(value any) bool {
	return batchStringEquals(value, "light") || batchStringEquals(value, "dark")
}

func batchClientCapabilities(value any) bool {
	return batchOptionalObject(value, map[string]func(any) bool{
		"experimental": batchJSONObjectRecord,
		"extensions":   batchJSONObjectRecord,
		"sampling": func(value any) bool {
			return batchOptionalObject(value, map[string]func(any) bool{
				"context": batchJSONObject, "tools": batchJSONObject,
			})
		},
		"roots": func(value any) bool {
			return batchOptionalObject(value, map[string]func(any) bool{"listChanged": batchBoolean})
		},
		"elicitation": batchElicitationCapability,
		"tasks":       batchClientTasksCapability,
	})
}

func batchElicitationCapability(value any) bool {
	// The source preprocesses {} to {form:{}}. Both have the same admission
	// result; this guard does not materialize or export the transformed value.
	return batchJSONObject(value) && batchOptionalObject(value, map[string]func(any) bool{
		"form": func(value any) bool {
			return batchOptionalObject(value, map[string]func(any) bool{"applyDefaults": batchBoolean})
		},
		"url": batchJSONObject,
	})
}

func batchClientTasksCapability(value any) bool {
	return batchOptionalObject(value, map[string]func(any) bool{
		"list": batchJSONObject, "cancel": batchJSONObject,
		"requests": func(value any) bool {
			return batchOptionalObject(value, map[string]func(any) bool{
				"sampling": func(value any) bool {
					return batchOptionalObject(value, map[string]func(any) bool{"createMessage": batchJSONObject})
				},
				"elicitation": func(value any) bool {
					return batchOptionalObject(value, map[string]func(any) bool{"create": batchJSONObject})
				},
			})
		},
	})
}

func batchOptionalObject(value any, validators map[string]func(any) bool) bool {
	fields, ok := batchFields(value)
	if !ok {
		return false
	}
	for key, validate := range validators {
		if !batchOptional(fields, key, validate) {
			return false
		}
	}
	return true
}

func batchBoolean(value any) bool {
	_, ok := value.(bool)
	return ok
}

func batchJSONObjectRecord(value any) bool {
	fields, ok := value.(jsonvalue.Object)
	if !ok {
		return false
	}
	for _, field := range fields {
		// Frozen Zod 4.6.3 records omit __proto__ before value validation.
		if batchStringEquals(field.Key, "__proto__") {
			continue
		}
		if !batchJSONObject(field.Value) {
			return false
		}
	}
	return true
}

func batchJSONObject(value any) bool {
	_, ok := value.(jsonvalue.Object)
	return ok && batchJSONValue(value)
}

func batchJSONValue(value any) bool {
	switch item := value.(type) {
	case nil, bool, jsonvalue.UTF16String:
		return true
	case json.Number:
		number, err := jsonvalue.NumberFloat64(item)
		return err == nil && !math.IsNaN(number) && !math.IsInf(number, 0)
	case []any:
		for _, child := range item {
			if !batchJSONValue(child) {
				return false
			}
		}
		return true
	case jsonvalue.Object:
		for _, child := range item {
			if batchStringEquals(child.Key, "__proto__") {
				continue
			}
			if !batchJSONValue(child.Value) {
				return false
			}
		}
		return true
	default:
		return false
	}
}
