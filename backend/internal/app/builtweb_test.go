package app_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/config"
	"github.com/nima20002000/foreman-code-go/backend/internal/health"
)

func compiledWebRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<!doctype html><title>Foreman Code</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func appWebRequest(t *testing.T, application *app.App, path string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	return response
}

func TestBuiltWebConfigLoadsCompiledShell(t *testing.T) {
	application, err := app.New(app.Options{Config: config.Config{Environment: config.Environment{
		"FOREMAN_CODE_WEB_DIST": compiledWebRoot(t),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	response := appWebRequest(t, application, "/workspaces/workspace-1/workflows")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "<title>Foreman Code</title>") {
		t.Fatalf("configured shell = %d %q", response.Code, response.Body.String())
	}
}

func TestBuiltWebConfigPreservesRegisteredAPIAndMCPErrors(t *testing.T) {
	application, err := app.New(app.Options{Config: config.Config{Environment: config.Environment{
		"FOREMAN_CODE_WEB_DIST": compiledWebRoot(t),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	health.Register(application)
	response := appWebRequest(t, application, "/health/live")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"ok"`) {
		t.Fatalf("health route = %d %q", response.Code, response.Body.String())
	}
	for _, test := range []struct {
		path   string
		status int
		code   string
	}{
		{path: "/api/missing", status: http.StatusNotFound, code: "NOT_FOUND"},
		{path: "/health/missing", status: http.StatusNotFound, code: "NOT_FOUND"},
		{path: "/mcp/missing", status: http.StatusNotFound, code: "NOT_FOUND"},
		{path: "/mcp", status: http.StatusUnauthorized, code: "AUTH_REQUIRED"},
	} {
		t.Run(test.path, func(t *testing.T) {
			response := appWebRequest(t, application, test.path)
			var body struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if response.Code != test.status || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Error.Code != test.code {
				t.Fatalf("transport response = %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestBuiltWebConfigLeavesServingDisabled(t *testing.T) {
	application, err := app.New(app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if response := appWebRequest(t, application, "/"); response.Code != http.StatusNotFound {
		t.Fatalf("unconfigured shell status = %d", response.Code)
	}
}

func TestBuiltWebConfigRejectsMissingBuild(t *testing.T) {
	for _, root := range []string{"dist", t.TempDir()} {
		if _, err := app.New(app.Options{Config: config.Config{Environment: config.Environment{
			"FOREMAN_CODE_WEB_DIST": root,
		}}}); err == nil {
			t.Fatal("configured absent/relative web build was accepted")
		}
	}
}
