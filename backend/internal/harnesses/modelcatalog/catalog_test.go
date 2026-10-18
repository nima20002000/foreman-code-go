package modelcatalog_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/modelcatalog"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

func successfulCommand(stdout string) modelcatalog.CommandResult {
	code := 0
	return modelcatalog.CommandResult{ExitCode: &code, Stdout: stdout}
}

func decodeValue(t *testing.T, raw string) any {
	t.Helper()
	value, err := jsonvalue.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func nativeField(t *testing.T, object jsonvalue.Object, name string) any {
	t.Helper()
	key, err := jsonvalue.FromUTF8(name)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range object {
		if member.Key.Equal(key) {
			return member.Value
		}
	}
	return nil
}

func requireCatalogError(t *testing.T, err error, code, message string, retryable bool) *modelcatalog.Error {
	t.Helper()
	var native *modelcatalog.Error
	if !errors.As(err, &native) || native.FailureCode() != code || native.Error() != message || native.Retryable != retryable {
		t.Fatalf("wrong native diagnostic: error=%v native=%+v, want %s / %q / retryable=%t", err, native, code, message, retryable)
	}
	return native
}

func TestParseCodexPreservesNativeMetadata(t *testing.T) {
	cases := map[string]string{
		"unknown fields": `{"release":{"epoch":123},"models":[{"slug":"native-id","display_name":"Native","supported_reasoning_levels":[{"effort":"high","detail":true}],"additional_speed_tiers":["fast","fast",""],"future":{"value":null}}]}`,
		"empty and whitespace values": `{"models":[{"slug":" ","supported_reasoning_levels":[{"effort":" "},{"effort":" "}]},{"slug":"empty-levels","supported_reasoning_levels":[]}]}`,
		"lossless identities": `{"\ud800":{"unpaired":"\udfff"},"\ufffd":2,"models":[{"slug":"\ud800","supported_reasoning_levels":[]},{"slug":"\ufffd","supported_reasoning_levels":[]}]}`,
		"last duplicate property": `{"models":false,"models":[],"future":1,"future":2}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			catalog, err := modelcatalog.ParseCodex(successfulCommand(raw))
			if err != nil || !reflect.DeepEqual(catalog, decodeValue(t, raw)) {
				t.Fatalf("native metadata changed: catalog=%v error=%v", catalog, err)
			}
		})
	}
}

func TestParseCodexRejectsInvalidCatalogs(t *testing.T) {
	cases := map[string]string{
		"root null": "null", "root array": "[]", "missing models": "{}",
		"null models": `{"models":null}`, "object models": `{"models":{}}`,
		"null model": `{"models":[null]}`, "string model": `{"models":["model"]}`,
		"missing slug": `{"models":[{"supported_reasoning_levels":[]}]}`,
		"empty slug": `{"models":[{"slug":"","supported_reasoning_levels":[]}]}`,
		"number slug": `{"models":[{"slug":1,"supported_reasoning_levels":[]}]}`,
		"duplicate slug": `{"models":[{"slug":"a","supported_reasoning_levels":[]},{"slug":"\u0061","supported_reasoning_levels":[]}]}`,
		"missing levels": `{"models":[{"slug":"a"}]}`,
		"null levels": `{"models":[{"slug":"a","supported_reasoning_levels":null}]}`,
		"string level": `{"models":[{"slug":"a","supported_reasoning_levels":["high"]}]}`,
		"missing effort": `{"models":[{"slug":"a","supported_reasoning_levels":[{}]}]}`,
		"empty effort": `{"models":[{"slug":"a","supported_reasoning_levels":[{"effort":""}]}]}`,
		"number effort": `{"models":[{"slug":"a","supported_reasoning_levels":[{"effort":3}]}]}`,
		"null tiers": `{"models":[{"slug":"a","supported_reasoning_levels":[],"additional_speed_tiers":null}]}`,
		"nonarray tiers": `{"models":[{"slug":"a","supported_reasoning_levels":[],"additional_speed_tiers":{}}]}`,
		"nonstring tier": `{"models":[{"slug":"a","supported_reasoning_levels":[],"additional_speed_tiers":[3]}]}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			catalog, err := modelcatalog.ParseCodex(successfulCommand(raw))
			requireCatalogError(t, err, "CODEX_MODEL_CATALOG_INVALID", "Codex returned an invalid model catalog.", false)
			if catalog != nil {
				t.Fatal("invalid catalog was partially published")
			}
		})
	}
}

