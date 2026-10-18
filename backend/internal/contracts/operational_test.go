package contracts_test

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
)

func TestGeneratedOperationalReferenceVectors(t *testing.T) {
	registry := generatedRegistry(t)
	capture := loadCapture(t, "OPERATIONAL_CONTRACT_VECTORS_FILE", 38, registry)
	for _, vector := range capture.Vectors {
		if !vector.GoApplicable || vector.Schema != contracts.OperationalFailureSchemaID { t.Fatal("unexpected operational source case") }
		t.Run(vector.ID, func(t *testing.T) {
			value, err := registry.Parse(vector.Schema, json.RawMessage(vector.Input.JSON))
			assertOutcome(t, vector, value, err)
		})
	}
}

func TestGeneratedOperationalTypesPreserveReadback(t *testing.T) {
	registry := generatedRegistry(t)
	capture := loadCapture(t, "OPERATIONAL_CONTRACT_VECTORS_FILE", 38, registry)
	for _, vector := range capture.Vectors {
		t.Run(vector.ID, func(t *testing.T) {
			value, err := contracts.ParseOperationalFailure(registry, json.RawMessage(vector.Input.JSON))
			if !vector.Frozen.Accepted { assertOutcome(t, vector, nil, err); return }
			if err != nil { t.Fatal(err) }
			if vector.ID == "operational.attempt-negative-zero" {
				attempt, present := value.Attempt.Get()
				if !present || attempt != 0 || !math.Signbit(attempt) { t.Fatal("generated safe-integer field lost source negative zero") }
			}
			if vector.ID == "operational.elapsed-negative-zero" {
				elapsed, present := value.ElapsedMs.Get()
				if !present || elapsed != 0 || !math.Signbit(elapsed) { t.Fatal("generated number field lost source negative zero") }
			}
			decoded, err := contracts.JSONValue(value)
			if err != nil { t.Fatal(err) }
			actual := canonicalValue(t, readback(t, decoded, true, true))
			expected := canonicalValue(t, readback(t, parsed(t, vector.Frozen.JSON), true, true))
			if actual != expected { t.Fatalf("generated operational DTO changed normalized JSON readback\ngot %s\nwant %s", actual, expected) }
		})
	}
}
