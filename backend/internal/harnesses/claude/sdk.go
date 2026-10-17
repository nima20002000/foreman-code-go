package claude

import (
	"context"
	"encoding/json"
	"fmt"
)

// Initialize loads the actual SDK manifest and exports through sdkEntrypoint.
// The version is transport metadata, never a qualification/admission receipt.
func (c *Client) Initialize(ctx context.Context, sdkEntrypoint string) (string, error) {
	result, err := c.call(ctx, "initialize", map[string]string{"sdkEntrypoint": sdkEntrypoint})
	if err != nil {
		return "", err
	}
	var metadata struct {
		SDKVersion string `json:"sdkVersion"`
	}
	if err := json.Unmarshal(result, &metadata); err != nil {
		return "", err
	}
	if metadata.SDKVersion != SDKVersion {
		return "", fmt.Errorf("Claude SDK version %q does not match pinned %s", metadata.SDKVersion, SDKVersion)
	}
	return metadata.SDKVersion, nil
}

func (c *Client) sdkCall(ctx context.Context, method string, args ...any) (json.RawMessage, error) {
	return c.call(ctx, method, map[string]any{"args": args})
}

func (c *Client) GetSessionInfo(ctx context.Context, sessionID string, options json.RawMessage) (json.RawMessage, error) {
	return c.sdkCall(ctx, "getSessionInfo", sessionID, options)
}

func (c *Client) GetSessionMessages(ctx context.Context, sessionID string, options json.RawMessage) (json.RawMessage, error) {
	return c.sdkCall(ctx, "getSessionMessages", sessionID, options)
}

func (c *Client) ForkSession(ctx context.Context, sessionID string, options json.RawMessage) (json.RawMessage, error) {
	return c.sdkCall(ctx, "forkSession", sessionID, options)
}

func (c *Client) ListSubagents(ctx context.Context, sessionID string, options json.RawMessage) (json.RawMessage, error) {
	return c.sdkCall(ctx, "listSubagents", sessionID, options)
}

func (c *Client) GetSubagentMessages(ctx context.Context, sessionID, agentID string, options json.RawMessage) (json.RawMessage, error) {
	return c.sdkCall(ctx, "getSubagentMessages", sessionID, agentID, options)
}
