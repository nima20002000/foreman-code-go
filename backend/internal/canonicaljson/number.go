package canonicaljson

import (
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

func numberValue(value any) (float64, bool, error) {
	if number, ok := value.(json.Number); ok {
		parsed, err := jsonvalue.NumberFloat64(number)
		if err != nil {
			return 0, true, ErrInvalid
		}
		return parsed, true, nil
	}
	item := reflect.ValueOf(value)
	switch item.Kind() {
	case reflect.Float32, reflect.Float64:
		return item.Float(), true, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(item.Int()), true, nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(item.Uint()), true, nil
	default:
		return 0, false, nil
	}
}

func (e *encoder) number(value float64) error {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		if e.strict {
			return ErrInvalid
		}
		return e.push("null")
	}
	if value == 0 {
		return e.push("0")
	}
	negative := value < 0
	if negative {
		value = -value
	}
	// Go supplies the shortest round-tripping decimal digits. ECMAScript's
	// decimal-point/exponent thresholds are applied separately below.
	scientific := strconv.FormatFloat(value, 'e', -1, 64)
	coefficient, exponentText, found := strings.Cut(scientific, "e")
	if !found {
		return ErrInvalid
	}
	exponent, err := strconv.Atoi(exponentText)
	if err != nil {
		return ErrInvalid
	}
	digits := strings.ReplaceAll(coefficient, ".", "")
	point := exponent + 1
	var text string
	switch {
	case len(digits) <= point && point <= 21:
		text = digits + strings.Repeat("0", point-len(digits))
	case point > 0 && point <= 21:
		text = digits[:point] + "." + digits[point:]
	case point > -6 && point <= 0:
		text = "0." + strings.Repeat("0", -point) + digits
	default:
		text = digits[:1]
		if len(digits) > 1 {
			text += "." + digits[1:]
		}
		text += "e"
		if exponent >= 0 {
			text += "+"
		}
		text += strconv.Itoa(exponent)
	}
	if negative {
		text = "-" + text
	}
	return e.push(text)
}
