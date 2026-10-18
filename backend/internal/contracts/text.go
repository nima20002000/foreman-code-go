// Package contracts provides the generated shared-contract boundary.
package contracts

import (
	"errors"
	"slices"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

var ErrInvalidUTF16 = jsonvalue.ErrInvalidUTF16

// Text preserves every JavaScript string value, including unpaired surrogates.
// Its zero value is the empty string. UTF8 rejects values that cannot be encoded
// losslessly; IdentityKey returns an opaque key without replacing code units.
type Text struct {
	units jsonvalue.UTF16String
}

func TextFromUTF8(value string) (Text, error) {
	units, err := jsonvalue.FromUTF8(value)
	return Text{units: units}, err
}

func TextFromUTF16(units []uint16) Text {
	return Text{units: slices.Clone(units)}
}

func (value Text) UTF16() []uint16 { return slices.Clone(value.units) }

func (value Text) UTF8() (string, error) { return value.units.UTF8() }

func (value Text) Equal(other Text) bool { return value.units.Equal(other.units) }

// IdentityKey delegates to the single shared UTF-16 identity encoding. It is
// neither display text nor a credential, and must not be serialized as the ID.
func (value Text) IdentityKey() string { return value.units.IdentityKey() }

// JSONValue returns the lossless representation accepted by canonicaljson.
func (value Text) JSONValue() any { return slices.Clone(value.units) }

func (value Text) MarshalJSON() ([]byte, error) {
	text, err := canonicaljson.Canonical(value.JSONValue())
	return []byte(text), err
}

func (value *Text) UnmarshalJSON(data []byte) error {
	if value == nil {
		return errors.New("cannot decode contract text into a nil receiver")
	}
	units, err := jsonvalue.ParseString(data)
	if err != nil { return err }
	value.units = units
	return nil
}
