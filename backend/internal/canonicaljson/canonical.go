// Package canonicaljson implements the current shared TypeScript canonical JSON format.
package canonicaljson

import (
	"errors"
	"reflect"
	"sort"
	"strings"
)

const (
	// DefaultMaxBytes is the frozen canonicalGraphJson default limit.
	DefaultMaxBytes int64 = 8 * 1024 * 1024
	maxSafeInteger int64 = 1<<53 - 1
	maxDepth            = 32
	maxNodes            = 100_000
)

var (
	// ErrInvalid has the public canonicalGraphJson invalid-value error text.
	ErrInvalid = errors.New("GRAPH_JSON_INVALID")
	// ErrLimit has the public canonicalGraphJson resource-limit error text.
	ErrLimit = errors.New("GRAPH_JSON_LIMIT")
	// ErrUndefined reports the non-string result of canonicalJson(undefined).
	ErrUndefined = errors.New("CANONICAL_JSON_UNDEFINED")
)

type undefinedValue struct{}

// Undefined distinguishes an absent JavaScript value from JSON null.
// Canonical omits it in objects and writes null in arrays; Graph rejects it.
var Undefined = undefinedValue{}

// UTF16String preserves JavaScript strings containing unpaired surrogate units.
// Ordinary well-formed Go strings need no conversion to this type.
type UTF16String []uint16

// Member is an enumerable string-keyed property of an Object.
type Member struct {
	Key   UTF16String
	Value any
}

// Object preserves JavaScript property names that cannot be stored losslessly
// as UTF-8 Go strings. Keys must be unique; insertion order is not significant.
type Object []Member

type identity struct {
	typeOf reflect.Type
	pointer uintptr
	length int
}

type encoder struct {
	strict  bool
	numericKeysFirst bool
	limit   int64
	bytes   int64
	visited int
	active  map[identity]bool
	out     strings.Builder
}

// Canonical serializes a JSON-shaped Go value with the frozen canonicalJson
// ordering and JavaScript number formatting. All Go numeric values are treated
// as IEEE-754 JavaScript Numbers. It returns no truncated output on an error.
// Accepted containers are string-keyed maps, arrays, slices, and Object.
func Canonical(value any) (string, error) {
	if _, undefined := value.(undefinedValue); undefined {
		return "", ErrUndefined
	}
	e := encoder{limit: int64(^uint64(0) >> 1), active: make(map[identity]bool)}
	if err := e.value(value, 0); err != nil {
		return "", err
	}
	return e.out.String(), nil
}

// Graph serializes complete, bounded JSON with canonicalGraphJson's byte,
// depth, node, and cycle checks. Callers use DefaultMaxBytes for the TS default.
// Go's integer parameter excludes fractional/NaN limits; out-of-safe-integer
// and negative limits return ErrLimit. No partial output is returned.
func Graph(value any, maxBytes int64) (string, error) {
	if maxBytes < 0 || maxBytes > maxSafeInteger {
		return "", ErrLimit
	}
	e := encoder{strict: true, limit: maxBytes, active: make(map[identity]bool)}
	if err := e.value(value, 0); err != nil {
		return "", err
	}
	return e.out.String(), nil
}

func (e *encoder) push(text string) error {
	if int64(len(text)) > e.limit-e.bytes {
		return ErrLimit
	}
	e.bytes += int64(len(text))
	e.out.WriteString(text)
	return nil
}

func (e *encoder) value(value any, depth int) error {
	if e.strict {
		e.visited++
		if depth > maxDepth || e.visited > maxNodes {
			return ErrLimit
		}
	}
	if value == nil {
		return e.push("null")
	}
	switch item := value.(type) {
	case undefinedValue:
		return ErrInvalid
	case UTF16String:
		return e.string(item)
	case Object:
		return e.object(item, reflect.ValueOf(item), depth)
	}
	if number, numeric, err := numberValue(value); numeric {
		if err != nil {
			return err
		}
		return e.number(number)
	}
	item := reflect.ValueOf(value)
	switch item.Kind() {
	case reflect.Bool:
		if item.Bool() {
			return e.push("true")
		}
		return e.push("false")
	case reflect.String:
		units, err := stringUnits(item.String())
		if err != nil {
			return err
		}
		return e.string(units)
	case reflect.Map:
		if item.Type().Key().Kind() != reflect.String {
			return ErrInvalid
		}
		members := make(Object, 0, item.Len())
		for _, key := range item.MapKeys() {
			units, err := stringUnits(key.String())
			if err != nil {
				return err
			}
			members = append(members, Member{Key: units, Value: item.MapIndex(key).Interface()})
		}
		return e.object(members, item, depth)
	case reflect.Array, reflect.Slice:
		return e.array(item, depth)
	default:
		// Structs, pointers, functions, channels, and other non-JSON Go values
		// are outside the shared JSON-value model. Never call custom marshalers.
		return ErrInvalid
	}
}

func (e *encoder) enter(value reflect.Value) (func(), error) {
	var key identity
	switch value.Kind() {
	case reflect.Map:
		key = identity{typeOf: value.Type(), pointer: uintptr(value.UnsafePointer())}
	case reflect.Slice:
		key = identity{typeOf: value.Type(), pointer: value.Pointer(), length: value.Len()}
	default:
		return func() {}, nil
	}
	if e.active[key] {
		return nil, ErrInvalid
	}
	e.active[key] = true
	return func() { delete(e.active, key) }, nil
}

func (e *encoder) array(value reflect.Value, depth int) error {
	leave, err := e.enter(value)
	if err != nil {
		return err
	}
	defer leave()
	if e.strict && value.Len() > maxNodes-e.visited {
		return ErrLimit
	}
	if err := e.push("["); err != nil {
		return err
	}
	for index := 0; index < value.Len(); index++ {
		if index != 0 {
			if err := e.push(","); err != nil {
				return err
			}
		}
		child := value.Index(index).Interface()
		if _, undefined := child.(undefinedValue); undefined && !e.strict {
			child = nil
		}
		if err := e.value(child, depth+1); err != nil {
			return err
		}
	}
	return e.push("]")
}

func (e *encoder) object(members Object, value reflect.Value, depth int) error {
	leave, err := e.enter(value)
	if err != nil {
		return err
	}
	defer leave()
	if e.strict && len(members) > maxNodes-e.visited {
		return ErrLimit
	}
	ordered := append(Object(nil), members...)
	sort.Slice(ordered, func(left, right int) bool {
		if e.numericKeysFirst {
			return legacyKeyLess(ordered[left].Key, ordered[right].Key)
		}
		return compareUnits(ordered[left].Key, ordered[right].Key) < 0
	})
	if err := e.push("{"); err != nil {
		return err
	}
	written := 0
	for index, member := range ordered {
		if index != 0 && compareUnits(ordered[index-1].Key, member.Key) == 0 {
			return ErrInvalid
		}
		if _, undefined := member.Value.(undefinedValue); undefined && !e.strict {
			continue
		}
		if written != 0 {
			if err := e.push(","); err != nil {
				return err
			}
		}
		if err := e.string(member.Key); err != nil {
			return err
		}
		if err := e.push(":"); err != nil {
			return err
		}
		if err := e.value(member.Value, depth+1); err != nil {
			return err
		}
		written++
	}
	return e.push("}")
}
