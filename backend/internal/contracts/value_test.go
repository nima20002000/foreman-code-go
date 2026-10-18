package contracts_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

func TestTextLosslessJSON(t *testing.T) {
	for _, test := range []struct {
		name string
		json string
		units []uint16
		utf8 bool
	}{
		{"empty", `""`, []uint16{}, true},
		{"lone_high", `"\ud800"`, []uint16{0xd800}, false},
		{"lone_low", `"\udc00"`, []uint16{0xdc00}, false},
		{"replacement", `"\ufffd"`, []uint16{0xfffd}, true},
		{"astral_pair", `"\ud83d\ude00"`, []uint16{0xd83d, 0xde00}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var value contracts.Text
			if err := json.Unmarshal([]byte(test.json), &value); err != nil {
				t.Fatal(err)
			}
			expected := contracts.TextFromUTF16(test.units)
			if !value.Equal(expected) || value.IdentityKey() != jsonvalue.UTF16String(test.units).IdentityKey() {
				t.Fatal("contract text changed UTF-16 identity")
			}
			if _, err := value.UTF8(); (err == nil) != test.utf8 || err != nil && !errors.Is(err, contracts.ErrInvalidUTF16) {
				t.Fatalf("UTF-8 conversion error = %v", err)
			}
			encoded, err := json.Marshal(value)
			if err != nil { t.Fatal(err) }
			readback, err := jsonvalue.ParseString(encoded)
			if err != nil || !readback.Equal(jsonvalue.UTF16String(test.units)) {
				t.Fatalf("lossless JSON readback = %q, error = %v", encoded, err)
			}
		})
	}
	if _, err := contracts.TextFromUTF8(string([]byte{0xff})); err == nil {
		t.Fatal("invalid UTF-8 was accepted as a contract string")
	}
	var value contracts.Text
	if err := json.Unmarshal([]byte(`null`), &value); err == nil {
		t.Fatal("JSON null became an empty contract string")
	}
}

func TestPresencePreservesMissingNullAndValue(t *testing.T) {
	type document struct {
		Value contracts.Optional[contracts.Nullable[contracts.Text]] `json:"value,omitzero"`
	}
	for _, test := range []struct {
		input string
		present bool
		nonnull bool
	}{
		{`{}`, false, false},
		{`{"value":null}`, true, false},
		{`{"value":""}`, true, true},
		{`{"value":"\ud800"}`, true, true},
	} {
		t.Run(test.input, func(t *testing.T) {
			var value document
			if err := json.Unmarshal([]byte(test.input), &value); err != nil { t.Fatal(err) }
			nullable, present := value.Value.Get()
			_, nonnull := nullable.Get()
			if present != test.present || nonnull != test.nonnull {
				t.Fatalf("presence changed: present=%v, nonnull=%v", present, nonnull)
			}
			encoded, err := json.Marshal(value)
			if err != nil { t.Fatal(err) }
			if string(encoded) != test.input {
				t.Fatalf("presence readback = %s, want %s", encoded, test.input)
			}
		})
	}
	var absent contracts.Optional[contracts.Text]
	if _, err := json.Marshal(absent); err == nil {
		t.Fatal("standalone missing value was silently serialized")
	}
}

func TestJSONValuePreservesPublicMarshalBoundary(t *testing.T) {
	type document struct {
		ID contracts.Text `json:"id"`
		Absent contracts.Optional[contracts.Text] `json:"absent,omitzero"`
		Present contracts.Optional[contracts.Nullable[contracts.Text]] `json:"present,omitzero"`
		Raw json.RawMessage `json:"raw"`
	}
	value := document{
		ID: contracts.TextFromUTF16([]uint16{0xd800}),
		Present: contracts.Some(contracts.Present(contracts.TextFromUTF16([]uint16{'x'}))),
		Raw: json.RawMessage(`{"\udc00":[1,true,null]}`),
	}
	shape, err := contracts.JSONValue(value)
	if err != nil { t.Fatal(err) }
	canonical, err := canonicaljson.Canonical(shape)
	if err != nil { t.Fatal(err) }
	if canonical != `{"id":"\ud800","present":"x","raw":{"\udc00":[1,true,null]}}` {
		t.Fatalf("public JSON boundary changed: %s", canonical)
	}
}
