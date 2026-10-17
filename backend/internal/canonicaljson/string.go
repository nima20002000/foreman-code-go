package canonicaljson

import (
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

func stringUnits(value string) (UTF16String, error) {
	if !utf8.ValidString(value) {
		return nil, ErrInvalid
	}
	return utf16.Encode([]rune(value)), nil
}

func compareUnits(left, right []uint16) int {
	for index := 0; index < len(left) && index < len(right); index++ {
		if left[index] < right[index] {
			return -1
		}
		if left[index] > right[index] {
			return 1
		}
	}
	if len(left) < len(right) {
		return -1
	}
	if len(left) > len(right) {
		return 1
	}
	return 0
}

func (e *encoder) string(units UTF16String) error {
	// The TS lower-bound check counts UTF-16 units before encoding a string.
	if e.strict && int64(len(units)) > e.limit-e.bytes {
		return ErrLimit
	}
	var text strings.Builder
	text.WriteByte('"')
	for index := 0; index < len(units); index++ {
		unit := units[index]
		switch unit {
		case '"', '\\':
			text.WriteByte('\\')
			text.WriteByte(byte(unit))
		case '\b':
			text.WriteString(`\b`)
		case '\f':
			text.WriteString(`\f`)
		case '\n':
			text.WriteString(`\n`)
		case '\r':
			text.WriteString(`\r`)
		case '\t':
			text.WriteString(`\t`)
		default:
			if unit < 0x20 {
				writeEscape(&text, unit)
			} else if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(units) &&
				units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff {
				text.WriteRune(utf16.DecodeRune(rune(unit), rune(units[index+1])))
				index++
			} else if unit >= 0xd800 && unit <= 0xdfff {
				writeEscape(&text, unit)
			} else {
				// JSON.stringify does not escape HTML or U+2028/U+2029.
				text.WriteRune(rune(unit))
			}
		}
	}
	text.WriteByte('"')
	return e.push(text.String())
}

func writeEscape(text *strings.Builder, unit uint16) {
	const digits = "0123456789abcdef"
	text.WriteString(`\u`)
	text.WriteByte(digits[unit>>12])
	text.WriteByte(digits[(unit>>8)&0xf])
	text.WriteByte(digits[(unit>>4)&0xf])
	text.WriteByte(digits[unit&0xf])
}
