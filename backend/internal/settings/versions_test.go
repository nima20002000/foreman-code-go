package settings_test

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/settings"
)

func TestSettingWriteRejectsInvalidRevisionBeforeStorage(t *testing.T) {
	cases := []struct {
		name  string
		value float64
	}{
		{"negative", -1},
		{"fraction", 0.5},
		{"unsafe integer", 9_007_199_254_740_992},
		{"not a number", math.NaN()},
		{"positive infinity", math.Inf(1)},
		{"negative infinity", math.Inf(-1)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			store := settings.NewVersionStore(nil)
			revision, versionID, err := store.Write(t.Context(), "general-settings", json.RawMessage(`{"theme":"light"}`), &test.value, nil)
			failure, ok := domainerror.As(err)
			if !ok || failure.Code != "REVISION_INVALID" || failure.Status != 400 ||
				failure.Message != "Expected revision must be a nonnegative integer." || failure.Details != nil {
				t.Fatalf("invalid revision error = %#v", err)
			}
			if revision != 0 || versionID != "" {
				t.Fatalf("invalid revision returned a saved version: %d %q", revision, versionID)
			}
		})
	}
}
