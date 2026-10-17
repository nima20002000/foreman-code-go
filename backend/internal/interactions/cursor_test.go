package interactions_test

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/interactions"
)

func TestInteractionListCursorPreservesWireFormat(t *testing.T) {
	tests := []struct {
		id     string
		cursor string
	}{
		{id: "a", cursor: "aW50ZXJhY3Rpb246YQ"},
		{id: "abc", cursor: "aW50ZXJhY3Rpb246YWJj"},
		{id: "one", cursor: "aW50ZXJhY3Rpb246b25l"},
		{id: "~~~", cursor: "aW50ZXJhY3Rpb246fn5-"},
		{id: "???", cursor: "aW50ZXJhY3Rpb246Pz8_"},
	}
	for _, test := range tests {
		t.Run(test.id, func(t *testing.T) {
			if cursor := interactions.EncodeListCursor(test.id); cursor != test.cursor {
				t.Fatalf("cursor = %q; want %q", cursor, test.cursor)
			}
			id, err := interactions.DecodeListCursor(test.cursor)
			if err != nil || id != test.id {
				t.Fatalf("decoded id = %q, error = %v; want %q", id, err, test.id)
			}
		})
	}
}

func TestInteractionListCursorAcceptsFirstPage(t *testing.T) {
	id, err := interactions.DecodeListCursor("")
	if err != nil || id != "" {
		t.Fatalf("first page id = %q, error = %v; want an empty id without an error", id, err)
	}
}

func TestInteractionListCursorPreservesPrintableIdentifiers(t *testing.T) {
	identifiers := []string{
		"interaction-01:request/1?kind=read&owner=agent",
		"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
		strings.Repeat("a", 4096),
	}
	for _, expected := range identifiers {
		id, err := interactions.DecodeListCursor(interactions.EncodeListCursor(expected))
		if err != nil || id != expected {
			t.Fatalf("identifier changed on round trip: error = %v, expected length = %d, actual length = %d", err, len(expected), len(id))
		}
	}
}

func TestInteractionListCursorRejectsMalformedEncoding(t *testing.T) {
	for name, cursor := range map[string]string{
		"padding":                   "aW50ZXJhY3Rpb246YQ==",
		"noncanonical trailing bits": "aW50ZXJhY3Rpb246YR",
		"newline":                   "aW50ZXJhY3Rpb246\nYQ",
		"carriage return":           "aW50ZXJhY3Rpb246\rYQ",
		"space":                     "aW50ZXJhY3Rpb246 YQ",
		"invalid alphabet":          "aW50ZXJhY3Rpb246Y+",
		"invalid length":            "a",
	} {
		t.Run(name, func(t *testing.T) {
			assertInvalidInteractionListCursor(t, cursor)
		})
	}
}

func TestInteractionListCursorRejectsInvalidIdentity(t *testing.T) {
	for name, decoded := range map[string]string{
		"wrong prefix":        "conversation:abc",
		"prefix case":         "Interaction:abc",
		"missing prefix":      "abc",
		"empty identifier":    "interaction:",
		"leading whitespace":  "interaction: abc",
		"trailing whitespace": "interaction:abc ",
		"internal whitespace": "interaction:a b",
		"tab":                 "interaction:a\tb",
		"unicode":             "interaction:café",
		"surrogate pair":      "interaction:😀",
		"zero byte":           "interaction:a\x00b",
		"delete byte":         "interaction:a\x7fb",
		"invalid utf8":        "interaction:a\xffb",
	} {
		t.Run(name, func(t *testing.T) {
			cursor := base64.RawURLEncoding.EncodeToString([]byte(decoded))
			assertInvalidInteractionListCursor(t, cursor)
		})
	}
}

func assertInvalidInteractionListCursor(t *testing.T, cursor string) {
	t.Helper()
	id, err := interactions.DecodeListCursor(cursor)
	if err == nil {
		t.Fatalf("malformed cursor was accepted as %q", id)
	}
	if id != "" {
		t.Fatalf("malformed cursor exposed a partial identifier %q", id)
	}
	failure, ok := domainerror.As(err)
	if !ok {
		t.Fatalf("cursor failure is not a public domain error: %v", err)
	}
	if failure.Code != "INVALID_CURSOR" || failure.Status != 400 || failure.Message != "The interaction cursor is invalid." {
		t.Fatalf("cursor failure = %#v; want the existing INVALID_CURSOR envelope", failure)
	}
	if failure.Details != nil {
		t.Fatalf("cursor failure exposed details: %#v", failure.Details)
	}
}
