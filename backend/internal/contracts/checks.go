package contracts

import (
	"fmt"
	"math"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

func (check *sourceCheck) run(payload *parsePayload) {
	switch check.Kind {
	case "overwrite":
		payload.value = trimText(payload.value.(jsonvalue.UTF16String))
	case "custom":
		check.conditionalPresence(payload)
	case "min_length", "max_length", "length_equals":
		length, origin, _ := lengthValue(payload.value)
		number, err := numericPrimitive(length)
		if err != nil { payload.err = err; return }
		if check.Kind == "min_length" && !(number >= *check.Minimum) {
			check.boundIssue(payload, false, origin, *check.Minimum, true, false)
		}
		if check.Kind == "max_length" && !(number <= *check.Maximum) {
			check.boundIssue(payload, true, origin, *check.Maximum, true, false)
		}
		strictLength, numericLength := length.(float64)
		if check.Kind == "length_equals" && (!numericLength || strictLength != *check.Length) {
			check.boundIssue(payload, number > *check.Length, origin, *check.Length, true, true)
		}
	case "string_format":
		value := payload.value.(jsonvalue.UTF16String)
		if check.patternMatch(value) { return }
		message := "Invalid " + check.Format
		switch check.Format {
		case "regex": message = "Invalid string: must match pattern " + check.PatternDisplay
		case "uuid": message = "Invalid UUID"
		case "guid": message = "Invalid GUID"
		case "datetime": message = "Invalid ISO datetime"
		case "date": message = "Invalid ISO date"
		case "time": message = "Invalid ISO time"
		}
		payload.add(makeIssue("invalid_format", units(message), field("origin", units("string")),
			field("format", units(check.Format)), field("pattern", units(check.PatternDisplay))), !check.abort(), check.abort())
	case "greater_than", "less_than":
		value := payload.value.(float64)
		bound := *check.Value
		inclusive := *check.Inclusive
		if check.Kind == "greater_than" && !(value > bound || inclusive && value == bound) {
			check.boundIssue(payload, false, "number", bound, inclusive, false)
		}
		if check.Kind == "less_than" && !(value < bound || inclusive && value == bound) {
			check.boundIssue(payload, true, "number", bound, inclusive, false)
		}
	case "number_format":
		check.safeInteger(payload)
	default:
		panic("unsupported check passed registry admission")
	}
}

func (check *sourceCheck) boundIssue(payload *parsePayload, big bool, origin string, bound float64, inclusive, exact bool) {
	code, adjective, key, relation := "too_small", "Too small", "minimum", ">"
	if big { code, adjective, key, relation = "too_big", "Too big", "maximum", "<" }
	if exact { relation = "exactly " } else if inclusive { relation += "=" }
	message := fmt.Sprintf("%s: expected %s to be %s%s", adjective, origin, relation, numericText(bound))
	unit := ""
	if origin == "string" { unit = "characters" }
	if origin == "array" { unit = "items" }
	if unit != "" { message = fmt.Sprintf("%s: expected %s to have %s%s %s", adjective, origin, relation, numericText(bound), unit) }
	properties := []jsonvalue.Member{field("origin", units(origin)), field(key, bound), field("inclusive", inclusive)}
	if exact { properties = append(properties, field("exact", true)) }
	payload.add(makeIssue(code, units(message), properties...), !check.abort(), check.abort())
}

func (check *sourceCheck) safeInteger(payload *parsePayload) {
	number := payload.value.(float64)
	if math.Trunc(number) != number {
		message := "Invalid input: expected int, received number"
		payload.add(makeIssue("invalid_type", units(message), field("expected", units("int")),
			field("format", units(check.Format))), false, true)
		return
	}
	const maximum = float64(9007199254740991)
	if number >= -maximum && number <= maximum { return }
	bound := maximum
	if number < 0 { bound = -maximum }
	check.boundIssue(payload, number > 0, "int", bound, true, false)
	last := &payload.issues[len(payload.issues)-1].issue
	last.Properties = append(last.Properties, field("note", units("Integers must be within the safe integer range.")))
}

func (check *sourceCheck) conditionalPresence(payload *parsePayload) {
	rule := check.Rule
	object := payload.value.(jsonvalue.Object)
	discriminator, _ := objectValue(object, rule.Discriminator)
	value, present := objectValue(object, rule.Field)
	text, stringValue := discriminator.(jsonvalue.UTF16String)
	required := stringValue && text.Equal(units(rule.Equals))
	truthy := present && valueTruthy(value)
	message := ""
	if required && !truthy { message = rule.RequiredMessage }
	if !required && truthy { message = rule.ForbiddenMessage }
	if message == "" { return }
	issue := makeIssue("custom", units(message))
	issue.Path = []any{TextFromUTF16(units(rule.Field))}
	payload.add(issue, !check.abort(), check.abort())
}

func objectValue(object jsonvalue.Object, key string) (any, bool) {
	name := units(key)
	for _, member := range object { if member.Key.Equal(name) { return member.Value, true } }
	return missingValue{}, false
}

func valueTruthy(value any) bool {
	switch typed := value.(type) {
	case nil, missingValue: return false
	case bool: return typed
	case jsonvalue.UTF16String: return len(typed) != 0
	case float64: return typed != 0 && !math.IsNaN(typed)
	default: return true
	}
}

func lengthValue(value any) (any, string, bool) {
	switch typed := value.(type) {
	case jsonvalue.UTF16String: return float64(typed.CodePointCount()), "string", true
	case []any: return float64(len(typed)), "array", true
	case jsonvalue.Object:
		length, present := objectValue(typed, "length")
		return length, "unknown", present
	default: return nil, "unknown", false
	}
}

func trimText(value jsonvalue.UTF16String) jsonvalue.UTF16String {
	start, end := 0, len(value)
	for start < end && ecmaSpace(value[start]) { start++ }
	for end > start && ecmaSpace(value[end-1]) { end-- }
	return value[start:end]
}

func ecmaSpace(unit uint16) bool {
	return unit >= 0x0009 && unit <= 0x000d || unit == 0x0020 || unit == 0x00a0 ||
		unit == 0x1680 || unit >= 0x2000 && unit <= 0x200a || unit == 0x2028 ||
		unit == 0x2029 || unit == 0x202f || unit == 0x205f || unit == 0x3000 || unit == 0xfeff
}

func numericText(value float64) string {
	if math.IsNaN(value) { return "NaN" }
	if math.IsInf(value, 1) { return "Infinity" }
	if math.IsInf(value, -1) { return "-Infinity" }
	text, err := canonicaljson.Canonical(value)
	if err != nil { panic("finite JSON number failed canonical encoding") }
	return text
}
