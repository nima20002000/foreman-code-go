package activity_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/activity"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

const stringIdentityTimestamp = "2026-10-17T21:53:32.123456Z"

func TestRunHistoryCursorKeepsDistinctStringIdentities(t *testing.T) {
	workflow := "workflow-one"
	scopeWire := `["workspace-one","workflow-one"]`
	seen := make(map[string]string)
	for _, example := range []struct {
		name       string
		wire       string
		plain      string
		checkPlain bool
	}{
		{name: "high surrogate", wire: `"run-\ud800"`},
		{name: "low surrogate", wire: `"run-\udc00"`},
		{name: "another high surrogate", wire: `"run-\ud801"`},
		{name: "two high surrogates", wire: `"run-\ud800\ud800"`},
		{name: "two low surrogates", wire: `"run-\udc00\udc00"`},
		{name: "low then high surrogate", wire: `"run-\udc00\ud800"`},
		{name: "paired scalar", wire: "\"run-\U00010000\"", plain: "run-\U00010000", checkPlain: true},
		{name: "scalar between lone surrogates", wire: `"run-\ud800` + "\U00010000" + `\udc00"`},
		{name: "replacement character", wire: "\"run-\ufffd\"", plain: "run-\ufffd", checkPlain: true},
		{name: "literal high surrogate escape", wire: `"run-\\ud800"`, plain: `run-\ud800`, checkPlain: true},
		{name: "literal uppercase escape", wire: `"run-\\uD800"`, plain: `run-\uD800`, checkPlain: true},
	} {
		t.Run(example.name, func(t *testing.T) {
			cursor := runHistoryCursorForStringWire(scopeWire, example.wire)
			admittedAt, runID, present, err := activity.DecodeRunHistoryCursor("workspace-one", &workflow, &cursor)
			if err != nil || !present || admittedAt != stringIdentityTimestamp {
				t.Fatalf("Canonical string cursor was rejected or moved: %q, %v, %v", admittedAt, present, err)
			}
			if previous, exists := seen[runID.IdentityKey()]; exists {
				t.Fatalf("Distinct JS strings collapsed: %q and %q", previous, example.name)
			}
			seen[runID.IdentityKey()] = example.name
			if example.checkPlain && historyUTF8(t, runID) != example.plain {
				t.Fatalf("Ordinary string identity changed: %q; want %q", runID, example.plain)
			}
			reencoded, err := activity.EncodeRunHistoryCursor("workspace-one", &workflow, admittedAt, runID)
			if err != nil || reencoded != cursor {
				t.Fatalf("Canonical string wire changed: %q, %v; want %q", reencoded, err, cursor)
			}
		})
	}
}

func TestRunHistoryCursorPreservesSurrogateScopeIdentity(t *testing.T) {
	workflow := "workflow-one"
	for _, example := range []struct {
		name string
		wire string
	}{
		{"high surrogate", `"run-\ud800"`},
		{"low surrogate", `"run-\udc00"`},
	} {
		t.Run(example.name, func(t *testing.T) {
			seed := runHistoryCursorForStringWire(`["workspace-one","workflow-one"]`, example.wire)
			_, identifier, present, err := activity.DecodeRunHistoryCursor("workspace-one", &workflow, &seed)
			if err != nil || !present {
				t.Fatalf("Read the canonical identifier: %v, %v", present, err)
			}
			workspaceText := historyUTF16(t, "workspace-one")
			workflowText := historyUTF16(t, workflow)
			for _, scope := range []struct {
				name      string
				wire      string
				workspace jsonvalue.UTF16String
				workflow  *jsonvalue.UTF16String
			}{
				{"workspace with filter", `[` + example.wire + `,"workflow-one"]`, identifier, &workflowText},
				{"workspace without filter", `[` + example.wire + `,null]`, identifier, nil},
				{"workflow filter", `["workspace-one",` + example.wire + `]`, workspaceText, &identifier},
			} {
				t.Run(scope.name, func(t *testing.T) {
					want := runHistoryCursorForStringWire(scope.wire, `"boundary-run"`)
					cursor, err := activity.EncodeRunHistoryCursor(scope.workspace, scope.workflow, stringIdentityTimestamp, "boundary-run")
					if err != nil || cursor != want {
						t.Fatalf("Scope string changed before hashing: %q, %v; want %q", cursor, err, want)
					}
					admittedAt, runID, present, err := activity.DecodeRunHistoryCursor(scope.workspace, scope.workflow, &want)
					if err != nil || !present || admittedAt != stringIdentityTimestamp || historyUTF8(t, runID) != "boundary-run" {
						t.Fatalf("Read the exact surrogate scope: %q, %q, %v, %v", admittedAt, runID, present, err)
					}
					replacement := historyUTF16(t, "run-\ufffd")
					wrongWorkspace, wrongWorkflow := scope.workspace, scope.workflow
					if scope.workspace.Equal(identifier) {
						wrongWorkspace = replacement
					} else {
						wrongWorkflow = &replacement
					}
					_, _, _, err = activity.DecodeRunHistoryCursor(wrongWorkspace, wrongWorkflow, &want)
					requireHistoryCursorError(t, err)
				})
			}
		})
	}
}

func TestRunHistoryCursorRejectsNoncanonicalSurrogateEscapes(t *testing.T) {
	workflow := "workflow-one"
	for _, example := range []struct {
		name string
		wire string
	}{
		{"uppercase high escape", `"run-\uD800"`},
		{"uppercase low escape", `"run-\uDC00"`},
		{"escaped valid pair", `"run-\ud800\udc00"`},
		{"escaped replacement scalar", `"run-\ufffd"`},
	} {
		t.Run(example.name, func(t *testing.T) {
			cursor := runHistoryCursorForStringWire(`["workspace-one","workflow-one"]`, example.wire)
			_, _, _, err := activity.DecodeRunHistoryCursor("workspace-one", &workflow, &cursor)
			requireHistoryCursorError(t, err)
		})
	}
}

// The fixed wire fixtures are derived from frozen JSON.stringify semantics.
// They are public cursor inputs, not observations from an executed TS run.
func runHistoryCursorForStringWire(scopeWire, runWire string) string {
	scopeHash := sha256.Sum256([]byte(scopeWire))
	wire := `[1,"` + hex.EncodeToString(scopeHash[:]) + `","` + stringIdentityTimestamp + `",` + runWire + `]`
	return base64.RawURLEncoding.EncodeToString([]byte(wire))
}
