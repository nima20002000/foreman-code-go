package mcpserver

import (
	"encoding/json"
	"log/slog"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// TextMirrorBytes is the existing MCP result text-mirror threshold.
const TextMirrorBytes = 256 * 1024

// ToolResult uses the same structured result and bounded text mirror as the TypeScript endpoint.
func ToolResult(value any) (*mcp.CallToolResult, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || data[0] != '{' {
		value = map[string]any{"value": value}
		data, err = json.Marshal(value)
		if err != nil {
			return nil, err
		}
	}
	content := []mcp.Content{}
	if len(data) <= TextMirrorBytes {
		content = append(content, &mcp.TextContent{Text: string(data)})
	}
	return &mcp.CallToolResult{Content: content, StructuredContent: value}, nil
}

// ToolFailure leaves structuredContent absent, so a success schema cannot mask the error.
func ToolFailure(err error) *mcp.CallToolResult {
	failure := domainerror.DatabaseConnectionFailure(domainerror.DatabaseReadFailure(err))
	body := map[string]any{
		"code": "INTERNAL_ERROR", "message": "The Operator service could not complete the request.",
	}
	if domain, ok := domainerror.As(failure); ok {
		body["code"] = domain.Code
		body["message"] = domain.Message
		if domain.Details != nil {
			body["details"] = domain.Details
		}
	}
	if class := domainerror.PublicFailureClass(failure); class != "" {
		body["class"] = class
	}
	data, marshalErr := json.Marshal(map[string]any{"error": body})
	if marshalErr != nil {
		// Invalid public details must not expose a private encoder error to the caller.
		slog.Error("MCP error details could not be encoded", "error", marshalErr)
		data = []byte(`{"error":{"code":"INTERNAL_ERROR","message":"The Operator service could not complete the request."}}`)
	}
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}
}
