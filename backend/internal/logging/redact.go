package logging

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"reflect"
	"sort"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

const redacted = "[redacted]"
const truncatedCause = "Repeated or truncated error cause."
const unserializable = "[unable to serialize, circular reference is too complex to analyze]"

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
		attribute.Value = slog.AnyValue(jsonLogValue(SerializeError(value)))
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

// jsonLogValue snapshots JSON-visible fields, including generated JSON tags and
// custom marshalers. JSON-shaped maps and arrays retain reference identity until
// the source's selective redaction clones have been made. Only then is a cyclic
// value serialized through Pino's bounded safe-stable-stringify fallback.
func jsonLogValue(value any) any {
	decoded, err := snapshotLogGraph(reflect.ValueOf(value), make(map[logIdentity]any))
	if err != nil {
		return unserializable
	}
	return decoded
}

type logIdentity struct {
	typeOf  reflect.Type
	pointer uintptr
	length  int
}

func logValueIdentity(value reflect.Value) (logIdentity, bool) {
	switch value.Kind() {
	case reflect.Map:
		return logIdentity{typeOf: value.Type(), pointer: uintptr(value.UnsafePointer())}, true
	case reflect.Slice:
		return logIdentity{typeOf: value.Type(), pointer: value.Pointer(), length: value.Len()}, true
	default:
		return logIdentity{}, false
	}
}

// Non-JSON Go types keep encoding/json's tagged-field/custom-marshaler boundary.
// The graph fallback concerns JSON-shaped maps and arrays, the same value model
// as the shared contracts. It never reflects private struct fields into logs.
func snapshotLogGraph(value reflect.Value, seen map[logIdentity]any) (any, error) {
	if !value.IsValid() {
		return nil, nil
	}
	for value.Kind() == reflect.Interface {
		if value.IsNil() {
			return nil, nil
		}
		value = value.Elem()
	}
	if text, ok := value.Interface().(jsonvalue.UTF16String); ok {
		return append(jsonvalue.UTF16String(nil), text...), nil
	}
	_, sharedObject := value.Interface().(jsonvalue.Object)
	if !sharedObject && (value.Kind() == reflect.Map || value.Kind() == reflect.Slice || value.Kind() == reflect.Pointer) {
		if value.IsNil() {
			return nil, nil
		}
	}
	if identity, tracked := logValueIdentity(value); tracked {
		if previous, present := seen[identity]; present {
			return previous, nil
		}
	}
	if number, ok := value.Interface().(json.Number); ok {
		return number, nil
	}
	if source, ok := value.Interface().(jsonvalue.Object); ok {
		object := make(jsonvalue.Object, len(source))
		identity, _ := logValueIdentity(value)
		seen[identity] = object
		for index, member := range source {
			child, err := snapshotLogGraph(reflect.ValueOf(member.Value), seen)
			if err != nil {
				return nil, err
			}
			object[index] = jsonvalue.Member{Key: append(jsonvalue.UTF16String(nil), member.Key...), Value: child}
		}
		return object, nil
	}
	if _, custom := value.Interface().(json.Marshaler); custom {
		data, err := json.Marshal(value.Interface())
		if err != nil {
			return nil, err
		}
		return jsonvalue.Parse(data)
	}
	switch value.Kind() {
	case reflect.Bool:
		return value.Bool(), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return value.Interface(), nil
	case reflect.Map:
		if value.Type().Key().Kind() != reflect.String {
			break
		}
		keys := value.MapKeys()
		sort.Slice(keys, func(left, right int) bool { return keys[left].String() < keys[right].String() })
		object := make(jsonvalue.Object, len(keys))
		identity, _ := logValueIdentity(value)
		seen[identity] = object
		for index, key := range keys {
			encoded, err := json.Marshal(key.String())
			if err != nil {
				return nil, err
			}
			units, err := jsonvalue.ParseString(encoded)
			if err != nil {
				return nil, err
			}
			child, err := snapshotLogGraph(value.MapIndex(key), seen)
			if err != nil {
				return nil, err
			}
			object[index] = jsonvalue.Member{Key: units, Value: child}
		}
		return object, nil
	case reflect.Array, reflect.Slice:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			break // Preserve the caller's JSON byte representation.
		}
		array := make([]any, value.Len())
		if identity, tracked := logValueIdentity(value); tracked {
			seen[identity] = array
		}
		for index := range array {
			child, err := snapshotLogGraph(value.Index(index), seen)
			if err != nil {
				return nil, err
			}
			array[index] = child
		}
		return array, nil
	}
	data, err := json.Marshal(value.Interface())
	if err != nil {
		return nil, err
	}
	return jsonvalue.Parse(data)
}