func TestParseCodexCatalogBounds(t *testing.T) {
	for _, count := range []int{10_000, 10_001} {
		t.Run(fmt.Sprintf("models %d", count), func(t *testing.T) {
			models := make([]string, count)
			for index := range models {
				models[index] = fmt.Sprintf(`{"slug":"model-%d","supported_reasoning_levels":[]}`, index)
			}
			catalog, err := modelcatalog.ParseCodex(successfulCommand(`{"models":[` + strings.Join(models, ",") + `]}`))
			if count == 10_000 {
				if err != nil || len(nativeField(t, catalog, "models").([]any)) != count {
					t.Fatalf("exact catalog bound rejected: %v", err)
				}
			} else {
				requireCatalogError(t, err, "CODEX_MODEL_CATALOG_INVALID", "Codex returned an invalid model catalog.", false)
			}
		})
	}
	for _, suffix := range []string{"", "x"} {
		t.Run(fmt.Sprintf("UTF16 overflow %t", suffix != ""), func(t *testing.T) {
			slug, err := json.Marshal(strings.Repeat("😀", 512) + suffix)
			if err != nil {
				t.Fatal(err)
			}
			_, err = modelcatalog.ParseCodex(successfulCommand(`{"models":[{"slug":` + string(slug) + `,"supported_reasoning_levels":[]}]}`))
			if suffix == "" && err != nil {
				t.Fatalf("1024 UTF16 units must be accepted: %v", err)
			}
			if suffix != "" {
				requireCatalogError(t, err, "CODEX_MODEL_CATALOG_INVALID", "Codex returned an invalid model catalog.", false)
			}
		})
	}
}

func TestParseCodexRefreshWarnings(t *testing.T) {
	for _, tc := range []struct {
		name   string
		stderr string
		cached bool
	}{
		{"refresh failed", "ERROR failed to refresh available models: private provider detail", true},
		{"different case", "Failed to refresh available models:", false},
		{"cache storage failed", "Failed to read models cache\nFailed to persist models cache", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := successfulCommand(`{"models":[],"modelCatalogSource":"native"}`)
			result.Stderr = tc.stderr
			catalog, err := modelcatalog.ParseCodex(result)
			if err != nil {
				t.Fatal(err)
			}
			expected := "native"
			if tc.cached {
				expected = "cached"
			}
			if !reflect.DeepEqual(nativeField(t, catalog, "modelCatalogSource"), decodeValue(t, fmt.Sprintf("%q", expected))) {
				t.Fatalf("wrong catalog provenance: %v", catalog)
			}
		})
	}
}

func TestParseCodexPreservesFailureCause(t *testing.T) {
	_, err := modelcatalog.ParseCodex(successfulCommand("{"))
	native := requireCatalogError(t, err, "CODEX_MODEL_CATALOG_INVALID", "Codex returned an invalid model catalog.", false)
	if !errors.Is(native, jsonvalue.ErrSyntax) {
		t.Fatalf("JSON parse cause was lost: %v", native.Unwrap())
	}
	for _, exit := range []*int{nil, newInt(1)} {
		_, err := modelcatalog.ParseCodex(modelcatalog.CommandResult{ExitCode: exit, Stdout: "private output", Stderr: "private provider failure"})
		requireCatalogError(t, err, "CODEX_MODEL_CATALOG_UNAVAILABLE",
			"Codex could not read the native model catalog. Retry after native discovery is available.", true)
	}
}

func newInt(value int) *int { return &value }
