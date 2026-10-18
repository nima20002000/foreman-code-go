package provideraccounts_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
	"github.com/nima20002000/foreman-code-go/backend/internal/provideraccounts"
)

func TestReadStatusCodexClassification(t *testing.T) {
	for _, test := range []struct {
		name   string
		result *provideraccounts.CommandResult
		state  provideraccounts.State
	}{
		{"chatgpt", commandResult(0, "Logged in using ChatGPT"), provideraccounts.SignedIn},
		{"chatgpt-noisy", commandResult(0, "notice\nLOGGED IN USING CHATGPT\ntrailer"), provideraccounts.SignedIn},
		{"chatgpt-nonzero", commandResult(1, "Logged in using ChatGPT"), provideraccounts.Unavailable},
		{"signed-out-zero", commandResult(0, "Not logged in"), provideraccounts.SignedOut},
		{"signed-out-nonzero", commandResult(1, "  NOT LOGGED IN\r\n"), provideraccounts.SignedOut},
		{"signed-out-negative", commandResult(-1, "Not logged in"), provideraccounts.SignedOut},
		{"signed-out-noisy-prefix", commandResult(0, "notice: Not logged in"), provideraccounts.Unavailable},
		{"signed-out-noisy-suffix", commandResult(1, "Not logged in\nnotice"), provideraccounts.Unavailable},
		{"api-key", commandResult(0, "Logged in using an API key"), provideraccounts.Unavailable},
		{"empty", commandResult(0, ""), provideraccounts.Unavailable},
		{"unrecognized", commandResult(0, "status unclear; private token"), provideraccounts.Unavailable},
		{"missing-result", nil, provideraccounts.Unavailable},
		{"missing-exit", &provideraccounts.CommandResult{Stdout: "Not logged in"}, provideraccounts.Unavailable},
		{"timeout", &provideraccounts.CommandResult{Code: commandResult(0, "").Code, Stdout: "Logged in using ChatGPT", TimedOut: true}, provideraccounts.Unavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Codex, test.result)
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			if err != nil || status.State != test.state || status.Identity != nil || status.Subject != nil {
				t.Fatalf("status = %#v, error = %v, want %s with no identity or subject", status, err, test.state)
			}
			assertEvents(t, f, "select", "prepare", "current-before", "run", "close", "current-after")
		})
	}
}

func TestReadStatusCodexASCIIAndWhitespace(t *testing.T) {
	for _, test := range []struct {
		name   string
		output string
		state  provideraccounts.State
	}{
		{"dotted-I", "Logged \u0130N using ChatGPT", provideraccounts.Unavailable},
		{"long-s", "Logged in u\u017fing ChatGPT", provideraccounts.Unavailable},
		{"BOM-trims", "\ufeffNot logged in\ufeff", provideraccounts.SignedOut},
		{"NEL-does-not-trim", "\u0085Not logged in\u0085", provideraccounts.Unavailable},
		{"zero-width-space-does-not-trim", "\u200bNot logged in", provideraccounts.Unavailable},
		{"substring-precedence", "Not logged in\nLogged in using ChatGPT", provideraccounts.SignedIn},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Codex, commandResult(0, test.output))
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			if err != nil || status.State != test.state {
				t.Fatalf("status = %#v, error = %v, want %s", status, err, test.state)
			}
		})
	}
	for _, space := range []rune{'\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680,
		0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
		0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff} {
		t.Run(fmt.Sprintf("space-U%04X", space), func(t *testing.T) {
			f := fixture(provideraccounts.Codex, commandResult(1, string(space)+"Not logged in"+string(space)))
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			if err != nil || status.State != provideraccounts.SignedOut {
				t.Fatalf("JS whitespace did not surround signed-out status: %#v, %v", status, err)
			}
		})
	}
}

