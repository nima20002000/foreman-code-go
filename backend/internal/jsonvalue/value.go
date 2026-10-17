// Package jsonvalue reads JSON into lossless JavaScript-compatible values.
// Transport decoding and schema validation remain the caller's responsibility.
package jsonvalue

import (
	"errors"
	"slices"
	"unicode/utf16"
	"unicode/utf8"
)

var ErrInvalidUTF16 = errors.New("text contains an unpaired UTF-16 surrogate")

// UTF16String retains every JavaScript string value, including lone surrogates.
// It deliberately has no String method that could silently replace code units.
type UTF16String []uint16

// Member is an enumerable string-keyed property of an Object.
type Member struct {
	Key UTF16String
	Value any
}

// Object contains unique keys. Parse returns JavaScript Object.keys order:
// array-index names first numerically, then other names in first insertion order.
// A later duplicate property replaces its value without moving its position.
type Object []Member

func FromUTF8(value string) (UTF16String, error) {
	if !utf8.ValidString(value) {
		return nil, errors.New("text requires valid UTF-8")
	}
	return utf16.Encode([]rune(value)), nil
}

// UTF8 rejects unpaired surrogates instead of replacing identity-bearing text.
func (value UTF16String) UTF8() (string, error) {
	for index := 0; index < len(value); index++ {
		unit := value[index]
		if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(value) &&
			value[index+1] >= 0xdc00 && value[index+1] <= 0xdfff {
			index++
		} else if unit >= 0xd800 && unit <= 0xdfff {
			return "", ErrInvalidUTF16
		}
	}
	return string(utf16.Decode(value)), nil
}

func (value UTF16String) Equal(other UTF16String) bool {
	return slices.Equal(value, other)
}

// IdentityKey is an opaque, injective big-endian encoding of UTF-16 units.
// It is a Go map/identity key, not UTF-8 display text, an authorization token,
// or a canonical JSON serialization. Empty text has the empty key.
func (value UTF16String) IdentityKey() string {
	bytes := make([]byte, len(value)*2)
	for index, unit := range value {
		bytes[index*2] = byte(unit >> 8)
		bytes[index*2+1] = byte(unit)
	}
	return string(bytes)
}

// CodePointCount matches JavaScript string iteration, including lone units.
func (value UTF16String) CodePointCount() int {
	count := 0
	for index := 0; index < len(value); index++ {
		count++
		if value[index] >= 0xd800 && value[index] <= 0xdbff && index+1 < len(value) &&
			value[index+1] >= 0xdc00 && value[index+1] <= 0xdfff {
			index++
		}
	}
	return count
}

// ArrayIndex recognizes exact decimal array-index names 0 through 4294967294.
// Names such as -0, 00, 1e0, and 4294967295 are ordinary string properties.
func (value UTF16String) ArrayIndex() (uint32, bool) {
	if len(value) == 0 || len(value) > 10 || len(value) > 1 && value[0] == '0' {
		return 0, false
	}
	var number uint64
	for _, unit := range value {
		if unit < '0' || unit > '9' {
			return 0, false
		}
		number = number*10 + uint64(unit-'0')
	}
	if number >= 1<<32-1 {
		return 0, false
	}
	return uint32(number), true
}
