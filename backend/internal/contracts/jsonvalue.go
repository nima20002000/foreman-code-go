package contracts

import (
	"encoding/json"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// ParseJSON delegates to the common lossless JSON grammar reader. It returns
// jsonvalue.Object/UTF16String, []any, json.Number, bool, and nil for canonical
// identity and generated validation. Transport normalization belongs to callers.
func ParseJSON(data json.RawMessage) (any, error) {
	return jsonvalue.Parse(data)
}

// JSONValue marshals through the public JSON boundary, then decodes losslessly.
// Generated presence helpers and Text invoke their JSON methods. json.RawMessage
// is decoded as JSON, never treated as an array of its byte values.
func JSONValue(value any) (any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return ParseJSON(data)
}
