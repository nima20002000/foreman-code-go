// Package config reads the same product environment aliases as packages/contracts.
package config

import (
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	whatwgurl "github.com/nlnwa/whatwg-url/url"
)

var decimalNumberPattern = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// Environment distinguishes a missing setting from a setting with an empty value.
type Environment map[string]string

// FromEnviron copies the process environment without changing it.
func FromEnviron(values []string) Environment {
	result := make(Environment, len(values))
	for _, entry := range values {
		name, value, found := strings.Cut(entry, "=")
		if found {
			result[name] = value
		}
	}
	return result
}

// ReadProduct accepts the current or legacy spelling and never exposes values in errors.
func ReadProduct(environment Environment, suffix string) (string, bool, error) {
	canonicalName := "FOREMAN_CODE_" + suffix
	legacyName := "GRAPHQL_" + suffix
	canonical, hasCanonical := environment[canonicalName]
	legacy, hasLegacy := environment[legacyName]
	if hasCanonical && hasLegacy && !sameEffectiveValue(suffix, canonical, legacy) {
		return "", false, fmt.Errorf("%s conflicts with %s. Supply one value or matching values.", canonicalName, legacyName)
	}
	if hasCanonical {
		return canonical, true, nil
	}
	return legacy, hasLegacy, nil
}

// Resolve selects the process or file layer before resolving each pair of aliases.
// A process alias overrides either spelling from the file, including an empty value.
func Resolve(process, file Environment) (Environment, error) {
	result := make(Environment, len(process)+len(file))
	for name, value := range file {
		result[name] = value
	}
	for name, value := range process {
		result[name] = value
	}
	for name := range result {
		suffix, product := productSuffix(name)
		if !product {
			continue
		}
		canonicalName := "FOREMAN_CODE_" + suffix
		legacyName := "GRAPHQL_" + suffix
		_, hasCanonical := process[canonicalName]
		_, hasLegacy := process[legacyName]
		layer := file
		if hasCanonical || hasLegacy {
			layer = process
		}
		value, _, err := ReadProduct(layer, suffix)
		if err != nil {
			return nil, err
		}
		delete(result, legacyName)
		result[canonicalName] = value
	}
	return result, nil
}

func productSuffix(name string) (string, bool) {
	for _, prefix := range []string{"FOREMAN_CODE_", "GRAPHQL_"} {
		if suffix, found := strings.CutPrefix(name, prefix); found && suffix != "" {
			return suffix, true
		}
	}
	return "", false
}

func sameEffectiveValue(suffix, left, right string) bool {
	if hasSuffix(suffix, "TOKEN", "SECRET", "PASSWORD") {
		return left == right
	}
	if hasSuffix(suffix, "PORT", "TIMEOUT_MS", "SHARDS") {
		leftNumber, leftOK := finiteNumber(trimSpace(left))
		rightNumber, rightOK := finiteNumber(trimSpace(right))
		if trimSpace(left) != "" && trimSpace(right) != "" && leftOK && rightOK {
			return leftNumber == rightNumber
		}
	}
	if strings.HasSuffix(suffix, "ORIGIN") {
		return normalizeURL(left) == normalizeURL(right)
	}
	if suffix == "DEV_OPERATOR_PRINCIPAL_ID" {
		return trimSpace(left) == trimSpace(right)
	}
	return left == right
}

func hasSuffix(value string, suffixes ...string) bool {
	for _, suffix := range suffixes {
		if strings.HasSuffix(value, suffix) {
			return true
		}
	}
	return false
}

func trimSpace(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		return character >= '\t' && character <= '\r' ||
			character >= '\u2000' && character <= '\u200A' ||
			strings.ContainsRune(" \u00A0\u1680\u2028\u2029\u202F\u205F\u3000\uFEFF", character)
	})
}

// finiteNumber follows Number(string) for finite environment numbers, including radix prefixes.
func finiteNumber(value string) (float64, bool) {
	if value == "" {
		return 0, true
	}
	if strings.Contains(value, "_") {
		return 0, false
	}
	if len(value) > 2 && value[0] == '0' && strings.ContainsRune("xXoObB", rune(value[1])) {
		parsed, valid := new(big.Int).SetString(value, 0)
		if !valid {
			return 0, false
		}
		number, _ := parsed.Float64()
		return number, !math.IsInf(number, 0)
	}
	// ParseFloat also accepts signed hexadecimal floats, which Number(string)
	// rejects. Only JavaScript's decimal grammar reaches that conversion.
	if !decimalNumberPattern.MatchString(value) {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(value, 64)
	return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
}

func normalizeURL(value string) string {
	trimmed := trimSpace(value)
	parsed, err := whatwgurl.Parse(trimmed)
	if err != nil {
		return trimmed
	}
	return parsed.Href(false)
}
