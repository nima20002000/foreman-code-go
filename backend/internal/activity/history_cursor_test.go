package activity_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/activity"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

func TestRunHistoryCursorPreservesMicroseconds(t *testing.T) {
	workflow := "workflow-one"
	for _, admittedAt := range []string{
		"2026-10-17T21:53:32.000000Z",
		"2026-10-17T21:53:32.000001Z",
		"2026-10-17T21:53:32.000999Z",
		"2026-10-17T21:53:32.123456Z",
		"2000-02-29T23:59:59.999999Z",
		"0001-01-01T00:00:00.000001Z",
	} {
		t.Run(admittedAt, func(t *testing.T) {
			value, err := activity.EncodeRunHistoryCursor("workspace-one", &workflow, admittedAt, "run-z")
			if err != nil {
				t.Fatalf("Encode a valid history position: %v", err)
			}
			foundTime, foundRun, present, err := activity.DecodeRunHistoryCursor("workspace-one", &workflow, &value)
			if err != nil || !present || foundTime != admittedAt || historyUTF8(t, foundRun) != "run-z" {
				t.Fatalf("History position changed: %q, %q, %v, %v", foundTime, foundRun, present, err)
			}
		})
	}
}

func TestRunHistoryCursorMatchesFrozenArrayEncoding(t *testing.T) {
	workspace := "workspace<\u2028literal\\u2028"
	workflow := "workflow&>\u2029"
	admittedAt := "2026-10-17T21:53:32.123456Z"
	runID := "run<\u2028literal\\u2029&>"
	// These are the frozen JSON.stringify wire values, including literal line
	// separators and an escaped backslash. They are not executed TS observations.
	scopeWire := "[\"workspace<\u2028literal\\\\u2028\",\"workflow&>\u2029\"]"
	scopeHash := sha256.Sum256([]byte(scopeWire))
	wantWire := "[1,\"" + hex.EncodeToString(scopeHash[:]) +
		"\",\"2026-10-17T21:53:32.123456Z\",\"run<\u2028literal\\\\u2029&>\"]"
	want := base64.RawURLEncoding.EncodeToString([]byte(wantWire))
	value, err := activity.EncodeRunHistoryCursor(workspace, &workflow, admittedAt, runID)
	if err != nil || value != want {
		t.Fatalf("History wire cursor = %q, error %v; want %q", value, err, want)
	}
	foundTime, foundRun, present, err := activity.DecodeRunHistoryCursor(workspace, &workflow, &want)
	if err != nil || !present || foundTime != admittedAt || historyUTF8(t, foundRun) != runID {
		t.Fatalf("Read the frozen wire position: %q, %q, %v, %v", foundTime, foundRun, present, err)
	}
}

func TestRunHistoryCursorBindsTheExactWorkflowFilter(t *testing.T) {
	workflow := "workflow-one"
	empty := ""
	otherWorkflow := "workflow-two"
	admittedAt := "2026-10-17T21:53:32.123456Z"
	value, err := activity.EncodeRunHistoryCursor("workspace-one", &workflow, admittedAt, "run-one")
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range []struct {
		name      string
		workspace string
		workflow  *string
	}{
		{"other workspace", "workspace-two", &workflow},
		{"other workflow", "workspace-one", &otherWorkflow},
		{"absent workflow", "workspace-one", nil},
		{"empty workflow", "workspace-one", &empty},
	} {
		t.Run(scope.name, func(t *testing.T) {
			_, _, _, err := activity.DecodeRunHistoryCursor(scope.workspace, scope.workflow, &value)
			requireHistoryCursorError(t, err)
		})
	}
	unfiltered, err := activity.EncodeRunHistoryCursor("workspace-one", nil, admittedAt, "run-one")
	if err != nil {
		t.Fatal(err)
	}
	_, _, present, err := activity.DecodeRunHistoryCursor("workspace-one", nil, &unfiltered)
	if err != nil || !present {
		t.Fatalf("Read the absent-filter cursor: %v, %v", present, err)
	}
	_, _, _, err = activity.DecodeRunHistoryCursor("workspace-one", &empty, &unfiltered)
	requireHistoryCursorError(t, err)
}

func TestRunHistoryFirstPageIsDistinctFromAnEmptyCursor(t *testing.T) {
	admittedAt, runID, present, err := activity.DecodeRunHistoryCursor("workspace", nil, nil)
	if err != nil || present || admittedAt != "" || historyUTF8(t, runID) != "" {
		t.Fatalf("First page returned a position: %q, %q, %v, %v", admittedAt, runID, present, err)
	}
	empty := ""
	_, _, _, err = activity.DecodeRunHistoryCursor("workspace", nil, &empty)
	requireHistoryCursorError(t, err)
}