var errCyclicLogValue = errors.New("cyclic log value")

func encodedLogValue(value any) any {
	encoder := logJSONEncoder{active: make(map[logIdentity]bool)}
	err := encoder.value(value, 0)
	if errors.Is(err, errCyclicLogValue) {
		encoder = logJSONEncoder{active: make(map[logIdentity]bool), fallback: true}
		err = encoder.value(value, 0)
	}
	if err != nil {
		return unserializable
	}
	return json.RawMessage(encoder.output.String())
}

type logJSONEncoder struct {
	active   map[logIdentity]bool
	fallback bool
	output   strings.Builder
}

func (encoder *logJSONEncoder) value(value any, depth int) error {
	if object, ok := value.(jsonvalue.Object); ok {
		return encoder.object(object, depth)
	}
	if array, ok := value.([]any); ok {
		return encoder.array(array, depth)
	}
	text, err := canonicaljson.Canonical(value)
	if err != nil {
		return err
	}
	encoder.output.WriteString(text)
	return nil
}

func (encoder *logJSONEncoder) enter(value any) (func(), bool) {
	identity, _ := logValueIdentity(reflect.ValueOf(value))
	if encoder.active[identity] {
		return nil, false
	}
	encoder.active[identity] = true
	return func() { delete(encoder.active, identity) }, true
}

func (encoder *logJSONEncoder) repeated() error {
	if !encoder.fallback {
		return errCyclicLogValue
	}
	encoder.output.WriteString(`"[Circular]"`)
	return nil
}

func (encoder *logJSONEncoder) object(object jsonvalue.Object, depth int) error {
	leave, entered := encoder.enter(object)
	if !entered {
		return encoder.repeated()
	}
	defer leave()
	if encoder.fallback && len(object) != 0 && depth >= 5 {
		encoder.output.WriteString(`"[Object]"`)
		return nil
	}
	ordered := object
	if encoder.fallback {
		ordered = append(jsonvalue.Object(nil), object...)
		sort.Slice(ordered, func(left, right int) bool { return logKeyLess(ordered[left].Key, ordered[right].Key) })
		if len(ordered) > 100 {
			ordered = ordered[:100]
		}
	}
	encoder.output.WriteByte('{')
	for index, member := range ordered {
		if index != 0 {
			encoder.output.WriteByte(',')
		}
		key, err := canonicaljson.Canonical(member.Key)
		if err != nil {
			return err
		}
		encoder.output.WriteString(key)
		encoder.output.WriteByte(':')
		if err := encoder.value(member.Value, depth+1); err != nil {
			return err
		}
	}
	if encoder.fallback && len(object) > 100 {
		encoder.output.WriteString(`,"...":`)
		if err := encoder.value(logOmission(len(object)-100)+" not stringified", depth+1); err != nil {
			return err
		}
	}
	encoder.output.WriteByte('}')
	return nil
}

