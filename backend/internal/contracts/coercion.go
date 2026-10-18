package contracts

import (
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

var decimalNumericText = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// numericPrimitive ports only the JSON-domain relational coercion used by the
// pinned built-in length guard after a type failure. This never turns an invalid
// value into an accepted contract value. Source prototype-shadowing throws are
// surfaced separately from ValidationError; exact engine exception messages are
// not projected into Zod issues or claimed as a qualified portable boundary.
func numericPrimitive(value any) (float64, error) {
	switch typed := value.(type) {
	case nil: return 0, nil
	case missingValue: return math.NaN(), nil
	case float64: return typed, nil
	case bool:
		if typed { return 1, nil }
		return 0, nil
	case jsonvalue.UTF16String:
		return numericString(typed), nil
	case []any, jsonvalue.Object:
		primitive, err := stringPrimitive(value)
		if err != nil { return 0, err }
		return numericString(primitive), nil
	default:
		return 0, errors.New("non-JSON length operand reached the source runtime")
	}
}

func numericString(value jsonvalue.UTF16String) float64 {
	text, err := trimText(value).UTF8()
	if err != nil { return math.NaN() }
	if text == "" { return 0 }
	if text == "Infinity" || text == "+Infinity" { return math.Inf(1) }
	if text == "-Infinity" { return math.Inf(-1) }
	if len(text) > 2 && text[0] == '0' {
		base := 0
		switch text[1] {
		case 'x', 'X': base = 16
		case 'b', 'B': base = 2
		case 'o', 'O': base = 8
		}
		if base != 0 {
			for _, char := range text[2:] {
				valid := char >= '0' && char <= '9' && int(char-'0') < base
				if base == 16 { valid = valid || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F' }
				if !valid { return math.NaN() }
			}
			integer, ok := new(big.Int).SetString(text[2:], base)
			if !ok { return math.NaN() }
			value, _ := new(big.Float).SetPrec(53).SetMode(big.ToNearestEven).SetInt(integer).Float64()
			return value
		}
	}
	if !decimalNumericText.MatchString(text) { return math.NaN() }
	number, err := strconv.ParseFloat(text, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) { return math.NaN() }
	return number
}

func stringPrimitive(value any) (jsonvalue.UTF16String, error) {
	switch typed := value.(type) {
	case nil: return units("null"), nil
	case missingValue: return units("undefined"), nil
	case jsonvalue.UTF16String: return typed, nil
	case float64: return units(numericText(typed)), nil
	case bool: return units(strconv.FormatBool(typed)), nil
	case jsonvalue.Object:
		if _, exists := objectValue(typed, "toString"); exists {
			return nil, errors.New("source TypeError during JSON object primitive conversion; engine message parity is unqualified")
		}
		return units("[object Object]"), nil
	case []any:
		out := jsonvalue.UTF16String{}
		for index, item := range typed {
			if index != 0 { out = append(out, ',') }
			if item == nil { continue }
			if _, missing := item.(missingValue); missing { continue }
			text, err := stringPrimitive(item)
			if err != nil { return nil, err }
			out = append(out, text...)
		}
		return out, nil
	default:
		return nil, errors.New("non-JSON primitive conversion reached the source runtime")
	}
}

func sourcePropertySupported(key string) bool {
	// These names observe Object.prototype when the JSON input omits the field.
	// No initially selected root declares one; a future root needs an explicit
	// source-owned property lookup adapter rather than an own-key approximation.
	switch key {
	case "__proto__", "constructor", "toString", "toLocaleString", "valueOf",
		"hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__",
		"__defineSetter__", "__lookupGetter__", "__lookupSetter__":
		return false
	}
	return key != "" && !strings.ContainsAny(key, "\x00\r\n")
}
