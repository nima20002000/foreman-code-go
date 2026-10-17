package config_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
)

func TestProductAliasesPreserveChosenValue(t *testing.T) {
	tests := []struct {
		name        string
		suffix      string
		environment config.Environment
		want        string
		present     bool
	}{
		{name: "missing", suffix: "WEB_PORT"},
		{name: "legacy", suffix: "WEB_PORT", environment: config.Environment{"GRAPHQL_WEB_PORT": "5198"}, want: "5198", present: true},
		{name: "empty", suffix: "MCP_TOKEN", environment: config.Environment{"FOREMAN_CODE_MCP_TOKEN": ""}, present: true},
		{name: "number", suffix: "WEB_PORT", environment: config.Environment{"FOREMAN_CODE_WEB_PORT": "5198", "GRAPHQL_WEB_PORT": "05198"}, want: "5198", present: true},
		{name: "radix number", suffix: "WEB_PORT", environment: config.Environment{"FOREMAN_CODE_WEB_PORT": "16", "GRAPHQL_WEB_PORT": "0x10"}, want: "16", present: true},
		{name: "origin", suffix: "BROWSER_ORIGIN", environment: config.Environment{"FOREMAN_CODE_BROWSER_ORIGIN": "http://localhost:5198/", "GRAPHQL_BROWSER_ORIGIN": "http://localhost:5198"}, want: "http://localhost:5198/", present: true},
		{name: "principal", suffix: "DEV_OPERATOR_PRINCIPAL_ID", environment: config.Environment{"FOREMAN_CODE_DEV_OPERATOR_PRINCIPAL_ID": " principal ", "GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID": "principal"}, want: " principal ", present: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value, present, err := config.ReadProduct(test.environment, test.suffix)
			if err != nil || value != test.want || present != test.present {
				t.Fatalf("ReadProduct() = (%q, %v, %v), want (%q, %v, nil)", value, present, err, test.want, test.present)
			}
		})
	}
}

func TestProductAliasesRejectExactValueConflictsWithoutSecrets(t *testing.T) {
	for _, suffix := range []string{"MCP_TOKEN", "PASSWORD", "API_ENV_FILE", "HEAVY_BASE_TMPDIR", "LAPTOP_EXECUTION_ENABLED"} {
		t.Run(suffix, func(t *testing.T) {
			_, _, err := config.ReadProduct(config.Environment{
				"FOREMAN_CODE_" + suffix: "private-value",
				"GRAPHQL_" + suffix:      "private-value ",
			}, suffix)
			var invalid *config.ValidationError
			want := "FOREMAN_CODE_" + suffix + " conflicts with GRAPHQL_" + suffix + ". Supply one value or matching values."
			if !errors.As(err, &invalid) || invalid.Setting != "FOREMAN_CODE_"+suffix ||
				err.Error() != want || strings.Contains(err.Error(), "private-value") {
				t.Fatalf("Expected a conflict naming settings only, got %v", err)
			}
		})
	}
}

func TestNumericAliasesPreserveObservedJavaScriptNumberSyntax(t *testing.T) {
	// Number(string) results observed in installed Node v24.19.0.
	for _, pair := range [][2]string{
		{"+12", "12"}, {"-12", "-12.0"}, {".5", "0.5"}, {"1.", "1"},
		{"1e2", "100"}, {"-.5e+1", "-5"}, {"0x10", "16"}, {"0b10", "2"}, {"0o10", "8"},
	} {
		t.Run(pair[0], func(t *testing.T) {
			value, present, err := config.ReadProduct(config.Environment{
				"FOREMAN_CODE_WEB_PORT": pair[0], "GRAPHQL_WEB_PORT": pair[1],
			}, "WEB_PORT")
			if err != nil || !present || value != pair[0] {
				t.Fatalf("Equivalent numeric aliases = (%q, %v, %v), want chosen value %q", value, present, err, pair[0])
			}
		})
	}
}

