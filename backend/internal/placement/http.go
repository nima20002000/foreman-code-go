// Package placement owns placement discovery and accepted Run placement readback.
package placement

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

// ReadbackHTTP preserves the cache policy of the accepted-placement read route.
// The supplied handler retains responsibility for authentication, generated
// contract validation, scoped authorization and the persisted read.
func ReadbackHTTP(read httpserver.Handler) httpserver.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Vary", "Authorization, Cookie")
		return read(w, r)
	}
}

// ChoicesHTTP preserves the placement-choice read cache policy and URL scope.
// Query parameters may configure discovery, but may not repeat any URL scope
// key, including a key whose value equals the URL value or is empty.
func ChoicesHTTP(read httpserver.Handler) httpserver.Handler {
	return ReadbackHTTP(func(w http.ResponseWriter, r *http.Request) error {
		if hasChoiceScopeQuery(r.URL.RawQuery) {
			return domainerror.New("RESOURCE_ID_MISMATCH",
				"Placement choice scope must be supplied in the URL.", http.StatusBadRequest, nil)
		}
		return read(w, r)
	})
}

func hasChoiceScopeQuery(rawQuery string) bool {
	for field := range strings.SplitSeq(rawQuery, "&") {
		key, _, _ := strings.Cut(field, "=")
		decoded, err := url.QueryUnescape(key)
		if err == nil {
			key = decoded
		}
		// Inspect keys independently of values: a malformed encoded value must
		// not hide a reserved key by making net/url discard the entire pair.
		switch key {
		case "workspaceId", "workflowId", "nodeId":
			return true
		}
	}
	return false
}
