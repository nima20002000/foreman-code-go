package canonicaljson_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
)

func TestNumericKeysFirstLegacyReferenceVectors(t *testing.T) {
	path := os.Getenv("CANONICAL_JSON_LEGACY_VECTORS_FILE")
	if path == "" {
		path = "testdata/canonical-legacy-vectors.json"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("TS-produced legacy vectors are required; terminal Foreman CI must run scripts/go-contracts/canonical-vectors.ts <output.json> --legacy first: %v", err)
	}
	var file struct {
		SchemaVersion int `json:"schemaVersion"`
		Vectors       []struct {
			ID            string        `json:"id"`
			Input         vectorInput   `json:"input"`
			NumericLegacy *vectorResult `json:"numericLegacy"`
			LocaleLegacy  *vectorResult `json:"localeLegacy"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if file.SchemaVersion != 1 || len(file.Vectors) == 0 {
		t.Fatal("reference fixture must contain nonzero version-1 TS outcomes")
	}
	selected := 0
	seen := make(map[string]bool)
	for _, vector := range file.Vectors {
		if vector.ID == "" || seen[vector.ID] || (vector.NumericLegacy == nil && vector.LocaleLegacy == nil) {
			t.Fatal("legacy reference fixture has empty/duplicate case ID or no serializer outcome")
		}
		seen[vector.ID] = true
		if vector.NumericLegacy == nil {
			continue
		}
		selected++
		t.Run(vector.ID, func(t *testing.T) {
			text, err := canonicaljson.NumericKeysFirstLegacy(materializeVector(t, vector.Input))
			requireVectorResult(t, vector.NumericLegacy, text, err)
		})
	}
	if selected == 0 {
		t.Fatal("zero numeric-key legacy reference outcomes selected")
	}
}
