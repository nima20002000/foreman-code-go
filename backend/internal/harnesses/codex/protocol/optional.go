// Package protocol contains generated types for the pinned native Codex protocol.
// These are compile-time types; installation qualification supplies runtime validation.
package protocol

import (
	"bytes"
	"encoding/json"
)

// Optional preserves the native distinction between an absent field, null, and a value.
// Generated fields use omitzero, supported by the repository's pinned Go toolchain.
type Optional[T any] struct {
	value   T
	present bool
	null    bool
}

// Some includes a value in a native request.
func Some[T any](value T) Optional[T] {
	return Optional[T]{value: value, present: true}
}

// Null explicitly resets a nullable native field. It is distinct from its zero value.
func Null[T any]() Optional[T] {
	return Optional[T]{present: true, null: true}
}

// Value returns the decoded value, whether the field was present, and whether it was null.
func (o Optional[T]) Value() (T, bool, bool) {
	return o.value, o.present, o.null
}

func (o Optional[T]) IsZero() bool { return !o.present }

func (o Optional[T]) MarshalJSON() ([]byte, error) {
	if !o.present || o.null {
		return []byte("null"), nil
	}
	return json.Marshal(o.value)
}

func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	var value T
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		*o = Null[T]()
		return nil
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*o = Some(value)
	return nil
}
