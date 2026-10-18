package activity

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

const historyCursorLimit = 16_384
const historyTimestampLayout = "2006-01-02T15:04:05.000000Z"

// Both accepted inputs use I's shared string model. No encoded Go-string
// convention is used to carry unpaired UTF-16 code units.
type historyCursorString interface {
	string | jsonvalue.UTF16String
}

// EncodeRunHistoryCursor preserves the frozen history position as an opaque
// cursor. Identifier inputs accept ordinary UTF-8 strings or shared UTF16String
// values. Workspace and workflow use the same representation; the Run ID may
// use either. A nil workflowID binds to the absent filter, distinct from empty.
// The cursor is a paging position and supplies no authorization.
func EncodeRunHistoryCursor[Scope historyCursorString, RunID historyCursorString](workspaceID Scope, workflowID *Scope, admittedAt string, runID RunID) (string, error) {
	units, err := historyRunIDUnits(runID)
	if err != nil || !validHistoryTimestamp(admittedAt) || !validHistoryRunID(units) {
		return "", invalidHistoryCursor()
	}
	scope, err := historyScopeHash(workspaceID, workflowID)
	if err != nil {
		return "", err
	}
	// This fixed array contains no objects: Canonical's shared string and
	// number encoding is exactly the frozen JSON.stringify array format.
	wire, err := canonicaljson.Canonical([]any{1, scope, admittedAt, units})
	if err != nil {
		return "", invalidHistoryCursor()
	}
	value := base64.RawURLEncoding.EncodeToString([]byte(wire))
	if len(value) > historyCursorLimit {
		return "", invalidHistoryCursor()
	}
	return value, nil
}

// DecodeRunHistoryCursor returns the exact PostgreSQL timestamp text and Run ID
// code units. Scope inputs accept strings or UTF16String, as Encode does. A nil
// cursor means the first page; an explicitly empty cursor is invalid. Callers
// must authorize the scope independently and retain the shared Run ID value
// until its consumer explicitly admits a UTF-8 conversion.
func DecodeRunHistoryCursor[Scope historyCursorString](workspaceID Scope, workflowID *Scope, cursor *string) (admittedAt string, runID jsonvalue.UTF16String, present bool, err error) {
	if cursor == nil {
		return "", nil, false, nil
	}
	value := *cursor
	if value == "" || len(value) > historyCursorLimit {
		return "", nil, false, invalidHistoryCursor()
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != value {
		return "", nil, false, invalidHistoryCursor()
	}
	// Frozen TS replaces invalid transport UTF-8 before JSON.parse, but its
	// exact final re-encoding rejects every such noncanonical byte sequence.
	raw, err := jsonvalue.Parse(data)
	if err != nil {
		return "", nil, false, invalidHistoryCursor()
	}
	record, ok := raw.([]any)
	if !ok || len(record) != 4 {
		return "", nil, false, invalidHistoryCursor()
	}
	versionToken, ok := record[0].(json.Number)
	if !ok {
		return "", nil, false, invalidHistoryCursor()
	}
	version, err := jsonvalue.NumberFloat64(versionToken)
	if err != nil || version != 1 {
		return "", nil, false, invalidHistoryCursor()
	}
	scopeUnits, scopeOK := record[1].(jsonvalue.UTF16String)
	timestampUnits, timestampOK := record[2].(jsonvalue.UTF16String)
	runID, runOK := record[3].(jsonvalue.UTF16String)
	if !scopeOK || !timestampOK || !runOK {
		return "", nil, false, invalidHistoryCursor()
	}
	// These two fields must equal ASCII hash/timestamp text. The identity-bearing
	// Run ID stays in UTF-16 throughout validation and canonical re-encoding.
	scope, err := scopeUnits.UTF8()
	if err != nil {
		return "", nil, false, invalidHistoryCursor()
	}
	admittedAt, err = timestampUnits.UTF8()
	if err != nil {
		return "", nil, false, invalidHistoryCursor()
	}
	expectedScope, err := historyScopeHash(workspaceID, workflowID)
	if err != nil {
		return "", nil, false, err
	}
	if scope != expectedScope {
		return "", nil, false, invalidHistoryCursor()
	}
	encoded, err := EncodeRunHistoryCursor(workspaceID, workflowID, admittedAt, runID)
	if err != nil || encoded != value {
		return "", nil, false, invalidHistoryCursor()
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

func historyRunIDUnits[Text historyCursorString](value Text) (jsonvalue.UTF16String, error) {
	if units, ok := any(value).(jsonvalue.UTF16String); ok {
		return units, nil
	}
	return jsonvalue.FromUTF8(any(value).(string))
}

func validHistoryRunID(value jsonvalue.UTF16String) bool {
	if len(value) == 0 || historyTrimSpace(value[0]) || historyTrimSpace(value[len(value)-1]) {
		return false
	}
	for _, unit := range value {
		if unit == 0 {
			return false
		}
	}
	return true
}

// ECMAScript trim includes BOM but excludes NEL. All its whitespace values are
// BMP units; testing the ends does not decode or replace unpaired surrogates.
func historyTrimSpace(value uint16) bool {
	switch value {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
		'\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return value >= '\u2000' && value <= '\u200a'
}

func historyScopeHash[Scope historyCursorString](workspaceID Scope, workflowID *Scope) (string, error) {
	var workflow any
	if workflowID != nil {
		workflow = *workflowID
	}
	wire, err := canonicaljson.Canonical([]any{workspaceID, workflow})
	if err != nil {
		return "", invalidHistoryCursor()
	}
	hash := sha256.Sum256([]byte(wire))
	return hex.EncodeToString(hash[:]), nil
}

func invalidHistoryCursor() error {
	return domainerror.New("RUN_HISTORY_CURSOR_INVALID",
		"Use a Run history cursor from the same workspace and workflow filter.", 400, nil)
}
