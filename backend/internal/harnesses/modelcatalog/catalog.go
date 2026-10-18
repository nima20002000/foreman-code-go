// Package modelcatalog reads native Codex model metadata without starting a
// thread or a model turn. Its values are native JSON, not shared API DTOs.
package modelcatalog

import (
	"log/slog"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

const (
	maxModels      = 10_000
	refreshFailure = "failed to refresh available models:"
)

// ParseCodex validates the frozen native catalog format. Unknown properties and
// JavaScript string identities survive through the shared lossless JSON value.
// It neither chooses a model nor qualifies an account or execution setting.
func ParseCodex(result CommandResult) (jsonvalue.Object, error) {
	if result.ExitCode == nil || *result.ExitCode != 0 {
		return nil, &Error{Code: "CODEX_MODEL_CATALOG_UNAVAILABLE",
			Message: "Codex could not read the native model catalog. Retry after native discovery is available.", Retryable: true}
	}
	value, err := jsonvalue.Parse([]byte(result.Stdout))
	if err != nil {
		return nil, invalidCatalog(err)
	}
	catalog, ok := value.(jsonvalue.Object)
	if !ok {
		return nil, invalidCatalog(nil)
	}
	if err := validateCatalog(catalog); err != nil {
		return nil, err
	}
	if strings.Contains(result.Stderr, refreshFailure) {
		reportRefreshFailure()
		catalog = setProperty(catalog, "modelCatalogSource", text("cached"))
	}
	return catalog, nil
}

func validateCatalog(catalog jsonvalue.Object) error {
	models, ok := property(catalog, "models").([]any)
	if !ok || len(models) > maxModels {
		return invalidCatalog(nil)
	}
	ids := make(map[string]struct{}, len(models))
	for _, value := range models {
		model, ok := value.(jsonvalue.Object)
		if !ok {
			return invalidCatalog(nil)
		}
		slug, ok := property(model, "slug").(jsonvalue.UTF16String)
		if !ok || len(slug) == 0 || len(slug) > 1_024 {
			return invalidCatalog(nil)
		}
		key := slug.IdentityKey()
		if _, exists := ids[key]; exists {
			return invalidCatalog(nil)
		}
		ids[key] = struct{}{}
		levels, ok := property(model, "supported_reasoning_levels").([]any)
		if !ok {
			return invalidCatalog(nil)
		}
		for _, value := range levels {
			level, ok := value.(jsonvalue.Object)
			if !ok {
				return invalidCatalog(nil)
			}
			effort, ok := property(level, "effort").(jsonvalue.UTF16String)
			if !ok || len(effort) == 0 {
				return invalidCatalog(nil)
			}
		}
		if value, exists := lookup(model, "additional_speed_tiers"); exists {
			tiers, ok := value.([]any)
			if !ok {
				return invalidCatalog(nil)
			}
			for _, tier := range tiers {
				if _, ok := tier.(jsonvalue.UTF16String); !ok {
					return invalidCatalog(nil)
				}
			}
		}
	}
	return nil
}

func lookup(object jsonvalue.Object, name string) (any, bool) {
	key := text(name)
	for _, member := range object {
		if member.Key.Equal(key) {
			return member.Value, true
		}
	}
	return nil, false
}

func property(object jsonvalue.Object, name string) any {
	value, _ := lookup(object, name)
	return value
}

func setProperty(object jsonvalue.Object, name string, value any) jsonvalue.Object {
	key := text(name)
	for index := range object {
		if object[index].Key.Equal(key) {
			object[index].Value = value
			return object
		}
	}
	return append(object, jsonvalue.Member{Key: key, Value: value})
}

// All callers supply source-defined ASCII property names and diagnostic values.
func text(value string) jsonvalue.UTF16String {
	units, _ := jsonvalue.FromUTF8(value)
	return units
}

func reportRefreshFailure() {
	slog.Warn("Native model refresh failed; using its validated cached catalog.",
		"code", "NATIVE_MODEL_REFRESH_FAILED", "dataAgeMs", nil)
}
