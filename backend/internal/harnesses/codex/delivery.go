package codex

import (
	"context"
	"encoding/json"
)

// Respond validates a native callback answer before attempting delivery. A write
// acknowledgement is not evidence that the provider accepted the interaction.
func (t *Transport) Respond(ctx context.Context, id json.RawMessage, method string, result json.RawMessage) error {
	if _, ok := normalizedID(id); !ok {
		return failure("NATIVE_RESPONSE_INVALID", "The native response identity is invalid; nothing was submitted.", nil)
	}
	if err := t.options.Protocol.ServerResponse(method, result); err != nil {
		return failure("NATIVE_RESPONSE_INVALID", "The response does not match the qualified native schema; nothing was submitted.", err)
	}
	if !t.IsConnected() {
		return failure("NATIVE_RESPONSE_DELIVERY_FAILED", "Codex app-server is not connected.", nil)
	}
	message := struct {
		ID     json.RawMessage `json:"id"`
		Result json.RawMessage `json:"result"`
	}{ID: id, Result: result}
	if _, err := encodeFrame(message); err != nil {
		return failure("NATIVE_RESPONSE_INVALID", "The native response exceeds the bounded frame size; nothing was submitted.", err)
	}
	t.mu.Lock()
	full := t.writes >= maxOperations
	t.mu.Unlock()
	if full {
		return failure("NATIVE_RESPONSE_DELIVERY_FAILED", "Too many outstanding provider writes; nothing was submitted.", nil)
	}
	if submitted, err := t.write(ctx, message); err != nil {
		if !submitted {
			return failure("NATIVE_RESPONSE_DELIVERY_FAILED", "The native response was not submitted.", err)
		}
		return failure("NATIVE_RESPONSE_DELIVERY_UNCERTAIN", "The native response may have been submitted; wait for native resolution before retrying.", err)
	}
	return nil
}

// Reject sends a fixed native protocol error for an unsupported callback.
func (t *Transport) Reject(ctx context.Context, id json.RawMessage, code int, message string) error {
	if _, ok := normalizedID(id); !ok {
		return failure("NATIVE_RESPONSE_INVALID", "The native response identity is invalid; nothing was submitted.", nil)
	}
	_, err := t.write(ctx, struct {
		ID    json.RawMessage `json:"id"`
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{ID: id, Error: struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
	return err
}

// write reports whether the owned endpoint's Write was attempted. Once caller
// cancellation observes an unsubmitted attempt, it fences that attempt before
// returning, even if the writer goroutine has not been scheduled yet.
func (t *Transport) write(ctx context.Context, message any) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	frame, err := encodeFrame(message)
	if err != nil {
		return false, err
	}
	t.mu.Lock()
	if !t.started || t.stopped {
		t.mu.Unlock()
		return false, failure("CODEX_APP_SERVER_DISCONNECTED", "Codex app-server is not connected.", nil)
	}
	if t.writes >= maxOperations {
		t.mu.Unlock()
		return false, failure("CODEX_WRITE_LIMIT", "Too many outstanding provider writes; wait for delivery before submitting more.", nil)
	}
	t.writes++
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.writes--
		t.mu.Unlock()
	}()
	deadline, cancel := context.WithTimeout(ctx, t.options.RequestTimeout)
	defer cancel()
	select {
	case <-deadline.Done():
		return false, deadline.Err()
	case <-t.done:
		return false, failure("CODEX_APP_SERVER_DISCONNECTED", "Codex app-server is not connected.", nil)
	case <-t.writer:
	}
	if err := deadline.Err(); err != nil {
		t.writer <- struct{}{}
		return false, err
	}
	if !t.IsConnected() {
		t.writer <- struct{}{}
		return false, failure("CODEX_APP_SERVER_DISCONNECTED", "Codex app-server is not connected.", nil)
	}
	type deliveryResult struct {
		submitted bool
		err error
	}
	result := make(chan deliveryResult, 1)
	var submitted, canceled bool // guarded by t.mu
	fence := func(err error) (bool, error) {
		t.mu.Lock()
		canceled = true
		attempted := submitted
		t.mu.Unlock()
		return attempted, err
	}
	go func() {
		defer func() { t.writer <- struct{}{} }()
		t.mu.Lock()
		if canceled || deadline.Err() != nil || t.stopped {
			t.mu.Unlock()
			result <- deliveryResult{err: failure("CODEX_APP_SERVER_DISCONNECTED", "Codex native write was canceled before submission.", nil)}
			return
		}
		submitted = true
		t.mu.Unlock()
		result <- deliveryResult{submitted: true, err: writeFrame(t.streams.Input, frame)}
	}()
	select {
	case value := <-result:
		return value.submitted, value.err
	case <-deadline.Done():
		return fence(deadline.Err())
	case <-t.done:
		return fence(failure("CODEX_APP_SERVER_DISCONNECTED", "Codex app-server is not connected.", nil))
	}
}
