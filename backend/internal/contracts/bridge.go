package contracts

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"slices"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

type containerIdentity struct { typeOf reflect.Type; pointer uintptr; length int }

func identity(value any) containerIdentity {
	reflected := reflect.ValueOf(value)
	return containerIdentity{typeOf: reflected.Type(), pointer: reflected.Pointer(), length: reflected.Len()}
}

// cloneParsedValue consumes only the public jsonvalue representation. It both
// protects shared request caches from normalization and converts every number
// token exactly once to the JavaScript Number value before any source check.
// The iterative copier adds no depth cap. Cycles and duplicate Object members
// are invalid Go representations, not JSON parser/validation outcomes.
func cloneParsedValue(input any) (any, error) {
	var output any
	type job struct { input any; output *any; leave *containerIdentity }
	jobs := []job{{input: input, output: &output}}
	active := map[containerIdentity]bool{}
	for len(jobs) > 0 {
		current := jobs[len(jobs)-1]
		jobs = jobs[:len(jobs)-1]
		if current.leave != nil { delete(active, *current.leave); continue }
		switch value := current.input.(type) {
		case nil, bool:
			*current.output = value
		case jsonvalue.UTF16String:
			*current.output = slices.Clone(value)
		case json.Number:
			number, err := jsonvalue.NumberFloat64(value)
			if err != nil { return nil, err }
			*current.output = number
		case float64:
			// Normalized values may be validated again without textual rounding.
			*current.output = value
		case []any:
			key := identity(value)
			if active[key] { return nil, errors.New("cyclic parsed contract array") }
			active[key] = true
			jobs = append(jobs, job{leave: &key})
			array := make([]any, len(value))
			*current.output = array
			for index := len(value)-1; index >= 0; index-- { jobs = append(jobs, job{input: value[index], output: &array[index]}) }
		case jsonvalue.Object:
			key := identity(value)
			if active[key] { return nil, errors.New("cyclic parsed contract object") }
			active[key] = true
			jobs = append(jobs, job{leave: &key})
			object := make(jsonvalue.Object, len(value))
			seen := make(map[string]bool, len(value))
			for index, member := range value {
				if seen[member.Key.IdentityKey()] { return nil, errors.New("duplicate parsed contract object member") }
				seen[member.Key.IdentityKey()] = true
				object[index].Key = slices.Clone(member.Key)
			}
			*current.output = object
			for index := len(value)-1; index >= 0; index-- { jobs = append(jobs, job{input: value[index].Value, output: &object[index].Value}) }
		default:
			return nil, fmt.Errorf("%T is not a parsed shared JSON representation", current.input)
		}
	}
	return output, nil
}

// standardValue is called only after source validation succeeds. Supported
// strings have code-point length/positive-ASCII constraints; enums and object
// keys already matched exact ASCII source names. Surrogate replacement exists
// solely in this internal predicate projection and never in data/readback/IDs.
func standardValue(input any) (any, error) {
	switch value := input.(type) {
	case nil, bool: return value, nil
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) { return nil, ErrSchemaDisagreement }
		return value, nil
	case jsonvalue.UTF16String: return validationString(value), nil
	case []any:
		output := make([]any, len(value))
		for index, item := range value {
			var err error
			output[index], err = standardValue(item)
			if err != nil { return nil, err }
		}
		return output, nil
	case jsonvalue.Object:
		output := make(map[string]any, len(value))
		for _, member := range value {
			key, err := member.Key.UTF8()
			if err != nil { return nil, fmt.Errorf("accepted object key was not source-supported: %w", err) }
			output[key], err = standardValue(member.Value)
			if err != nil { return nil, err }
		}
		return output, nil
	default: return nil, ErrSchemaDisagreement
	}
}

func metadataUTF8(data []byte) error {
	value, err := jsonvalue.Parse(data)
	if err != nil { return err }
	pending := []any{value}
	for len(pending) > 0 {
		value := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		switch typed := value.(type) {
		case jsonvalue.UTF16String:
			if _, err := typed.UTF8(); err != nil { return fmt.Errorf("source metadata contains unsupported lone-surrogate text: %w", err) }
		case jsonvalue.Object:
			for _, member := range typed {
				if _, err := member.Key.UTF8(); err != nil { return err }
				pending = append(pending, member.Value)
			}
		case []any: pending = append(pending, typed...)
		}
	}
	return nil
}