func TestReadStatusClaudeClassification(t *testing.T) {
	for _, test := range []struct {
		name   string
		result *provideraccounts.CommandResult
		state  provideraccounts.State
	}{
		{"subscription", commandResult(0, `{"loggedIn":true,"authMethod":"claude.ai"}`), provideraccounts.SignedIn},
		{"absent-method", commandResult(0, `{"loggedIn":true}`), provideraccounts.SignedIn},
		{"null-method", commandResult(0, `{"loggedIn":true,"authMethod":null}`), provideraccounts.SignedIn},
		{"ordinary-object-method", commandResult(0, `{"loggedIn":true,"authMethod":{"valueOf":null,"__proto__":{"toString":null}}}`), provideraccounts.SignedIn},
		{"boolean-method", commandResult(0, `{"loggedIn":true,"authMethod":true}`), provideraccounts.SignedIn},
		{"number-method", commandResult(0, `{"loggedIn":true,"authMethod":1e400}`), provideraccounts.SignedIn},
		{"empty-array-method", commandResult(0, `{"loggedIn":true,"authMethod":[]}`), provideraccounts.SignedIn},
		{"array-comma", commandResult(0, `{"loggedIn":true,"authMethod":["api_key",null]}`), provideraccounts.SignedIn},
		{"method-case-sensitive", commandResult(0, `{"loggedIn":true,"authMethod":"API_KEY"}`), provideraccounts.SignedIn},
		{"method-untrimmed", commandResult(0, `{"loggedIn":true,"authMethod":" api_key "}`), provideraccounts.SignedIn},
		{"api-key-underscore", commandResult(0, `{"loggedIn":true,"authMethod":"api_key"}`), provideraccounts.Unavailable},
		{"api-key-hyphen", commandResult(0, `{"loggedIn":true,"authMethod":"api-key"}`), provideraccounts.Unavailable},
		{"api-key-array", commandResult(0, `{"loggedIn":true,"authMethod":["api_key"]}`), provideraccounts.Unavailable},
		{"api-key-nested-array", commandResult(0, `{"loggedIn":true,"authMethod":[[["api-key"]]]}`), provideraccounts.Unavailable},
		{"signed-out", commandResult(0, `{"loggedIn":false}`), provideraccounts.SignedOut},
		{"signed-out-before-method", commandResult(0, `{"loggedIn":false,"authMethod":["already-mismatched",{"toString":null}],"email":"private@example.test"}`), provideraccounts.SignedOut},
		{"duplicate-last-value", commandResult(0, `{"loggedIn":false,"loggedIn":true}`), provideraccounts.SignedIn},
		{"false-nonzero", commandResult(1, `{"loggedIn":false}`), provideraccounts.Unavailable},
		{"true-nonzero", commandResult(1, `{"loggedIn":true}`), provideraccounts.Unavailable},
		{"malformed", commandResult(0, `{"loggedIn":true`), provideraccounts.Unavailable},
		{"trailing-output", commandResult(0, `{"loggedIn":true} private diagnostic`), provideraccounts.Unavailable},
		{"null", commandResult(0, `null`), provideraccounts.Unavailable},
		{"array-root", commandResult(0, `[{"loggedIn":true}]`), provideraccounts.Unavailable},
		{"string-root", commandResult(0, `"private native text"`), provideraccounts.Unavailable},
		{"number-root", commandResult(0, `1`), provideraccounts.Unavailable},
		{"boolean-root", commandResult(0, `true`), provideraccounts.Unavailable},
		{"absent-logged-in", commandResult(0, `{}`), provideraccounts.Unavailable},
		{"string-logged-in", commandResult(0, `{"loggedIn":"true"}`), provideraccounts.Unavailable},
		{"array-logged-in", commandResult(0, `{"loggedIn":[]}`), provideraccounts.Unavailable},
		{"object-logged-in", commandResult(0, `{"loggedIn":{}}`), provideraccounts.Unavailable},
		{"number-logged-in", commandResult(0, `{"loggedIn":1}`), provideraccounts.Unavailable},
		{"null-logged-in", commandResult(0, `{"loggedIn":null}`), provideraccounts.Unavailable},
		{"missing-result", nil, provideraccounts.Unavailable},
		{"missing-exit", &provideraccounts.CommandResult{Stdout: `{"loggedIn":true}`}, provideraccounts.Unavailable},
		{"timeout", &provideraccounts.CommandResult{Code: commandResult(0, "").Code, Stdout: `{"loggedIn":true}`, TimedOut: true}, provideraccounts.Unavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Claude, test.result)
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			if err != nil || status.State != test.state || status.Identity != nil || status.Subject != nil {
				t.Fatalf("status = %#v, error = %v, want %s with no identity or subject", status, err, test.state)
			}
			assertEvents(t, f, "select", "prepare", "current-before", "run", "close", "current-after")
		})
	}
}

