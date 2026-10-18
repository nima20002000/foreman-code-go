package jsonvalue_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

type referenceEvent struct {
	Kind       string   `json:"kind"`
	Length     int      `json:"length"`
	Units      []uint16 `json:"units"`
	CodePoints int      `json:"codePoints"`
	Bits       string   `json:"bits"`
	Value      *bool    `json:"value"`
}

type referenceVector struct {
	ID       string           `json:"id"`
	JSON     string           `json:"json"`
	Accepted bool             `json:"accepted"`
	Events   []referenceEvent `json:"events"`
	Error    *struct {
		Name string `json:"name"`
	} `json:"error"`
}

func TestParseReferenceVectors(t *testing.T) {
	path := os.Getenv("JSON_VALUE_VECTORS_FILE")
	if path == "" {
		path = "testdata/json-vectors.json"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("actual frozen JSON.parse vectors are required; no skip: %v", err)
	}
	var fixture struct {
		SchemaVersion int `json:"schemaVersion"`
		Source        struct {
			Reference string `json:"reference"`
		} `json:"source"`
		Vectors    []referenceVector `json:"vectors"`
		Unexpected []string          `json:"unexpected"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Source.Reference != "8d2ea76c5028ef4458bf8cd64ef8624422e71d9f" {
		t.Fatal("reference fixture provenance is not the required frozen JSON.parse capture")
	}
	if len(fixture.Vectors) != 54 || len(fixture.Unexpected) != 0 {
		t.Fatalf("all 54 actual reference outcomes without capture failures are required; got %d", len(fixture.Vectors))
	}
	seen := make(map[string]bool)
	for _, vector := range fixture.Vectors {
		if !strings.HasPrefix(vector.ID, "json.") || seen[vector.ID] {
			t.Fatalf("invalid/duplicate vector ID %q", vector.ID)
		}
		seen[vector.ID] = true
		t.Run(vector.ID, func(t *testing.T) {
			value, err := jsonvalue.Parse([]byte(vector.JSON))
			if !vector.Accepted {
				if vector.Error == nil || vector.Error.Name != "SyntaxError" {
					t.Fatal("invalid frozen rejection outcome")
				}
				if !errors.Is(err, jsonvalue.ErrSyntax) {
					t.Fatalf("expected JSON syntax rejection, got %v", err)
				}
				if strings.HasPrefix(vector.ID, "json.invalid.number-") {
					if _, err := jsonvalue.NumberFloat64(json.Number(vector.JSON)); !errors.Is(err, jsonvalue.ErrSyntax) {
						t.Fatalf("number token API accepted a rejected JSON number: %v", err)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("reference accepted input: %v", err)
			}
			actual, err := valueEvents(value)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, vector.Events) {
				t.Fatalf("public value readback differs from frozen JSON.parse (%d versus %d events)", len(actual), len(vector.Events))
			}
			if text, ok := value.(jsonvalue.UTF16String); ok {
				separate, err := jsonvalue.ParseString([]byte(vector.JSON))
				if err != nil || !separate.Equal(text) {
					t.Fatalf("ParseString differs from public Parse: %v", err)
				}
			}
		})
	}
}

func valueEvents(value any) ([]referenceEvent, error) {
	type task struct {
		value any
		event *referenceEvent
	}
	pending := []task{{value: value}}
	events := make([]referenceEvent, 0)
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if current.event != nil {
			events = append(events, *current.event)
			continue
		}
		switch value := current.value.(type) {
		case nil:
			events = append(events, referenceEvent{Kind: "null"})
		case bool:
			events = append(events, referenceEvent{Kind: "boolean", Value: &value})
		case jsonvalue.UTF16String:
			events = append(events, referenceEvent{Kind: "string", Units: value, CodePoints: value.CodePointCount()})
		case json.Number:
			number, err := jsonvalue.NumberFloat64(value)
			if err != nil {
				return nil, err
			}
			events = append(events, referenceEvent{Kind: "number", Bits: fmt.Sprintf("%016x", math.Float64bits(number))})
		case []any:
			events = append(events, referenceEvent{Kind: "array", Length: len(value)})
			pending = append(pending, task{event: &referenceEvent{Kind: "end-array"}})
			for index := len(value) - 1; index >= 0; index-- {
				pending = append(pending, task{value: value[index]})
			}
		case jsonvalue.Object:
			events = append(events, referenceEvent{Kind: "object", Length: len(value)})
			pending = append(pending, task{event: &referenceEvent{Kind: "end-object"}})
			for index := len(value) - 1; index >= 0; index-- {
				pending = append(pending, task{value: value[index].Value}, task{event: &referenceEvent{Kind: "key", Units: value[index].Key}})
			}
		default:
			return nil, fmt.Errorf("unexpected public JSON value type %T", value)
		}
	}
	return events, nil
}

func TestUTF16IdentityPreservesDistinctValues(t *testing.T) {
	values := []string{`""`, `"\ud800"`, `"\udc00"`, `"\ufffd"`}
	keys := make(map[string]bool)
	for _, input := range values {
		value, err := jsonvalue.ParseString([]byte(input))
		if err != nil {
			t.Fatal(err)
		}
		key := value.IdentityKey()
		if keys[key] {
			t.Fatalf("distinct JSON string identity collided for %s", input)
		}
		keys[key] = true
		if len(value) == 0 && key != "" {
			t.Fatal("empty text must have the empty opaque identity")
		}
		_, err = value.UTF8()
		if input == `"\ud800"` || input == `"\udc00"` {
			if !errors.Is(err, jsonvalue.ErrInvalidUTF16) {
				t.Fatalf("lone surrogate was silently converted: %v", err)
			}
		} else if err != nil {
			t.Fatal(err)
		}
	}
	quoted, err := jsonvalue.ParseString([]byte(`"\ud83d\ude00"`))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jsonvalue.FromUTF8("😀")
	if err != nil {
		t.Fatal(err)
	}
	if quoted.IdentityKey() != raw.IdentityKey() {
		t.Fatal("equivalent string spellings have different identities")
	}
}

func TestParseRequiresNormalizedUTF8(t *testing.T) {
	for _, data := range [][]byte{{'"', 0xff, '"'}, {'"', 0xed, 0xa0, 0x80, '"'}} {
		if _, err := jsonvalue.Parse(data); !errors.Is(err, jsonvalue.ErrSyntax) {
			t.Fatalf("raw invalid UTF-8 was accepted: %v", err)
		}
		if _, err := jsonvalue.ParseString(data); !errors.Is(err, jsonvalue.ErrSyntax) {
			t.Fatalf("string API accepted invalid UTF-8: %v", err)
		}
	}
	if _, err := jsonvalue.ParseString([]byte("null")); !errors.Is(err, jsonvalue.ErrSyntax) {
		t.Fatal("ParseString accepted a non-string")
	}
}
