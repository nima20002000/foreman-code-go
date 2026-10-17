// Package activity supplies the read-side behavior shared by history services.
package activity

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

const historyCursorLimit = 16_384
const historyTimestampLayout = "2006-01-02T15:04:05.000000Z"

// EncodeRunHistoryCursor preserves the frozen history position as an opaque
// cursor. A nil workflowID binds to the absent filter; an empty filter is distinct.
// The cursor is a paging position and supplies no authorization.
func EncodeRunHistoryCursor(workspaceID string, workflowID *string, admittedAt, runID string) (string, error) {
	if !validHistoryTimestamp(admittedAt) || !validHistoryRunID(runID) {
		return "", invalidHistoryCursor()
	}
	scope, err := historyScopeHash(workspaceID, workflowID)
	if err != nil {
		return "", err
	}
	encoded, err := historyCursorJSON([]any{1, scope, admittedAt, runID})
	if err != nil {
		return "", err
	}
	value := base64.RawURLEncoding.EncodeToString(encoded)
	if len(value) > historyCursorLimit {
		return "", invalidHistoryCursor()
	}
	return value, nil
}

// DecodeRunHistoryCursor returns the exact PostgreSQL timestamp text and Run ID.
// A nil cursor means the first page; an explicitly empty cursor is invalid.
// Callers must authorize the complete scope independently of this position.
func DecodeRunHistoryCursor(workspaceID string, workflowID, cursor *string) (admittedAt, runID string, present bool, err error) {
	if cursor == nil {
		return "", "", false, nil
	}
	value := *cursor
	if value == "" || len(value) > historyCursorLimit {
		return "", "", false, invalidHistoryCursor()
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != value {
		return "", "", false, invalidHistoryCursor()
	}
	var record []json.RawMessage
	if err := json.Unmarshal(data, &record); err != nil || len(record) != 4 {
		return "", "", false, invalidHistoryCursor()
	}
	var version int
	var scope string
	if json.Unmarshal(record[0], &version) != nil || version != 1 ||
		json.Unmarshal(record[1], &scope) != nil ||
		json.Unmarshal(record[2], &admittedAt) != nil ||
		json.Unmarshal(record[3], &runID) != nil {
		return "", "", false, invalidHistoryCursor()
	}
	expectedScope, err := historyScopeHash(workspaceID, workflowID)
	if err != nil {
		return "", "", false, err
	}
	if scope != expectedScope {
		return "", "", false, invalidHistoryCursor()
	}
	encoded, err := EncodeRunHistoryCursor(workspaceID, workflowID, admittedAt, runID)
	if err != nil || encoded != value {
		return "", "", false, invalidHistoryCursor()
	}
	return admittedAt, runID, true, nil
}

func validHistoryTimestamp(value string) bool {
	if len(value) != len(historyTimestampLayout) || strings.HasPrefix(value, "0000-") {
		return false
	}
	parsed, err := time.Parse(historyTimestampLayout, value)
	return err == nil && parsed.Format(historyTimestampLayout) == value
}

func validHistoryRunID(value string) bool {
	return value != "" && !strings.ContainsRune(value, '\x00') &&
		strings.TrimFunc(value, historyTrimSpace) == value
}

// ECMAScript trim includes BOM but excludes NEL, unlike strings.TrimSpace.
func historyTrimSpace(value rune) bool {
	switch value {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
		'\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return value >= '\u2000' && value <= '\u200a'
}

func historyScopeHash(workspaceID string, workflowID *string) (string, error) {
	var workflow any
	if workflowID != nil {
		workflow = *workflowID
	}
	data, err := historyCursorJSON([]any{workspaceID, workflow})
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

// History cursors use JSON.stringify's array wire format. Encoding/json's HTML
// and JavaScript line-separator escapes must not change its bytes or scope hash.
// An escaped backslash is consumed together so literal "\\u2028" stays literal.
func historyCursorJSON(value []any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	result := make([]byte, 0, len(encoded))
	for index := 0; index < len(encoded); index++ {
		if encoded[index] != '\\' || index+1 >= len(encoded) {
			result = append(result, encoded[index])
			continue
		}
		if index+6 <= len(encoded) {
			switch string(encoded[index : index+6]) {
			case `\u2028`:
				result = append(result, "\u2028"...)
				index += 5
				continue
			case `\u2029`:
				result = append(result, "\u2029"...)
				index += 5
				continue
			}
		}
		result = append(result, encoded[index], encoded[index+1])
		index++
	}
	return result, nil
}

func invalidHistoryCursor() error {
	return domainerror.New("RUN_HISTORY_CURSOR_INVALID",
		"Use a Run history cursor from the same workspace and workflow filter.", 400, nil)
}