func TestReadStatusClaudeAuthMethodConversion(t *testing.T) {
	for _, method := range []string{
		`{"toString":null}`,
		`{"toString":"api_key"}`,
		`{"toString":false,"valueOf":0}`,
		`{"toString":[]}`,
		`[{"toString":{}}]`,
		`[[[{"toString":null}]]]`,
		`["already-mismatched",{"toString":null}]`,
		`["api_key",null,[{"toString":null}]]`,
	} {
		t.Run(method, func(t *testing.T) {
			var previous error
			for range 2 {
				f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"authMethod":`+method+`,"privateToken":"never expose"}`))
				status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
				if err == nil || err.Error() != "Cannot convert object to primitive value" {
					t.Fatalf("conversion error = %v", err)
				}
				var conversion *provideraccounts.AuthMethodConversionError
				if !errors.As(err, &conversion) || err == previous {
					t.Fatal("conversion must return a fresh ordinary typed error")
				}
				assertUnavailable(t, status, err, err)
				assertEvents(t, f, "select", "prepare", "current-before", "run", "close", "current-after")
				previous = err
			}
		})
	}
}

func TestReadStatusClaudeIdentity(t *testing.T) {
	for _, test := range []struct {
		name  string
		email string
		valid bool
	}{
		{"ordinary", "user@example.test", true},
		{"untrimmed-leading", " user@example.test", false},
		{"untrimmed-trailing", "user@example.test ", false},
		{"permissive-dots", "a@...", true},
		{"permissive-trailing-dot", "a@b.c.", true},
		{"two-at-signs", "a@b@c.d", false},
		{"missing-local", "@b.c", false},
		{"missing-dot-left", "a@.c", false},
		{"missing-dot-right", "a@b.", false},
		{"no-domain-dot", "a@bc", false},
		{"empty", "", false},
		{"C0", "a\x00@b.c", false},
		{"DEL", "a\x7f@b.c", false},
		{"NEL-is-not-JS-whitespace", "a\u0085@b.c", true},
		{"BOM-is-JS-whitespace", "a\ufeff@b.c", false},
		{"zero-width-space", "a\u200b@b.c", true},
		{"200-units", strings.Repeat("a", 196) + "@b.c", true},
		{"201-units", strings.Repeat("a", 197) + "@b.c", false},
		{"200-units-astral", strings.Repeat("\U0001f600", 98) + "@b.c", true},
		{"202-units-astral", strings.Repeat("\U0001f600", 99) + "@b.c", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			email, marshalErr := json.Marshal(test.email)
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"email":`+string(email)+`}`))
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			if err != nil || status.State != provideraccounts.SignedIn || status.Subject != nil {
				t.Fatalf("status = %#v, error = %v", status, err)
			}
			want, conversionErr := jsonvalue.FromUTF8(test.email)
			if conversionErr != nil {
				t.Fatal(conversionErr)
			}
			if test.valid && !status.Identity.Equal(want) || !test.valid && status.Identity != nil {
				t.Fatalf("identity units = %v, accepted = %v", status.Identity, test.valid)
			}
		})
	}
	for _, emailJSON := range []string{`null`, `1`, `false`, `[]`, `{}`} {
		f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"email":`+emailJSON+`}`))
		status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
		if err != nil || status.State != provideraccounts.SignedIn || status.Identity != nil {
			t.Fatalf("non-string email became an identity: %#v, %v", status, err)
		}
	}
	f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"email":"old@example.test","email":"\ud800@b.c"}`))
	status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
	if err != nil || !status.Identity.Equal(jsonvalue.UTF16String{0xd800, '@', 'b', '.', 'c'}) {
		t.Fatalf("duplicate-last identity lost native UTF-16 units: %v, %v", status.Identity, err)
	}
}

