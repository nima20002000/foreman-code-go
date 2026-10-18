package builtweb_test

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/builtweb"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

const compiledShell = "<!doctype html><title>Foreman Code</title><div id=\"root\"></div>"

func webFixture(t *testing.T) (string, http.Handler) {
	t.Helper()
	root := t.TempDir()
	writeWebFile(t, root, "index.html", compiledShell)
	writeWebFile(t, root, "assets/app-123.js", "console.log(\"compiled\")")
	writeWebFile(t, root, "graphql.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
	handler, err := builtweb.New(root)
	if err != nil {
		t.Fatal(err)
	}
	return root, httpserver.WithRequestID((httpserver.ErrorHandler{}).Wrap(handler))
}

func writeWebFile(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func requestWeb(handler http.Handler, method, path string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(method, path, nil))
	return response
}

func TestBuiltWebShellRoutes(t *testing.T) {
	_, handler := webFixture(t)
	for _, path := range []string{
		"/", "/workspaces", "/workspaces/", "/workspaces/workspace-1/workflows",
		"/workspaces/workspace-1/jobs", "/settings", "/settings/harnesses",
		"/account", "/terminal", "/approvals",
	} {
		t.Run(path, func(t *testing.T) {
			response := requestWeb(handler, http.MethodGet, path)
			if response.Code != http.StatusOK || response.Body.String() != compiledShell {
				t.Fatalf("shell response = %d %q", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Header().Get("Content-Type"), "text/html") {
				t.Fatalf("shell content type = %q", response.Header().Get("Content-Type"))
			}
			if response.Header().Get("Cache-Control") != "no-cache" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("shell caching/content headers = %v", response.Header())
			}
		})
	}
}

func TestBuiltWebAssetsAndConditionalReads(t *testing.T) {
	_, handler := webFixture(t)
	asset := requestWeb(handler, http.MethodGet, "/assets/app-123.js")
	if asset.Code != http.StatusOK || !strings.Contains(asset.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("asset response = %d %v", asset.Code, asset.Header())
	}
	if asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || asset.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("asset caching/content headers = %v", asset.Header())
	}
	icon := requestWeb(handler, http.MethodGet, "/graphql.svg")
	if icon.Code != http.StatusOK || !strings.Contains(icon.Header().Get("Content-Type"), "image/svg+xml") || icon.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("icon response = %d %v", icon.Code, icon.Header())
	}
	head := requestWeb(handler, http.MethodHead, "/assets/app-123.js")
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != asset.Header().Get("Content-Length") {
		t.Fatalf("HEAD response = %d %v %q", head.Code, head.Header(), head.Body.String())
	}
	conditional := httptest.NewRequest(http.MethodGet, "/assets/app-123.js", nil)
	conditional.Header.Set("If-None-Match", asset.Header().Get("ETag"))
	revalidated := httptest.NewRecorder()
	handler.ServeHTTP(revalidated, conditional)
	if revalidated.Code != http.StatusNotModified || revalidated.Body.Len() != 0 {
		t.Fatalf("conditional response = %d %q", revalidated.Code, revalidated.Body.String())
	}
}

func TestBuiltWebMissingPathsStayJSONErrors(t *testing.T) {
	_, handler := webFixture(t)
	for _, path := range []string{
		"/api/missing", "/mcp", "/health/missing", "/sign-in", "/setup",
		"/assets/missing.js", "/assets", "/assets/", "/assets/%2e%2e/%2e%2e/package.json",
	} {
		t.Run(path, func(t *testing.T) {
			response := requestWeb(handler, http.MethodGet, path)
			var body struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if response.Code != http.StatusNotFound || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Error.Code != "NOT_FOUND" {
				t.Fatalf("missing path response = %d %q", response.Code, response.Body.String())
			}
		})
	}
	if response := requestWeb(handler, http.MethodPost, "/workspaces"); response.Code != http.StatusNotFound {
		t.Fatalf("POST shell response = %d", response.Code)
	}
}

func TestBuiltWebReadsNewFilesAfterStartup(t *testing.T) {
	root, handler := webFixture(t)
	writeWebFile(t, root, "assets/later.js", "console.log(\"later\")")
	response := requestWeb(handler, http.MethodGet, "/assets/later.js")
	if response.Code != http.StatusOK || response.Body.String() != "console.log(\"later\")" {
		t.Fatalf("new build asset = %d %q", response.Code, response.Body.String())
	}
	writeWebFile(t, root, "index.html", "<!doctype html><title>Updated shell</title>")
	response = requestWeb(handler, http.MethodGet, "/")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Updated shell") {
		t.Fatalf("updated shell = %d %q", response.Code, response.Body.String())
	}
}

func TestBuiltWebRequiresAnAbsolutePresentBuild(t *testing.T) {
	if _, err := builtweb.New("dist"); err == nil || !strings.Contains(err.Error(), "absolute directory") {
		t.Fatalf("relative directory error = %v", err)
	}
	if _, err := builtweb.New(t.TempDir()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing build error = %v", err)
	}
}

func TestBuiltWebRelativeDirectoryRetainsPublicError(t *testing.T) {
	handler, first := builtweb.New("dist")
	if handler != nil || first == nil || first.Error() != "FOREMAN_CODE_WEB_DIST requires an absolute directory." {
		t.Fatalf("relative directory returned handler=%v error=%v", handler != nil, first)
	}
	_, second := builtweb.New("dist")
	if second == nil || second.Error() != first.Error() || errors.Is(first, second) {
		t.Fatalf("separate invalid configurations returned errors %v and %v", first, second)
	}
}
