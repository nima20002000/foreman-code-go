package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
)

// Optional records missing separately from the field's value. Generated object
// fields use the omitzero JSON tag; missing fields disappear instead of null.
// Optional[Nullable[T]] preserves missing, explicit null, and a present value.
type Optional[T any] struct {
	value T
	present bool
}

func Some[T any](value T) Optional[T] {
	return Optional[T]{value: value, present: true}
}

func (o Optional[T]) Get() (T, bool) {
	return o.value, o.present
}

func (o Optional[T]) IsZero() bool {
	return !o.present
}

func (o Optional[T]) MarshalJSON() ([]byte, error) {
	if !o.present {
		return nil, errors.New("a missing contract field cannot be marshaled as a standalone value")
	}
	return json.Marshal(o.value)
}

func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	if o == nil {
		return errors.New("cannot decode an optional field into a nil receiver")
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.value, o.present = value, true
	return nil
}

// Nullable's zero value is explicit JSON null. Present constructs a non-null
// value; use Optional[Nullable[T]] when absence is also allowed by the schema.
type Nullable[T any] struct {
	value T
	nonnull bool
}

func Present[T any](value T) Nullable[T] {
	return Nullable[T]{value: value, nonnull: true}
}

func (n Nullable[T]) Get() (T, bool) {
	return n.value, n.nonnull
}

func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if !n.nonnull {
		return []byte("null"), nil
	}
	return json.Marshal(n.value)
}

func (n *Nullable[T]) UnmarshalJSON(data []byte) error {
	if n == nil {
		return errors.New("cannot decode a nullable field into a nil receiver")
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		*n = Nullable[T]{}
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	n.value, n.nonnull = value, true
	return nil
}