func TestReadStatusClaudeQualifiedSubject(t *testing.T) {
	for _, field := range []string{"subject", "accountId", "userId"} {
		t.Run(field, func(t *testing.T) {
			output := `{"loggedIn":true,"email":"display@example.test","subject":"subject-value","accountId":"account-value","userId":"user-value"}`
			f := fixture(provideraccounts.Claude, commandResult(0, output))
			f.selection.SubjectField = field
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			want := map[string]string{"subject": "subject-value", "accountId": "account-value", "userId": "user-value"}[field]
			units, conversionErr := jsonvalue.FromUTF8(want)
			if conversionErr != nil {
				t.Fatal(conversionErr)
			}
			if err != nil || status.State != provideraccounts.SignedIn || status.Subject != f.subject ||
				!f.subjectInput.Equal(units) || f.qualificationID != f.selection.QualificationID {
				t.Fatalf("qualified subject was not carried through the typed adapter: %#v, %v", status, err)
			}
			assertEvents(t, f, "select", "prepare", "current-before", "run", "close", "current-after", "subject")
		})
	}
	for _, test := range []struct {
		name     string
		field    string
		output   string
		accepted bool
		called   bool
	}{
		{"no-qualified-field", "", `{"loggedIn":true,"subject":"not-selected"}`, true, false},
		{"missing-no-fallback", "userId", `{"loggedIn":true,"subject":"not-selected","email":"display@example.test"}`, true, false},
		{"number", "subject", `{"loggedIn":true,"subject":12}`, true, false},
		{"C0", "subject", `{"loggedIn":true,"subject":"a\u001fb"}`, true, false},
		{"DEL", "subject", `{"loggedIn":true,"subject":"a\u007fb"}`, true, false},
		{"adapter-rejection", "subject", `{"loggedIn":true,"subject":"unaccepted"}`, false, true},
		{"empty-delegates", "subject", `{"loggedIn":true,"subject":""}`, false, true},
		{"over-200-delegates", "subject", `{"loggedIn":true,"subject":"` + strings.Repeat("a", 201) + `"}`, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Claude, commandResult(0, test.output))
			f.selection.SubjectField, f.subjectAccepted = test.field, test.accepted
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			if err != nil || status.State != provideraccounts.SignedIn || status.Subject != nil {
				t.Fatalf("unexpected qualified subject: %#v, %v", status, err)
			}
			wantEvents := []string{"select", "prepare", "current-before", "run", "close", "current-after"}
			if test.called {
				wantEvents = append(wantEvents, "subject")
			}
			assertEvents(t, f, wantEvents...)
		})
	}
	f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"subject":" \ud800\u0085 "}`))
	f.selection.SubjectField = "subject"
	status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
	if err != nil || status.Subject != f.subject || !f.subjectInput.Equal(jsonvalue.UTF16String{' ', 0xd800, 0x85, ' '}) {
		t.Fatalf("reader pre-normalized or rejected the schema adapter's candidate: %v, %v", f.subjectInput, err)
	}
}

func TestReadStatusClaudeSubjectAdapterRequired(t *testing.T) {
	f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"subject":"qualified-candidate","email":"display@example.test"}`))
	f.selection.SubjectField = "subject"
	ports := f.ports()
	ports.DecodeSubject = nil
	status, err := provideraccounts.ReadStatus(context.Background(), ports)
	if err == nil || err.Error() != "native account subject decoder is required for a qualified subject candidate" {
		t.Fatalf("missing required schema adapter was hidden: %v", err)
	}
	assertUnavailable(t, status, err, err)
	assertEvents(t, f, "select", "prepare", "current-before", "run", "close", "current-after")
}
