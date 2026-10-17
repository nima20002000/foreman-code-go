package config_test

import (
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
)

func TestConfigurationValidationPreservesPublicDiagnostics(t *testing.T) {
	tests := []struct {
		name        string
		environment config.Environment
		setting     string
		message     string
	}{
		{
			name: "loopback host", environment: config.Environment{"HOST": "0.0.0.0"}, setting: "HOST",
			message: "The local app requires a loopback HOST: 127.0.0.1, ::1 or localhost.",
		},
		{
			name: "integer range", environment: config.Environment{"PORT": "0"}, setting: "PORT",
			message: "PORT must be a positive integer at most 65535.",
		},
		{
			name: "database URL", environment: config.Environment{"DATABASE_URL": "invalid"}, setting: "DATABASE_URL",
			message: "DATABASE_URL must be a postgresql:// URL.",
		},
		{
			name: "local production flag", environment: config.Environment{"FOREMAN_CODE_LOCAL_PRODUCTION": "true"},
			setting: "FOREMAN_CODE_LOCAL_PRODUCTION", message: "FOREMAN_CODE_LOCAL_PRODUCTION must be 0 or 1.",
		},
		{
			name: "local production database",
			environment: config.Environment{"FOREMAN_CODE_LOCAL_PRODUCTION": "1", "DATABASE_URL": "postgresql://example.test/fixture"},
			setting: "DATABASE_URL", message: "Local production requires a loopback API and database.",
		},
		{
			name: "browser port", environment: config.Environment{"FOREMAN_CODE_WEB_PORT": "0"},
			setting: "FOREMAN_CODE_WEB_PORT", message: "FOREMAN_CODE_WEB_PORT must be a valid TCP port.",
		},
		{
			name: "legacy browser origin", environment: config.Environment{"FOREMAN_CODE_DEV_BROWSER_ORIGIN": "http://localhost"},
			setting: "FOREMAN_CODE_DEV_BROWSER_ORIGIN",
			message: "FOREMAN_CODE_DEV_BROWSER_ORIGIN must be one exact HTTP loopback browser origin, including its port.",
		},
		{
			name: "browser origin", environment: config.Environment{"FOREMAN_CODE_BROWSER_ORIGIN": "http://localhost:5173/path"},
			setting: "FOREMAN_CODE_BROWSER_ORIGIN", message: "FOREMAN_CODE_BROWSER_ORIGIN must be an exact HTTP loopback browser origin.",
		},
		{
			name: "conflicting browser origins",
			environment: config.Environment{"FOREMAN_CODE_DEV_BROWSER_ORIGIN": "http://localhost:5174", "FOREMAN_CODE_BROWSER_ORIGIN": "http://localhost:5173"},
			setting: "FOREMAN_CODE_DEV_BROWSER_ORIGIN", message: "FOREMAN_CODE_DEV_BROWSER_ORIGIN conflicts with FOREMAN_CODE_BROWSER_ORIGIN.",
		},
		{
			name: "conflicting browser port",
			environment: config.Environment{"FOREMAN_CODE_WEB_PORT": "5174", "FOREMAN_CODE_BROWSER_ORIGIN": "http://localhost:5173"},
			setting: "FOREMAN_CODE_WEB_PORT", message: "FOREMAN_CODE_WEB_PORT conflicts with FOREMAN_CODE_BROWSER_ORIGIN.",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			environment := config.Environment{"DATABASE_URL": "postgresql://127.0.0.1/fixture"}
			for name, value := range test.environment {
				environment[name] = value
			}
			_, err := config.Load(environment)
			var invalid *config.ValidationError
			if !errors.As(err, &invalid) || invalid.Setting != test.setting {
				t.Fatalf("Expected a validation error for %s, got %v", test.setting, err)
			}
			if err.Error() != test.message {
				t.Fatalf("Public configuration diagnostic = %q, want %q", err.Error(), test.message)
			}
		})
	}
}
