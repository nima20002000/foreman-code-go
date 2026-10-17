package logging

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
)

const redacted = "[redacted]"
const truncatedCause = "Repeated or truncated error cause."

var secretKeys = map[string]bool{
	"authorization": true, "cookie": true, "set-cookie": true,
	"token": true, "accessToken": true, "refreshToken": true, "apiKey": true, "api_key": true,
	"password": true, "secret": true, "credential": true, "connectionString": true,
	"prompt": true, "initialPrompt": true, "input": true, "output": true,
	"env": true, "environment": true,
}

func prepareAttribute(attribute slog.Attr, depth int) slog.Attr {
	attribute.Value = attribute.Value.Resolve()
	if depth == 0 && (attribute.Key == "err" || attribute.Key == "error") {
		value := attribute.Value.Any()
		if attribute.Value.Kind() == slog.KindGroup {
			value = groupObject(attribute.Value.Group())
		}
		attribute.Value = slog.AnyValue(SerializeError(value))
	} else if attribute.Value.Kind() == slog.KindGroup {
		children := attribute.Value.Group()
		prepared := make([]slog.Attr, len(children))
		nextDepth := depth + 1
		if attribute.Key == "" {
			nextDepth = depth
		}
		for index, child := range children {
			prepared[index] = prepareAttribute(child, nextDepth)
		}
		attribute.Value = slog.GroupValue(prepared...)
	} else if attribute.Value.Kind() == slog.KindAny {
		if err, ok := attribute.Value.Any().(error); ok {
			reflected := reflect.ValueOf(err)
			if reflected.Kind() == reflect.Pointer && reflected.IsNil() {
				attribute.Value = slog.AnyValue(nil)
			} else {
				attribute.Value = slog.StringValue(err.Error())
			}
		} else {
			attribute.Value = slog.AnyValue(jsonLogValue(attribute.Value.Any()))
		}
	}
	return attribute
}

func groupObject(attributes []slog.Attr) map[string]any {
	result := make(map[string]any, len(attributes))
	for _, attribute := range attributes {
		value := attribute.Value.Resolve()
		if value.Kind() == slog.KindGroup {
			children := groupObject(value.Group())
			if attribute.Key == "" {
				for key, child := range children {
					result[key] = child
				}
			} else {
				result[attribute.Key] = children
			}
		} else if attribute.Key != "" || !attribute.Equal(slog.Attr{}) {
			result[attribute.Key] = value.Any()
		}
	}
	return result
}

