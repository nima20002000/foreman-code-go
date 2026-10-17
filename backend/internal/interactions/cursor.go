// Package interactions owns durable interaction reads and response orchestration.
package interactions

import (
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

const listCursorPrefix = "interaction:"

// EncodeListCursor preserves the worker interaction-list cursor wire format.
// The caller supplies an identifier from a validated persisted interaction.
// Management and User routes use raw identifiers and must not use this codec.
func EncodeListCursor(id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(listCursorPrefix + id))
}

// DecodeListCursor reads a worker interaction-list cursor. An empty cursor means
// the first page. It rejects alternate base64 encodings and identifiers that the
// frozen TypeScript cursor reader does not accept, without trimming the value.
func DecodeListCursor(cursor string) (string, error) {
	if cursor == "" {
		return "", nil
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(cursor)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != cursor {
		return "", invalidListCursor()
	}
	value := string(decoded)
	if !strings.HasPrefix(value, listCursorPrefix) || len(value) == len(listCursorPrefix) {
		return "", invalidListCursor()
	}
	id := value[len(listCursorPrefix):]
	for index := 0; index < len(id); index++ {
		if id[index] < 0x21 || id[index] > 0x7e {
			return "", invalidListCursor()
		}
	}
	return id, nil
}

func invalidListCursor() error {
	return domainerror.New("INVALID_CURSOR", "The interaction cursor is invalid.", http.StatusBadRequest, nil)
}