func TestRunHistoryCursorRejectsNoncanonicalAndMalformedPositions(t *testing.T) {
	workflow := "workflow"
	value, err := activity.EncodeRunHistoryCursor("workspace", &workflow, "2026-10-17T21:53:32.123456Z", "run-one")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	noncanonical := []string{
		" " + string(payload),
		strings.Replace(string(payload), "[1,", "[1.0,", 1),
		strings.Replace(string(payload), "run-one", "\\u0072un-one", 1),
		strings.Replace(string(payload), "[1,", "[2,", 1),
		strings.Replace(string(payload), ".123456Z", ".123Z", 1),
		strings.TrimSuffix(string(payload), "]") + ",null]",
		"null",
		"{}",
		"[]",
		"[1,true,123,123]",
	}
	for index, raw := range noncanonical {
		t.Run(fmt.Sprintf("payload %d", index), func(t *testing.T) {
			cursor := base64.RawURLEncoding.EncodeToString([]byte(raw))
			_, _, _, err := activity.DecodeRunHistoryCursor("workspace", &workflow, &cursor)
			requireHistoryCursorError(t, err)
		})
	}
	for index, cursor := range []string{
		value + "=", value + "\n", "+" + value, "/" + value, "a", strings.Repeat("a", 16_385),
	} {
		t.Run(fmt.Sprintf("encoding %d", index), func(t *testing.T) {
			_, _, _, err := activity.DecodeRunHistoryCursor("workspace", &workflow, &cursor)
			requireHistoryCursorError(t, err)
		})
	}
}

func TestRunHistoryCursorRejectsInvalidCalendarPositions(t *testing.T) {
	for _, admittedAt := range []string{
		"0000-01-01T00:00:00.000000Z",
		"1900-02-29T00:00:00.000000Z",
		"2026-02-29T00:00:00.000000Z",
		"2026-04-31T00:00:00.000000Z",
		"2026-10-17T24:00:00.000000Z",
		"2026-10-17T23:59:60.000000Z",
		"2026-10-17T21:53:32.123Z",
		"2026-10-17T21:53:32.1234567Z",
		"2026-10-17T21:53:32,123456Z",
		"2026-10-17T21:53:32.123456+00:00",
	} {
		t.Run(admittedAt, func(t *testing.T) {
			_, err := activity.EncodeRunHistoryCursor("workspace", nil, admittedAt, "run-one")
			requireHistoryCursorError(t, err)
		})
	}
}

func TestRunHistoryCursorRetainsTheFrozenRunIDRules(t *testing.T) {
	admittedAt := "2026-10-17T21:53:32.123456Z"
	for index, runID := range []string{
		"", " run", "run ", "\ufeffrun", "run\u2028", "\u00a0run", "run\x00suffix", strings.Repeat("r", 20_000),
	} {
		t.Run(fmt.Sprintf("invalid %d", index), func(t *testing.T) {
			_, err := activity.EncodeRunHistoryCursor("workspace", nil, admittedAt, runID)
			requireHistoryCursorError(t, err)
		})
	}
	// ECMAScript trim does not treat NEL as whitespace. Embedded whitespace and
	// BOM are preserved; only the frozen leading/trailing trim rule applies.
	for index, runID := range []string{"\u0085run\u0085", "run name", "run\ufeffname", "run\u180ename"} {
		t.Run(fmt.Sprintf("valid %d", index), func(t *testing.T) {
			value, err := activity.EncodeRunHistoryCursor("workspace", nil, admittedAt, runID)
			if err != nil {
				t.Fatalf("Valid frozen Run ID rejected: %v", err)
			}
			_, found, present, err := activity.DecodeRunHistoryCursor("workspace", nil, &value)
			if err != nil || !present || historyUTF8(t, found) != runID {
				t.Fatalf("Run ID changed: %q, %v, %v", found, present, err)
			}
		})
	}
}

func requireHistoryCursorError(t *testing.T, err error) {
	t.Helper()
	found, ok := domainerror.As(err)
	if !ok || found.Code != "RUN_HISTORY_CURSOR_INVALID" || found.Status != 400 ||
		found.Message != "Use a Run history cursor from the same workspace and workflow filter." {
		t.Fatalf("Wrong public history failure: %#v", err)
	}
}

func historyUTF8(t *testing.T, value jsonvalue.UTF16String) string {
	t.Helper()
	text, err := value.UTF8()
	if err != nil {
		t.Fatalf("Expected exact UTF-8 text, got UTF-16 units %x: %v", value, err)
	}
	return text
}

func historyUTF16(t *testing.T, value string) jsonvalue.UTF16String {
	t.Helper()
	units, err := jsonvalue.FromUTF8(value)
	if err != nil {
		t.Fatalf("Construct shared UTF-16 text: %v", err)
	}
	return units
}
