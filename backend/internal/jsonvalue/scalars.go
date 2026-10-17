package jsonvalue

import (
	"encoding/json"
	"errors"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// ParseString uses the same scanner as Parse, accepting only a JSON string with
// optional JSON whitespace. Escaped surrogate units are retained exactly.
func ParseString(data []byte) (UTF16String, error) {
	if !utf8.Valid(data) {
		return nil, &SyntaxError{Reason: "input requires valid UTF-8"}
	}
	p := parser{data: data}
	p.space()
	value, err := p.string()
	if err != nil { return nil, err }
	p.space()
	if p.offset != len(data) {
		return nil, p.invalid("unexpected data after the JSON string")
	}
	return value, nil
}

// NumberFloat64 validates one JSON number token and applies binary64 rounding.
// Valid overflow returns infinity, as JSON.parse does; this is not admission as
// a finite number, integer, or safe integer. Callers apply their source policy.
func NumberFloat64(value json.Number) (float64, error) {
	p := parser{data: []byte(value)}
	if _, err := p.number(); err != nil { return 0, err }
	if p.offset != len(p.data) { return 0, p.invalid("unexpected data after a JSON number") }
	number, err := strconv.ParseFloat(string(value), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return 0, &SyntaxError{Reason: "invalid JSON number"}
	}
	return number, nil
}

func (p *parser) string() (UTF16String, error) {
	if !p.take('"') { return nil, p.invalid("expected a JSON string") }
	units := make(UTF16String, 0)
	for p.offset < len(p.data) {
		value := p.data[p.offset]
		p.offset++
		switch {
		case value == '"': return units, nil
		case value < 0x20: return nil, p.invalid("unescaped control character in JSON string")
		case value == '\\':
			unit, err := p.escape()
			if err != nil { return nil, err }
			units = append(units, unit)
		case value < utf8.RuneSelf:
			units = append(units, uint16(value))
		default:
			char, size := utf8.DecodeRune(p.data[p.offset-1:])
			p.offset += size-1
			if char > 0xffff {
				high, low := utf16.EncodeRune(char)
				units = append(units, uint16(high), uint16(low))
			} else {
				units = append(units, uint16(char))
			}
		}
	}
	return nil, p.invalid("unterminated JSON string")
}

func (p *parser) escape() (uint16, error) {
	if p.offset == len(p.data) { return 0, p.invalid("unterminated JSON string escape") }
	value := p.data[p.offset]
	p.offset++
	switch value {
	case '"', '\\', '/': return uint16(value), nil
	case 'b': return '\b', nil
	case 'f': return '\f', nil
	case 'n': return '\n', nil
	case 'r': return '\r', nil
	case 't': return '\t', nil
	case 'u':
		if len(p.data)-p.offset < 4 { return 0, p.invalid("incomplete Unicode escape") }
		var unit uint16
		for count := 0; count < 4; count++ {
			char := p.data[p.offset]
			var digit uint16
			switch {
			case char >= '0' && char <= '9': digit = uint16(char-'0')
			case char >= 'a' && char <= 'f': digit = uint16(char-'a'+10)
			case char >= 'A' && char <= 'F': digit = uint16(char-'A'+10)
			default: return 0, p.invalid("invalid hexadecimal Unicode escape")
			}
			unit = unit*16+digit
			p.offset++
		}
		return unit, nil
	default:
		return 0, p.invalid("invalid JSON string escape")
	}
}
