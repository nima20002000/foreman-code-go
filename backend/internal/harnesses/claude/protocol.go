// Package claude is the Go transport for the permanent official Claude SDK bridge.
// SDK payloads stay opaque here; Foreman domain types come from shared contracts.
package claude

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

const SDKVersion = "0.3.284"

var ErrClosed = errors.New("Claude bridge is closed")

// RemoteError preserves failures returned by the SDK bridge without manufacturing
// a successful tool decision, delivery receipt, or runtime-closure assertion.
type RemoteError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RemoteError) Error() string {
	return fmt.Sprintf("Claude bridge: %s (%d)", e.Message, e.Code)
}

type frame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      string          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RemoteError    `json:"error,omitempty"`
}

type response struct {
	result json.RawMessage
	err    error
}

// Callback runs Go policy for one native SDK callback. Its context is canceled
// when the SDK aborts that exact callback or the query/transport closes.
type Callback func(context.Context, []json.RawMessage) (json.RawMessage, error)

// CallbackReference is a transport marker for an SDK callback option. For
// example, use it for options.canUseTool or one element of a hook's hooks array.
func CallbackReference(name string) json.RawMessage {
	value, _ := json.Marshal(map[string]string{"__foremanBridgeCallback": name})
	return value
}
