package codex

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

var quotedJSONString = regexp.MustCompile(`"(?:\\.|[^"\\])*"`)

func prepareSecrets(secrets []string) []string {
	seen := make(map[string]bool)
	values := make([]string, 0, len(secrets))
	for _, value := range secrets {
		if value != "" && !seen[value] {
			seen[value] = true
			values = append(values, value)
		}
	}
	sort.SliceStable(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	return values
}

func replaceSecrets(value string, secrets []string) string {
	for _, secret := range secrets {
		value = strings.ReplaceAll(value, secret, "[REDACTED]")
	}
	return value
}

func redactText(value string, secrets []string) string {
	if strings.Contains(value, `\`) && strings.Contains(value, `"`) {
		value = quotedJSONString.ReplaceAllStringFunc(value, func(quoted string) string {
			var decoded string
			if json.Unmarshal([]byte(quoted), &decoded) != nil {
				return quoted
			}
			safe := replaceSecrets(decoded, secrets)
			if safe == decoded {
				return quoted
			}
			encoded, _ := json.Marshal(safe)
			return string(encoded)
		})
	}
	return replaceSecrets(value, secrets)
}

// Decode every JSON string before redaction, including keys and strings containing
// escaped JSON. This preserves the frozen app-token boundary without logging frames.
func redactFrame(frame []byte, secrets []string) []byte {
	if len(secrets) == 0 {
		return frame
	}
	return quotedJSONString.ReplaceAllFunc(frame, func(quoted []byte) []byte {
		var decoded string
		if json.Unmarshal(quoted, &decoded) != nil {
			return quoted
		}
		safe := redactText(decoded, secrets)
		if safe == decoded {
			return quoted
		}
		encoded, _ := json.Marshal(safe)
		return encoded
	})
}