func TestConfigurationRejectsGoNumericSyntaxThatJavaScriptRejects(t *testing.T) {
	for _, pair := range [][2]string{
		{"+0x1p2", "4"}, {"-0x1p2", "-4"}, {"+0x10", "16"},
		{"-0x10", "-16"}, {"1_0", "10"}, {"1e", "1"},
	} {
		t.Run(pair[0], func(t *testing.T) {
			_, _, err := config.ReadProduct(config.Environment{
				"FOREMAN_CODE_WEB_PORT": pair[0], "GRAPHQL_WEB_PORT": pair[1],
			}, "WEB_PORT")
			if err == nil {
				t.Fatal("JavaScript-invalid number syntax must not make distinct aliases equivalent")
			}
			_, err = config.Load(config.Environment{
				"DATABASE_URL": "postgresql://127.0.0.1/example", "PORT": pair[0],
			})
			if err == nil {
				t.Fatal("JavaScript-invalid number syntax must not pass configuration validation")
			}
		})
	}
}

func TestProcessAliasesOverrideTheFileLayerWithoutMutation(t *testing.T) {
	process := config.Environment{"GRAPHQL_WEB_PORT": "5198", "DATABASE_URL": "process-db"}
	file := config.Environment{"FOREMAN_CODE_WEB_PORT": "5199", "GRAPHQL_WEB_PORT": "5200", "DATABASE_URL": "file-db"}
	resolved, err := config.Resolve(process, file)
	if err != nil {
		t.Fatal(err)
	}
	want := config.Environment{"FOREMAN_CODE_WEB_PORT": "5198", "DATABASE_URL": "process-db"}
	if !reflect.DeepEqual(resolved, want) {
		t.Fatalf("Resolved environment = %#v, want %#v", resolved, want)
	}
	if process["GRAPHQL_WEB_PORT"] != "5198" || file["GRAPHQL_WEB_PORT"] != "5200" {
		t.Fatal("Resolving aliases modified an input environment")
	}
	if _, err := config.Resolve(nil, file); err == nil {
		t.Fatal("The selected file layer must reject conflicting aliases")
	}
}

func TestServerConfigurationMatchesInfrastructureDefaults(t *testing.T) {
	loaded, err := config.Load(config.Environment{"DATABASE_URL": "postgresql://127.0.0.1/example"})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Address() != "127.0.0.1:3000" || loaded.BrowserOrigin != "http://127.0.0.1:5173" ||
		loaded.ReadinessTimeout != 2*time.Second || loaded.Database.MaxConnections != 10 ||
		loaded.Database.ConnectionTimeout != 5*time.Second || loaded.Database.QueryTimeout != time.Second {
		t.Fatalf("Unexpected infrastructure defaults: %#v", loaded)
	}
}

func TestServerConfigurationRejectsInvalidLoopbackAndTimeouts(t *testing.T) {
	for name, value := range map[string]string{
		"HOST": "0.0.0.0", "PORT": "0", "DATABASE_POOL_MAX": "0", "DATABASE_CONNECTION_TIMEOUT_MS": "0",
		"DATABASE_QUERY_TIMEOUT_MS": "2147483648", "READINESS_TIMEOUT_MS": "NaN",
		"FOREMAN_CODE_BROWSER_ORIGIN": "https://127.0.0.1:5173", "FOREMAN_CODE_LOCAL_PRODUCTION": "true",
	} {
		t.Run(name, func(t *testing.T) {
			environment := config.Environment{"DATABASE_URL": "postgresql://127.0.0.1/example", name: value}
			if _, err := config.Load(environment); err == nil {
				t.Fatalf("Expected %s to reject %q", name, value)
			}
		})
	}
}

func TestServerConfigurationPreservesAliasAndBrowserOriginBehavior(t *testing.T) {
	loaded, err := config.Load(config.Environment{
		"DATABASE_URL": "postgresql://[::1]/example", "HOST": "::1",
		"GRAPHQL_WEB_PORT": "05198", "FOREMAN_CODE_BROWSER_ORIGIN": "http://[::1]:5198/",
		"GRAPHQL_LAPTOP_EXECUTION_ENABLED": "1", "FOREMAN_CODE_LOCAL_PRODUCTION": "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Address() != "[::1]:3000" || loaded.BrowserOrigin != "http://[::1]:5198" ||
		loaded.Environment["FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED"] != "1" {
		t.Fatalf("Unexpected canonical configuration: %#v", loaded)
	}
	_, err = config.Load(config.Environment{"DATABASE_URL": "postgresql://127.0.0.1/example",
		"FOREMAN_CODE_WEB_PORT": "5198", "FOREMAN_CODE_BROWSER_ORIGIN": "http://127.0.0.1:5199"})
	if err == nil {
		t.Fatal("An explicit browser port must match its origin")
	}
}