func (encoder *logJSONEncoder) array(array []any, depth int) error {
	leave, entered := encoder.enter(array)
	if !entered {
		return encoder.repeated()
	}
	defer leave()
	if encoder.fallback && len(array) != 0 && depth >= 5 {
		encoder.output.WriteString(`"[Array]"`)
		return nil
	}
	length := len(array)
	if encoder.fallback && length > 100 {
		length = 100
	}
	encoder.output.WriteByte('[')
	for index := 0; index < length; index++ {
		if index != 0 {
			encoder.output.WriteByte(',')
		}
		if err := encoder.value(array[index], depth+1); err != nil {
			return err
		}
	}
	// Preserve safe-stable-stringify 2.5.0's exact array marker boundary.
	if encoder.fallback && len(array)-1 > 100 {
		encoder.output.WriteByte(',')
		if err := encoder.value("... "+logOmission(len(array)-101)+" not stringified", depth+1); err != nil {
			return err
		}
	}
	encoder.output.WriteByte(']')
	return nil
}

func logKeyLess(left, right jsonvalue.UTF16String) bool {
	for index := 0; index < len(left) && index < len(right); index++ {
		if left[index] != right[index] {
			return left[index] < right[index]
		}
	}
	return len(left) < len(right)
}

func logOmission(count int) string {
	if count == 1 {
		return "1 item"
	}
	return fmt.Sprintf("%d items", count)
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
		} else if attribute.Value.Kind() == slog.KindAny || attribute.Value.Kind() == slog.KindFloat64 {
			// Float64 stays a native slog kind even through AnyValue. Route it
			// through shared JSON encoding for null and JavaScript Number text.
			attribute.Value = slog.AnyValue(encodedLogValue(redactJSONValue(attribute.Value.Any(), depth+1)))
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
	case jsonvalue.Object:
		copy := make(jsonvalue.Object, len(object))
		for index, member := range object {
			copy[index].Key = append(jsonvalue.UTF16String(nil), member.Key...)
			key, err := member.Key.UTF8()
			if err == nil && secretKeys[key] {
				copy[index].Value = redacted
			} else {
				copy[index].Value = redactJSONValue(member.Value, depth+1)
			}
		}
		return copy
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
	if message, sharedString := sharedErrorString(value); sharedString {
		return map[string]any{"message": message}
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Pointer, reflect.Map, reflect.Slice:
		if reflected.IsNil() {
			return map[string]any{"message": "null"}
		}
	case reflect.Struct:
	default:
		return map[string]any{"message": primitiveErrorMessage(value)}
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

func sharedErrorString(value any) (any, bool) {
	reflected := reflect.ValueOf(value)
	if reflected.Kind() == reflect.Pointer && reflected.IsNil() {
		return nil, false
	}
	if contractValue, ok := value.(interface{ JSONValue() any }); ok {
		value = contractValue.JSONValue()
	}
	text, ok := value.(jsonvalue.UTF16String)
	if !ok {
		return nil, false
	}
	if utf8Text, err := text.UTF8(); err == nil {
		return utf8Text, true
	}
	encoded, err := canonicaljson.Canonical(text)
	if err != nil {
		return unserializable, true
	}
	// RawMessage retains unpaired units when this public error object is passed
	// through a JSON writer; an ordinary Go string cannot carry them losslessly.
	return json.RawMessage(encoded), true
}

func primitiveErrorMessage(value any) string {
	if parsed, ok := value.(json.Number); ok {
		number, err := jsonvalue.NumberFloat64(parsed)
		if err != nil {
			return unserializable
		}
		value = number
	}
	reflected := reflect.ValueOf(value)
	var number float64
	switch reflected.Kind() {
	case reflect.Float32, reflect.Float64:
		number = reflected.Float()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		number = float64(reflected.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		number = float64(reflected.Uint())
	default:
		return fmt.Sprint(value)
	}
	switch {
	case math.IsNaN(number):
		return "NaN"
	case math.IsInf(number, 1):
		return "Infinity"
	case math.IsInf(number, -1):
		return "-Infinity"
	default:
		text, err := canonicaljson.Canonical(number)
		if err != nil {
			return unserializable
		}
		return text
	}
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
