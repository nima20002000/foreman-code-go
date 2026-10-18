package activity_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/activity"
)

func TestRunHistoryCursorRetainsEscapedHighSurrogate(t *testing.T) {
	requireEscapedSurrogateHistoryCursor(t, "\\ud800")
}

func TestRunHistoryCursorRetainsEscapedLowSurrogate(t *testing.T) {
	requireEscapedSurrogateHistoryCursor(t, "\\udc00")
}

func requireEscapedSurrogateHistoryCursor(t *testing.T, escapedCodeUnit string) {
	t.Helper()
	workspace := "workspace-one"
	workflow := "workflow-one"
	admittedAt := "2026-10-17T21:53:32.123456Z"
	scopeHash := sha256.Sum256([]byte("[\"workspace-one\",\"workflow-one\"]"))
	// Frozen TS accepts these canonical JSON string escapes and reproduces the
	// same code unit. This fixture is source-derived, not an executed TS result.
	wire := "[1,\"" + hex.EncodeToString(scopeHash[:]) + "\",\"" +
		admittedAt + "\",\"run-" + escapedCodeUnit + "\"]"
	cursor := base64.RawURLEncoding.EncodeToString([]byte(wire))
	foundTime, runID, present, err := activity.DecodeRunHistoryCursor(workspace, &workflow, &cursor)
	if err != nil {
		t.Fatalf("Canonical escaped surrogate cursor was rejected: %v", err)
	}
	if !present || foundTime != admittedAt {
		t.Fatalf("Cursor position changed: timestamp %q, present %v", foundTime, present)
	}
	reencoded, err := activity.EncodeRunHistoryCursor(workspace, &workflow, foundTime, runID)
	if err != nil || reencoded != cursor {
		t.Fatalf("Cursor string identity changed: cursor %q, error %v; want %q", reencoded, err, cursor)
	}
}
