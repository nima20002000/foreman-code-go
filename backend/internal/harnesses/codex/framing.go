package codex

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"unicode/utf16"
)

func (t *Transport) readFrames() {
	defer func() {
		if recover() != nil {
			t.fail(failure("CODEX_PROTOCOL_INVALID", "Codex dispatch failed.", nil))
		}
	}()
	reader := bufio.NewReaderSize(t.streams.Output, 64*1024)
	var pending []byte
	for t.IsConnected() {
		chunk, err := reader.ReadSlice('\n')
		pending = append(pending, chunk...)
		if len(pending) > maxFrameBytes+2 {
			t.fail(failure("CODEX_PROTOCOL_INVALID", "Codex stdout frame exceeded its limit.", nil))
			return
		}
		if err == nil {
			line := bytes.TrimSuffix(bytes.TrimSuffix(pending, []byte{'\n'}), []byte{'\r'})
			if len(line) > maxFrameBytes {
				t.fail(failure("CODEX_PROTOCOL_INVALID", "Codex stdout frame exceeded its limit.", nil))
				return
			}
			if len(bytes.TrimSpace(line)) > 0 {
				t.receive(line)
			}
			pending = nil
			continue
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			if len(pending) > maxFrameBytes {
				t.fail(failure("CODEX_PROTOCOL_INVALID", "Codex stdout frame exceeded its limit.", nil))
				return
			}
			continue
		}
		if t.IsConnected() && len(pending) > 0 && errors.Is(err, io.EOF) {
			t.malformed("incomplete_frame", "")
		}
		t.fail(failure("CODEX_APP_SERVER_DISCONNECTED", "Codex app-server disconnected.", err))
		return
	}
}

func normalizedID(value json.RawMessage) (json.RawMessage, bool) {
	value = bytes.TrimSpace(value)
	if len(value) == 0 {
		return nil, false
	}
	var text string
	if value[0] == '"' && json.Unmarshal(value, &text) == nil {
		encoded, _ := json.Marshal(text)
		return encoded, true
	}
	var number json.Number
	if json.Unmarshal(value, &number) != nil {
		return nil, false
	}
	parsed, err := strconv.ParseFloat(string(number), 64)
	if err != nil || math.IsInf(parsed, 0) || math.Trunc(parsed) != parsed || math.Abs(parsed) > 9007199254740991 {
		return nil, false
	}
	return json.RawMessage(strconv.FormatInt(int64(parsed), 10)), true
}

func objectParams(params json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(params)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		return params
	}
	return nil
}

func (t *Transport) receive(line []byte) {
	if !json.Valid(line) {
		t.malformed("invalid_json", "")
		return
	}
	var message map[string]json.RawMessage
	if json.Unmarshal(redactFrame(line, t.options.KnownSecrets), &message) != nil || message == nil {
		t.malformed("invalid_envelope", "")
		return
	}
	id, hasID := normalizedID(message["id"])
	var method, idText string
	_ = json.Unmarshal(message["method"], &method)
	_ = json.Unmarshal(id, &idText)
	if len(utf16.Encode([]rune(idText))) > 1024 || len(utf16.Encode([]rune(method))) > 256 {
		t.malformed("identity_size_limit", "")
		return
	}
	if hasID && method != "" {
		t.receiveRequest(Request{ID: id, Method: method, Params: objectParams(message["params"])})
		return
	}
	if hasID {
		t.receiveResponse(id, message)
		return
	}
	if method == "" {
		t.malformed("invalid_envelope", "")
		return
	}
	notification := Notification{Method: method, Params: message["params"]}
	if err := t.options.Protocol.Notification(notification); err != nil {
		t.malformed("invalid_notification", method)
		return
	}
	notification.Params = objectParams(notification.Params)
	if notification.Params == nil {
		notification.Params = json.RawMessage(`{}`)
	}
	t.notify(notification)
}

func (t *Transport) receiveRequest(request Request) {
	err := t.options.Protocol.ServerRequest(request)
	if err == nil {
		err = t.handleRequest(request)
	}
	if err == nil {
		return
	}
	if rejectErr := t.Reject(t.lifetime, request.ID, -32602, "Invalid or unsupported native interaction."); rejectErr != nil {
		t.fail(failure("NATIVE_RESPONSE_DELIVERY_UNCERTAIN", "Native request rejection failed.", rejectErr))
	}
	t.malformed("invalid_request", request.Method)
}

func (t *Transport) handleRequest(request Request) (err error) {
	defer func() {
		if recover() != nil {
			err = failure("CODEX_PROTOCOL_INVALID", "Native request handling failed.", nil)
		}
	}()
	if t.options.OnRequest == nil {
		return failure("CODEX_METHOD_UNQUALIFIED", "No native interaction handler is configured.", nil)
	}
	return t.options.OnRequest(t.lifetime, request)
}

func (t *Transport) receiveResponse(id json.RawMessage, message map[string]json.RawMessage) {
	key := string(id)
	t.mu.Lock()
	op := t.operations[key]
	if op == nil {
		op = t.uncertain[key]
	}
	t.mu.Unlock()
	if op == nil {
		return
	}
	value, resultExists := message["result"]
	nativeError, errorExists := message["error"]
	var resultErr error
	var native struct {
		Code    *float64 `json:"code"`
		Message *string  `json:"message"`
	}
	if errorExists && json.Unmarshal(nativeError, &native) == nil && native.Code != nil && native.Message != nil {
		code := "CODEX_APP_SERVER_REQUEST_FAILED"
		if *native.Code == -32601 {
			code = "CODEX_CONTRACT_UNSUPPORTED"
		}
		refused := rpcError(op.request.Method, id, false, code, t.options.Protocol.ProviderVersion(), nil)
		refused.NativeMessage = *native.Message
		resultErr = refused
	} else if !resultExists || errorExists || t.options.Protocol.Response(op.request.Method, value) != nil {
		t.settleFailure(key, "CODEX_APP_SERVER_RESPONSE_INVALID")
		t.malformed("invalid_response", op.request.Method)
		return
	}
	result := Result{Value: append(json.RawMessage(nil), value...), Err: resultErr}
	t.mu.Lock()
	wasLate := t.uncertain[key] == op
	if !wasLate && t.operations[key] != op {
		t.mu.Unlock()
		return
	}
	delete(t.operations, key)
	delete(t.uncertain, key)
	if !wasLate {
		close(op.finished)
		op.result <- result
	}
	t.mu.Unlock()
	if wasLate && op.late != nil {
		t.deliverLate(op.late, result)
	}
}

func (t *Transport) deliverLate(callback func(Result), result Result) {
	defer func() {
		if recover() != nil {
			t.fail(failure("CODEX_PROTOCOL_INVALID", "Native reconciliation callback failed.", nil))
		}
	}()
	callback(result)
}

func (t *Transport) notify(notification Notification) {
	if t.options.OnNotification == nil {
		return
	}
	defer func() {
		if recover() != nil {
			t.fail(failure("CODEX_PROTOCOL_INVALID", "Native event observer failed.", nil))
		}
	}()
	t.options.OnNotification(notification)
}

func (t *Transport) malformed(reason, method string) {
	params := map[string]string{"reason": reason}
	if method != "" {
		params["nativeMethod"] = method
	}
	data, _ := json.Marshal(params)
	t.notify(Notification{Method: "protocol/malformed", Params: data})
}

func (t *Transport) notifyDisconnect(err error) {
	if t.options.OnDisconnect == nil {
		return
	}
	defer func() {
		if recover() != nil {
			t.malformed("disconnect_observer_failed", "")
		}
	}()
	t.options.OnDisconnect(err)
}
