package config

import "strings"

// ParseEnv ports the node:util parseEnv parser in Node v24.19.0
// (src/node_dotenv.cc). It preserves quoted/multiline values and parser behavior
// observed in that installed Node version; it does not perform shell expansion.
func ParseEnv(input string) Environment {
	content := trimEnvSpace(strings.ReplaceAll(input, "\r", ""))
	result := make(Environment)
	for content != "" {
		if content[0] == '\n' || content[0] == '#' {
			content = afterEnvLine(content)
			continue
		}
		separator := strings.IndexAny(content, "=\n")
		if separator < 0 {
			break
		}
		if content[separator] == '\n' {
			content = trimEnvSpace(content[separator+1:])
			continue
		}
		key := trimEnvSpace(content[:separator])
		content = content[separator+1:]
		if content == "" || content[0] == '\n' {
			assignEnvironment(result, key, "")
			continue
		}
		content = trimEnvSpace(content)
		if key == "" {
			continue
		}
		if strings.HasPrefix(key, "export ") {
			key = trimEnvSpace(key[len("export "):])
		}
		if content == "" {
			assignEnvironment(result, key, "")
			break
		}
		if content[0] == '\'' || content[0] == '"' || content[0] == '`' {
			closing := strings.IndexByte(content[1:], content[0])
			if closing >= 0 {
				closing++
				value := content[1:closing]
				if content[0] == '"' {
					value = strings.ReplaceAll(value, `\n`, "\n")
				}
				assignEnvironment(result, key, value)
				content = afterEnvLine(content[closing+1:])
				continue
			}
			value, rest, found := strings.Cut(content, "\n")
			assignEnvironment(result, key, value)
			if !found {
				break
			}
			content = rest
		} else {
			value, rest, _ := strings.Cut(content, "\n")
			value, _, _ = strings.Cut(value, "#")
			assignEnvironment(result, key, trimEnvSpace(value))
			content = rest
		}
		content = trimEnvSpace(content)
	}
	return result
}

func trimEnvSpace(value string) string { return strings.Trim(value, " \t\n") }

func afterEnvLine(value string) string {
	_, rest, _ := strings.Cut(value, "\n")
	return rest
}

func assignEnvironment(environment Environment, key, value string) {
	// Node materializes a normal JavaScript object. Assigning a string to its
	// inherited __proto__ setter does not create an environment entry.
	if key != "__proto__" {
		environment[key] = value
	}
}