// jsonLogValue snapshots JSON-visible fields (including generated JSON tags and
// custom marshalers) before redaction. Unsupported/cyclic objects emit a fixed
// marker rather than an encoder diagnostic that might contain private data.
func jsonLogValue(value any) any {
	data, err := json.Marshal(value)
	if err != nil {
		return "[Unable to serialize log value]"
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var decoded any
	if decoder.Decode(&decoded) != nil {
		return "[Unable to serialize log value]"
	}
	return decoded
}

func redactAttributes(attributes []slog.Attr, depth int) []slog.Attr {
	result := make([]slog.Attr, 0, len(attributes))
	for _, attribute := range attributes {
		if depth <= 2 && secretKeys[attribute.Key] {
			attribute.Value = slog.StringValue(redacted)
		} else if attribute.Value.Kind() == slog.KindGroup {
			nextDepth := depth + 1
			if attribute.Key == "" {
				nextDepth = depth
			}
			attribute.Value = slog.GroupValue(redactAttributes(attribute.Value.Group(), nextDepth)...)
		} else if attribute.Value.Kind() == slog.KindAny {
			attribute.Value = slog.AnyValue(redactJSONValue(attribute.Value.Any(), depth+1))
		}
		result = append(result, attribute)
	}
	return result
}

func redactJSONValue(value any, depth int) any {
	if depth > 2 {
		return value
	}
	switch object := value.(type) {
	case map[string]any:
		copy := make(map[string]any, len(object))
		for key, child := range object {
			if secretKeys[key] {
				copy[key] = redacted
			} else {
				copy[key] = redactJSONValue(child, depth+1)
			}
		}
		return copy
	case []any:
		copy := make([]any, len(object))
		for index, child := range object {
			copy[index] = redactJSONValue(child, depth+1)
		}
		return copy
	default:
		return value
	}
}

type errorIdentity struct {
	typeOf  reflect.Type
	pointer uintptr
}

type errorSeen struct {
	values  map[any]bool
	objects map[errorIdentity]bool
	count   int
}

func (s *errorSeen) add(value any) bool {
	reflected := reflect.ValueOf(value)
	if reflected.Kind() == reflect.Pointer {
		if s.values[value] {
			return false
		}
		s.values[value] = true
	} else if reflected.Kind() == reflect.Map || reflected.Kind() == reflect.Slice {
		identity := errorIdentity{typeOf: reflected.Type(), pointer: uintptr(reflected.UnsafePointer())}
		if s.objects[identity] {
			return false
		}
		s.objects[identity] = true
	}
	// A Go struct value has no reference identity. Equal values in distinct
	// aggregate entries remain distinct objects; any cyclic references are
	// encountered and bounded through their pointer or map values instead.
	s.count++
	return true
}

// SerializeError retains diagnostic identity and the reference's bounded cause
// chain: depth eight, thirty-two objects, and eight aggregate children per error.
func SerializeError(value any) map[string]any {
	seen := &errorSeen{values: make(map[any]bool), objects: make(map[errorIdentity]bool)}
	return serializeError(value, seen, 0)
}

func serializeError(value any, seen *errorSeen, depth int) map[string]any {
	if depth >= 8 || seen.count >= 32 {
		return map[string]any{"message": truncatedCause}
	}
	if value == nil {
		return map[string]any{"message": "null"}
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Pointer, reflect.Map, reflect.Slice:
		if reflected.IsNil() {
			return map[string]any{"message": "null"}
		}
	case reflect.Struct:
	default:
		return map[string]any{"message": fmt.Sprint(value)}
	}
	if !seen.add(value) {
		return map[string]any{"message": truncatedCause}
	}
	result := map[string]any{"type": "Error", "message": "Unknown error"}
	if name, ok := errorField(value, "name"); ok {
		if name, ok := name.(string); ok {
			result["type"] = name
		}
	}
	if err, ok := value.(error); ok {
		result["message"] = err.Error()
	} else if message, ok := errorField(value, "message"); ok {
		if message, ok := message.(string); ok {
			result["message"] = message
		}
	}
	if stack, ok := errorField(value, "stack"); ok {
		if stack, ok := stack.(string); ok {
			result["stack"] = stack
		}
	}
	if code, ok := errorCode(value); ok {
		result["code"] = code
	}
	if aggregate, ok := value.(interface{ Unwrap() []error }); ok {
		result["type"] = "AggregateError"
		causes := aggregate.Unwrap()
		if len(causes) > 8 {
			causes = causes[:8]
		}
		children := make([]map[string]any, len(causes))
		for index, cause := range causes {
			children[index] = serializeError(cause, seen, depth+1)
		}
		result["errors"] = children
	}
	if wrapped, ok := value.(interface{ Unwrap() error }); ok {
		if cause := wrapped.Unwrap(); cause != nil {
			result["cause"] = serializeError(cause, seen, depth+1)
		}
	} else if cause, ok := errorField(value, "cause"); ok {
		result["cause"] = serializeError(cause, seen, depth+1)
	}
	return result
}

func errorField(value any, name string) (any, bool) {
	if object, ok := value.(map[string]any); ok {
		field, present := object[name]
		return field, present
	}
	reflected := reflect.ValueOf(value)
	if reflected.Kind() == reflect.Pointer {
		reflected = reflected.Elem()
	}
	if reflected.Kind() != reflect.Struct {
		return nil, false
	}
	fieldName := strings.ToUpper(name[:1]) + name[1:]
	field := reflected.FieldByName(fieldName)
	if !field.IsValid() || !field.CanInterface() {
		return nil, false
	}
	return field.Interface(), true
}

func errorCode(value any) (any, bool) {
	if coded, ok := value.(interface{ FailureCode() string }); ok {
		return coded.FailureCode(), true
	}
	if coded, ok := value.(interface{ SQLState() string }); ok {
		return coded.SQLState(), true
	}
	code, present := errorField(value, "code")
	if !present || code == nil {
		return nil, false
	}
	switch reflect.TypeOf(code).Kind() {
	case reflect.String, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return code, true
	default:
		return nil, false
	}
}
