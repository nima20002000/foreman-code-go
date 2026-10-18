package modelcatalog

import (
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// These native connection names and token spellings are the frozen product
// constants used by appMcpLauncher.ts and secrets.ts, not copied API schemas.
var excludedAppMCPNames = [...]string{"foreman-code", "graphql", "graphql-app", "graphql-operator"}

func inheritedEnvironment(source map[string]string) map[string]string {
	environment := make(map[string]string, len(source)+1)
	for key, value := range source {
		if !controllerVariable(key) {
			environment[key] = value
		}
	}
	environment["NO_COLOR"] = "1"
	return environment
}

func controllerVariable(key string) bool {
	if key == "NODE_OPTIONS" || strings.HasPrefix(key, "OPERATOR_") || strings.HasSuffix(key, "DATABASE_URL") ||
		key == "PGPASSWORD" || key == "GRAPHQL_PRODUCTION_DB_PASSWORD" || key == "FOREMAN_CODE_PRODUCTION_DB_PASSWORD" ||
		key == "FOREMAN_CODE_MCP_TOKEN" || key == "GRAPHQL_MCP_TOKEN" {
		return true
	}
	for _, prefix := range []string{"GRAPHQL_", "FOREMAN_CODE_"} {
		if strings.HasPrefix(key, prefix) {
			rest := strings.TrimPrefix(key, prefix)
			return strings.HasPrefix(rest, "OPERATOR_") || strings.HasPrefix(rest, "APP_") || strings.HasPrefix(rest, "TEST_")
		}
	}
	return false
}

func configuredExclusions(result CommandResult) ([]string, error) {
	if result.ExitCode == nil || *result.ExitCode != 0 {
		return nil, invalidMCP()
	}
	value, err := jsonvalue.Parse([]byte(result.Stdout))
	if err != nil {
		return nil, invalidMCP()
	}
	entries, ok := value.([]any)
	if !ok || len(entries) > 500 {
		return nil, invalidMCP()
	}
	configured := make(map[string]struct{}, len(entries))
	for _, value := range entries {
		entry, ok := value.(jsonvalue.Object)
		if !ok {
			return nil, invalidMCP()
		}
		name, ok := property(entry, "name").(jsonvalue.UTF16String)
		if !ok {
			return nil, invalidMCP()
		}
		configured[name.IdentityKey()] = struct{}{}
	}
	disabled := []string{}
	for _, name := range excludedAppMCPNames {
		if _, exists := configured[text(name).IdentityKey()]; exists {
			disabled = append(disabled, name)
		}
	}
	return disabled, nil
}
