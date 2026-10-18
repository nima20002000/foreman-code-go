package mcpserver

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode"

	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// requestInfo contains only transport selections. Domain inputs remain raw JSON
// for generated validators; this is not a second protocol DTO or domain schema.
type requestInfo struct {
	tool         string
	id           rpcID
	tracks       bool
	cancelID     rpcID
	cancellation bool
	invalidID    bool
	responseID   jsonvalue.UTF16String
	stringID     bool
}

func readRequest(w http.ResponseWriter, request *http.Request, limit int64) (*http.Request, requestInfo, error) {
	buffered, err := httpserver.ReadBufferedBody(w, request, limit)
	if err != nil {
		return nil, requestInfo{}, err
	}
	value, parsed := httpserver.ParsedJSONBody(buffered)
	if !parsed {
		return buffered, requestInfo{}, nil
	}
	// The frozen Node adapter passes Fastify's already-parsed body to the TS
	// transport. The Go SDK reads bytes, so replay the same normalized JSON from
	// the shared cache, not the original BOM/invalid UTF-8 transport spelling.
	data, _ := httpserver.JSONBody(buffered)
	buffered.Body = io.NopCloser(bytes.NewReader(data))
	return buffered, inspectRequest(value), nil
}

func inspectRequest(value any) requestInfo {
	object, ok := value.(jsonvalue.Object)
	if !ok {
		return requestInfo{}
	}
	var info requestInfo
	method, _ := objectField(object, "method")
	paramsValue, _ := objectField(object, "params")
	params, _ := paramsValue.(jsonvalue.Object)
	if textEquals(method, "tools/call") {
		name, _ := objectField(params, "name")
		if name, ok := name.(jsonvalue.UTF16String); ok {
			info.tool, _ = name.UTF8()
		}
	}
	id, hasID := objectField(object, "id")
	if hasID {
		info.id, ok = requestID(id)
		if text, isString := id.(jsonvalue.UTF16String); isString {
			info.responseID, info.stringID = text, true
		}
		// The SDK's MakeID truncates numbers to int64 and accepts nil as a
		// notification. The pinned TS RPC schema rejects unsafe/fractional
		// numbers and explicit null IDs. Other shape validation stays in SDK.
		_, numeric := id.(json.Number)
		info.invalidID = (numeric || id == nil) && !ok
	}
	version, _ := objectField(object, "jsonrpc")
	if !textEquals(version, "2.0") {
		return info
	}
	if textEquals(method, "tools/call") && hasID && ok {
		info.tracks = true
	}
	if len(object) == 3 && textEquals(method, "notifications/cancelled") && params != nil {
		cancelID, present := objectField(params, "requestId")
		if present {
			info.cancelID, info.cancellation = requestID(cancelID)
		}
	}
	return info
}

// sourceTransportError preserves the frozen server2.0 header-before-RPC order
// after Fastify-compatible body admission and caller/tool boundary selection.
// Successful cancellation notifications return before this SDK-only boundary.
func sourceTransportError(request *http.Request, info requestInfo) (int, int, string) {
	accept := strings.Join(request.Header.Values("Accept"), ", ")
	if !strings.Contains(accept, "application/json") || !strings.Contains(accept, "text/event-stream") {
		return 406, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream"
	}
	if !sourceJSONContentType(request.Header.Get("Content-Type")) {
		return 415, -32000, "Unsupported Media Type: Content-Type must be application/json"
	}
	if info.invalidID {
		return 400, -32700, "Parse error: Invalid JSON-RPC message"
	}
	return 0, 0, ""
}

// mediaTypeEssence in the pinned TS core first uses content-type.parse and
// falls back to the trimmed/lowercased segment for malformed parameters. The
// fallback rejects an ambiguous comma tail. Fastify body admission ran first.
func sourceJSONContentType(header string) bool {
	media, _, err := mime.ParseMediaType(header)
	if err == nil {
		return media == "application/json"
	}
	segment, _, _ := strings.Cut(header, ";")
	essence := strings.ToLower(strings.TrimFunc(segment, func(char rune) bool {
		return char == '\ufeff' || char != '\u0085' && unicode.IsSpace(char)
	}))
	if essence != "application/json" || len(header) < len(essence) {
		return false
	}
	return !strings.Contains(header[len(essence):], ",")
}

func writeRPCTransportError(w http.ResponseWriter, status, code int, message string) error {
	return httpserver.WriteJSON(w, status, map[string]any{
		"jsonrpc": "2.0", "id": nil,
		"error": map[string]any{"code": code, "message": message},
	})
}
