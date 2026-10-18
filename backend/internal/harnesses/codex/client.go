package codex

import (
	"context"
	"encoding/json"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
)

// StartThread forwards explicit native settings, including sandbox, unchanged.
// The caller remains responsible for Foreman's generated domain contracts and admission.
func (t *Transport) StartThread(ctx context.Context, params protocol.V2ThreadStartParams) (protocol.V2ThreadStartResponse, error) {
	return requestTyped[protocol.V2ThreadStartResponse](ctx, t, "thread/start", params)
}

// StartTurn submits one turn. It never retries on timeout or transport failure.
func (t *Transport) StartTurn(ctx context.Context, params protocol.V2TurnStartParams) (protocol.V2TurnStartResponse, error) {
	return requestTyped[protocol.V2TurnStartResponse](ctx, t, "turn/start", params)
}

// InterruptTurn targets the caller's existing thread and native turn IDs.
func (t *Transport) InterruptTurn(ctx context.Context, params protocol.V2TurnInterruptParams) (protocol.V2TurnInterruptResponse, error) {
	return requestTyped[protocol.V2TurnInterruptResponse](ctx, t, "turn/interrupt", params)
}

// ListModels supplies the discovery lane with the same typed native read boundary.
func (t *Transport) ListModels(ctx context.Context, params protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
	return requestTyped[protocol.V2ModelListResponse](ctx, t, "model/list", params)
}

func requestTyped[T any](ctx context.Context, transport *Transport, method string, params any) (T, error) {
	var result T
	data, err := json.Marshal(params)
	if err != nil {
		return result, failure("CODEX_PROTOCOL_INVALID", "Codex requires a valid structured request.", err)
	}
	value, err := transport.Request(ctx, method, data, nil)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(value, &result); err != nil {
		return result, failure("CODEX_APP_SERVER_RESPONSE_INVALID", "Codex returned an incompatible structured response; reconcile before retrying.", err)
	}
	return result, nil
}
