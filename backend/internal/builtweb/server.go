// Package builtweb serves the compiled shell on the API origin.
package builtweb

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

// New validates the configured build and returns a fallback handler for unregistered routes.
// Files are opened per request; startup does not discover the build directory tree.
func New(root string) (httpserver.Handler, error) {
	if !filepath.IsAbs(root) {
		return nil, &relativeRootError{message: "FOREMAN_CODE_WEB_DIST requires an absolute directory."}
	}
	if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
		return nil, err
	}
	return server{root: root}.serve, nil
}

// The public configuration message keeps its frozen punctuation and each call
// returns a distinct error, just as the reference's new Error does.
type relativeRootError struct {
	message string
}

func (err *relativeRootError) Error() string { return err.message }

type server struct {
	root string
}

func (s server) serve(w http.ResponseWriter, request *http.Request) (result error) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return notFound()
	}
	name := strings.TrimPrefix(request.URL.Path, "/")
	if shellRoute(request.URL.Path) {
		name = "index.html"
	}
	if !assetPath(name) {
		return notFound()
	}
	path := filepath.Join(s.root, filepath.FromSlash(name))
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
			return notFound()
		}
		return err
	}
	defer func() { result = errors.Join(result, file.Close()) }()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() {
		return notFound()
	}
	cache := "no-cache"
	if strings.Contains(path, string(filepath.Separator)+"assets"+string(filepath.Separator)) {
		cache = "public, max-age=31536000, immutable"
	}
	w.Header().Set("Cache-Control", cache)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("ETag", fmt.Sprintf("W/\"%x-%x\"", info.Size(), info.ModTime().UnixMilli()))
	http.ServeContent(w, request, info.Name(), info.ModTime(), file)
	return nil
}

func shellRoute(path string) bool {
	switch path {
	case "/", "/workspaces", "/settings", "/account", "/terminal", "/approvals":
		return true
	default:
		return strings.HasPrefix(path, "/workspaces/") || strings.HasPrefix(path, "/settings/")
	}
}

func assetPath(name string) bool {
	if !fs.ValidPath(name) || strings.ContainsAny(name, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		// The TypeScript static server ignores dotfiles and never lists directories.
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	return true
}

func notFound() error {
	return domainerror.New("NOT_FOUND", "The requested API route was not found.", http.StatusNotFound, nil)
}
