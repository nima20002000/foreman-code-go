package canonicaljson_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"strconv"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
)

type vectorInput struct {
	Kind    string        `json:"kind"`
	Number  string        `json:"number"`
	Units   []uint16      `json:"units"`
	Items   []vectorInput `json:"items"`
	Members []struct {
		Key   []uint16    `json:"key"`
		Value vectorInput `json:"value"`
	} `json:"members"`
	Length int `json:"length"`
	Depth  int `json:"depth"`
}

type vectorResult struct {
	Text      *string `json:"text"`
	Undefined bool    `json:"undefined"`
	Error     string  `json:"error"`
	SHA256    string  `json:"sha256"`
}

type referenceVector struct {
	ID        string        `json:"id"`
	Input     vectorInput   `json:"input"`
	MaxBytes  int64         `json:"maxBytes"`
	Canonical *vectorResult `json:"canonical"`
	Graph     *vectorResult `json:"graph"`
}

func loadReferenceVectors(t *testing.T) []referenceVector {
	t.Helper()
	path := os.Getenv("CANONICAL_JSON_VECTORS_FILE")
	if path == "" {
		path = "testdata/canonical-vectors.json"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("TS-produced canonical vectors are required; terminal Foreman CI must run scripts/go-contracts/canonical-vectors.ts first: %v", err)
	}
	var file struct {
		SchemaVersion int               `json:"schemaVersion"`
		Vectors       []referenceVector `json:"vectors"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if file.SchemaVersion != 1 || len(file.Vectors) == 0 {
		t.Fatal("reference fixture must contain nonzero version-1 TS outcomes")
	}
	seen := make(map[string]bool)
	for _, vector := range file.Vectors {
		if vector.ID == "" || seen[vector.ID] || (vector.Canonical == nil && vector.Graph == nil) {
			t.Fatal("reference fixture has empty/duplicate case ID or no serializer outcome")
		}
		seen[vector.ID] = true
	}
	return file.Vectors
}

func materializeVector(t *testing.T, input vectorInput) any {
	t.Helper()
	switch input.Kind {
	case "null":
		return nil
	case "undefined":
		return canonicaljson.Undefined
	case "true":
		return true
	case "false":
		return false
	case "string":
		return canonicaljson.UTF16String(input.Units)
	case "number":
		switch input.Number {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		}
		value, err := strconv.ParseFloat(input.Number, 64)
		if err != nil {
			t.Fatal(err)
		}
		return value
	case "array":
		values := make([]any, len(input.Items))
		for index, item := range input.Items {
			values[index] = materializeVector(t, item)
		}
		return values
	case "object":
		members := make(canonicaljson.Object, len(input.Members))
		for index, member := range input.Members {
			members[index] = canonicaljson.Member{Key: member.Key, Value: materializeVector(t, member.Value)}
		}
		return members
	case "filled-array":
		return make([]any, input.Length)
	case "nested-array":
		var value any
		for depth := 0; depth < input.Depth; depth++ {
			value = []any{value}
		}
		return value
	case "cycle-array":
		value := make([]any, 1)
		value[0] = value
		return value
	case "cycle-object":
		value := make(map[string]any)
		value["self"] = value
		return value
	case "date":
		return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	default:
		t.Fatalf("unknown common reference input kind %q", input.Kind)
		return nil
	}
}

func requireVectorResult(t *testing.T, expected *vectorResult, text string, err error) {
	t.Helper()
	if expected.Undefined {
		if !errors.Is(err, canonicaljson.ErrUndefined) || text != "" {
			t.Fatalf("top-level undefined produced %q, %v", text, err)
		}
		return
	}
	if expected.Error != "" {
		if err == nil || err.Error() != expected.Error || text != "" {
			t.Fatalf("expected error %q with no partial output; got %q, %v", expected.Error, text, err)
		}
		return
	}
	if expected.Text == nil || expected.SHA256 == "" {
		t.Fatal("successful TS result is missing its text or canonical-output digest")
	}
	if err != nil || text != *expected.Text {
		t.Fatalf("canonical bytes differ from TS: got %q, %v; want %q", text, err, *expected.Text)
	}
	digest := sha256.Sum256([]byte(text))
	if hex.EncodeToString(digest[:]) != expected.SHA256 {
		t.Fatal("canonical-output SHA-256 differs from the TS-produced identity")
	}
}

func TestCanonicalReferenceVectors(t *testing.T) {
	selected := 0
	for _, vector := range loadReferenceVectors(t) {
		if vector.Canonical != nil {
			selected++
			t.Run(vector.ID, func(t *testing.T) {
				text, err := canonicaljson.Canonical(materializeVector(t, vector.Input))
				requireVectorResult(t, vector.Canonical, text, err)
			})
		}
	}
	if selected == 0 {
		t.Fatal("zero canonical reference outcomes selected")
	}
}

func TestGraphReferenceVectors(t *testing.T) {
	selected := 0
	for _, vector := range loadReferenceVectors(t) {
		if vector.Graph != nil {
			selected++
			t.Run(vector.ID, func(t *testing.T) {
				text, err := canonicaljson.Graph(materializeVector(t, vector.Input), vector.MaxBytes)
				requireVectorResult(t, vector.Graph, text, err)
			})
		}
	}
	if selected == 0 {
		t.Fatal("zero graph reference outcomes selected")
	}
}

func TestCanonicalGoContainerRepresentations(t *testing.T) {
	shared := map[string]any{"😀": "é", "\ue000": true}
	value := map[string]any{
		"array": []any{shared, shared, canonicaljson.Undefined},
		"null": nil, "omitted": canonicaljson.Undefined,
	}
	text, err := canonicaljson.Canonical(value)
	if err != nil {
		t.Fatal(err)
	}
	units := func(value string) canonicaljson.UTF16String { return utf16.Encode([]rune(value)) }
	object := canonicaljson.Object{
		{Key: units("omitted"), Value: canonicaljson.Undefined},
		{Key: units("null"), Value: nil},
		{Key: units("array"), Value: []any{shared, shared, canonicaljson.Undefined}},
	}
	other, err := canonicaljson.Canonical(object)
	if err != nil || text != other {
		t.Fatalf("map and explicit UTF-16 object disagree: %q versus %q, %v", text, other, err)
	}
	graph, err := canonicaljson.Graph([]any{shared, shared}, canonicaljson.DefaultMaxBytes)
	canonical, canonicalErr := canonicaljson.Canonical([]any{shared, shared})
	if err != nil || canonicalErr != nil || graph != canonical {
		t.Fatalf("shared noncyclic objects were not accepted equally: %q, %v; %q, %v", graph, err, canonical, canonicalErr)
	}
}

func TestCanonicalGoNumberRepresentations(t *testing.T) {
	for _, value := range []any{int64(9007199254740993), uint64(9007199254740993), json.Number("9007199254740993")} {
		text, err := canonicaljson.Canonical(value)
		asJS, jsErr := canonicaljson.Canonical(float64(9007199254740993))
		if err != nil || jsErr != nil || text != asJS {
			t.Fatalf("Go number did not use JavaScript Number semantics: %q, %v; %q, %v", text, err, asJS, jsErr)
		}
	}
	for _, value := range []json.Number{"true", "null", "NaN", "01", "1 trailing"} {
		if _, err := canonicaljson.Canonical(value); !errors.Is(err, canonicaljson.ErrInvalid) {
			t.Fatalf("invalid JSON number %q returned %v", value, err)
		}
	}
}

func TestGraphRejectsNonJSONGoValues(t *testing.T) {
	for _, value := range []any{struct{ Value string }{"class"}, func() {}, make(chan int), map[int]string{1: "one"}, string([]byte{0xff})} {
		text, err := canonicaljson.Graph(value, canonicaljson.DefaultMaxBytes)
		if !errors.Is(err, canonicaljson.ErrInvalid) || text != "" {
			t.Fatalf("non-JSON value produced %q, %v", text, err)
		}
	}
	duplicate := canonicaljson.Object{{Key: canonicaljson.UTF16String{'a'}, Value: nil}, {Key: canonicaljson.UTF16String{'a'}, Value: true}}
	if text, err := canonicaljson.Graph(duplicate, canonicaljson.DefaultMaxBytes); !errors.Is(err, canonicaljson.ErrInvalid) || text != "" {
		t.Fatalf("duplicate explicit object keys produced %q, %v", text, err)
	}
}
