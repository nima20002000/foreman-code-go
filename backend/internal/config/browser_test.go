package config_test

import (
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
)

func TestBrowserOriginUsesWHATWGLoopbackNormalization(t *testing.T) {
	// These href/hostname results were observed through new URL in Node v24.19.0.
	tests := []struct{ input, want string }{
		{"http://localhost:5173/.", "http://localhost:5173"},
		{"http://localhost:5173/a/..", "http://localhost:5173"},
		{"http://localhost:5173/%2e", "http://localhost:5173"},
		{"http://localhost:5173/a/%2E%2e", "http://localhost:5173"},
		{"http://127.1:5173", "http://127.0.0.1:5173"},
		{"http://0177.0.0.1:5173", "http://127.0.0.1:5173"},
		{"http://0x7f000001:5173", "http://127.0.0.1:5173"},
		{"http://2130706433:5173", "http://127.0.0.1:5173"},
		{"http://[0:0:0:0:0:0:0:1]:5173", "http://[::1]:5173"},
		{"http:\\\\localhost:5173", "http://localhost:5173"},
		{"http://localhost:00080?", "http://localhost"},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			loaded, err := config.Load(config.Environment{"DATABASE_URL": "postgresql://127.0.0.1/example",
				"FOREMAN_CODE_BROWSER_ORIGIN": test.input})
			if err != nil || loaded.BrowserOrigin != test.want {
				t.Fatalf("Browser origin = %q, error=%v, want %q", loaded.BrowserOrigin, err, test.want)
			}
		})
	}
}

func TestURLAliasesCompareTheirWHATWGSerializedValues(t *testing.T) {
	value, present, err := config.ReadProduct(config.Environment{
		"FOREMAN_CODE_BROWSER_ORIGIN": "http://127.1:5173/a/..",
		"GRAPHQL_BROWSER_ORIGIN":      "http://127.0.0.1:5173/",
	}, "BROWSER_ORIGIN")
	if err != nil || !present || value != "http://127.1:5173/a/.." {
		t.Fatalf("WHATWG-equivalent aliases did not retain the chosen value: value=%q, present=%v, error=%v", value, present, err)
	}
}

func TestBrowserNormalizationDoesNotPermitOtherPathsOrAddresses(t *testing.T) {
	for _, origin := range []string{
		"http://localhost:5173//", "http://localhost:5173/path", "http://localhost:5173/?query=yes",
		"http://localhost:5173/#fragment", "http://user@localhost:5173", "http://127.0.0.2:5173",
		"http://0.0.0.0:5173", "https://localhost:5173", "http://example.com:5173",
	} {
		t.Run(origin, func(t *testing.T) {
			_, err := config.Load(config.Environment{"DATABASE_URL": "postgresql://127.0.0.1/example",
				"FOREMAN_CODE_BROWSER_ORIGIN": origin})
			if err == nil {
				t.Fatalf("Unexpectedly accepted browser origin %q", origin)
			}
		})
	}
}
