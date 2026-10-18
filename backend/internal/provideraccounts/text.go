package provideraccounts

import "github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"

// AuthMethodConversionError preserves the ordinary native String conversion
// failure. It is not a domain failure and each failed observation has its own
// error value. It intentionally exposes no native output or credential data.
type AuthMethodConversionError struct {
	message string
}

func (err *AuthMethodConversionError) Error() string { return err.message }

func asciiLower(value string) string {
	bytes := []byte(value)
	for index, char := range bytes {
		if char >= 'A' && char <= 'Z' {
			bytes[index] = char + ('a' - 'A')
		}
	}
	return string(bytes)
}

func asciiTextEqual(value jsonvalue.UTF16String, expected string) bool {
	if len(value) != len(expected) {
		return false
	}
	for index, unit := range value {
		if unit != uint16(expected[index]) {
			return false
		}
	}
	return true
}

func jsWhitespace(char rune) bool {
	switch char {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680,
		0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	default:
		return char >= 0x2000 && char <= 0x200a
	}
}

func hasNativeControl(value jsonvalue.UTF16String) bool {
	for _, unit := range value {
		if unit < 0x20 || unit == 0x7f {
			return true
		}
	}
	return false
}

func safeIdentity(value jsonvalue.UTF16String) bool {
	if len(value) > 200 || hasNativeControl(value) {
		return false
	}
	at := -1
	for index, unit := range value {
		if jsWhitespace(rune(unit)) {
			return false
		}
		if unit == '@' {
			if at != -1 {
				return false
			}
			at = index
		}
	}
	if at <= 0 {
		return false
	}
	for index := at + 2; index < len(value)-1; index++ {
		if value[index] == '.' {
			return true
		}
	}
	return false
}

// apiKeyAuthMethod implements only the observable API-key marker predicate in
// String(authMethod). Commas, numbers, booleans and ordinary objects cannot be
// either marker. Arrays still visit every element after a mismatch because a
// later object's own non-callable toString must raise the native conversion
// error. JSON has no callable properties or cyclic arrays.
func apiKeyAuthMethod(value any) (bool, error) {
	possible := true
	text := make(jsonvalue.UTF16String, 0, len("api_key"))
	var visit func(any, bool) error
	visit = func(value any, arrayElement bool) error {
		switch value := value.(type) {
		case nil:
			if !arrayElement {
				possible = false
			}
		case jsonvalue.UTF16String:
			if possible && len(text)+len(value) <= len("api_key") {
				text = append(text, value...)
			} else {
				possible = false
			}
		case []any:
			for index, element := range value {
				if index != 0 {
					possible = false
				}
				if err := visit(element, true); err != nil {
					return err
				}
			}
		case jsonvalue.Object:
			if _, ownToString := nativeProperty(value, "toString"); ownToString {
				return &AuthMethodConversionError{message: "Cannot convert object to primitive value"}
			}
			possible = false
		default:
			possible = false
		}
		return nil
	}
	if err := visit(value, false); err != nil {
		return false, err
	}
	return possible && (asciiTextEqual(text, "api_key") || asciiTextEqual(text, "api-key")), nil
}
