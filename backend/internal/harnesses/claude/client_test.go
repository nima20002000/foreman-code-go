package claude_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/claude"
)

type peer struct {
	reader *json.Decoder
	input  *io.PipeReader
	output *io.PipeWriter
}

func newPeer(t *testing.T) (*claude.Client, *peer, context.Context) {
	t.Helper()
	clientInput, serverOutput := io.Pipe()
	serverInput, clientOutput := io.Pipe()
	client := claude.NewClient(clientInput, clientOutput)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(func() {
		cancel()
		_ = client.Close()
		_ = serverInput.Close()
		_ = serverOutput.Close()
	})
	return client, &peer{reader: json.NewDecoder(serverInput), input: serverInput, output: serverOutput}, ctx
}

func (p *peer) receive(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	var value map[string]json.RawMessage
	if err := p.reader.Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func (p *peer) send(t *testing.T, value map[string]any) {
	t.Helper()
	value["jsonrpc"] = "2.0"
	if err := json.NewEncoder(p.output).Encode(value); err != nil {
		t.Fatal(err)
	}
}

func textValue(t *testing.T, value json.RawMessage) string {
	t.Helper()
	var result string
	if err := json.Unmarshal(value, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestClientCorrelatesRepliesAndPreservesSDKFailures(t *testing.T) {
	client, server, ctx := newPeer(t)
	info := make(chan json.RawMessage, 1)
	failure := make(chan error, 1)
	go func() {
		value, err := client.GetSessionInfo(ctx, "session-one", json.RawMessage(`{"dir":"/isolated"}`))
		if err != nil {
			info <- json.RawMessage(`{"unexpected":true}`)
		} else {
			info <- value
		}
	}()
	go func() {
		_, err := client.GetSessionMessages(ctx, "session-one", json.RawMessage(`{"dir":"/wrong"}`))
		failure <- err
	}()
	first, second := server.receive(t), server.receive(t)
	for _, request := range []map[string]json.RawMessage{second, first} {
		if textValue(t, request["method"]) == "getSessionMessages" {
			server.send(t, map[string]any{"id": request["id"], "error": map[string]any{
				"code": -32000, "message": "wrong session directory", "data": map[string]string{"code": "NATIVE_SCOPE_MISMATCH"}}})
		} else {
			server.send(t, map[string]any{"id": request["id"], "result": map[string]string{"sessionId": "session-one"}})
		}
	}
	if string(<-info) != `{"sessionId":"session-one"}` {
		t.Fatal("session info was not correlated with its own request")
	}
	var native *claude.RemoteError
	if err := <-failure; !errors.As(err, &native) || native.Message != "wrong session directory" || string(native.Data) != `{"code":"NATIVE_SCOPE_MISMATCH"}` {
		t.Fatalf("SDK failure was lost: %v", err)
	}
}

func TestQueryStreamsAndControlsWhilePolicyCallbackWaits(t *testing.T) {
	client, server, ctx := newPeer(t)
	opened := make(chan *claude.Query, 1)
	openError := make(chan error, 1)
	started := make(chan struct{})
	go func() {
		query, err := client.Query(ctx, json.RawMessage(`{"canUseTool":{"__foremanBridgeCallback":"policy"}}`), map[string]claude.Callback{
			"policy": func(callbackCtx context.Context, args []json.RawMessage) (json.RawMessage, error) {
				if len(args) != 3 || string(args[0]) != `"Write"` {
					return nil, errors.New("native callback arguments changed")
				}
				close(started)
				<-callbackCtx.Done()
				return nil, callbackCtx.Err()
			},
		})
		opened <- query
		openError <- err
	}()
	request := server.receive(t)
	var params struct {
		QueryID string `json:"queryId"`
	}
	if err := json.Unmarshal(request["params"], &params); err != nil {
		t.Fatal(err)
	}
	server.send(t, map[string]any{"method": "query.event", "params": map[string]any{
		"queryId": params.QueryID, "event": map[string]any{"type": "system", "subtype": "init", "session_id": "native-session"}}})
	server.send(t, map[string]any{"id": request["id"], "result": map[string]string{"queryId": params.QueryID}})
	query := <-opened
	if err := <-openError; err != nil {
		t.Fatal(err)
	}
	server.send(t, map[string]any{"id": "b-native", "method": "callback", "params": map[string]any{
		"queryId": params.QueryID, "name": "policy", "args": []any{"Write", map[string]string{"file_path": "/isolated/blocked"}, map[string]string{"toolUseID": "native-tool"}}}})
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("policy callback did not arrive")
	}
	server.send(t, map[string]any{"method": "query.event", "params": map[string]any{
		"queryId": params.QueryID, "event": map[string]string{"type": "assistant", "uuid": "native-output"}}})
	for _, expected := range []string{"system", "assistant"} {
		event, err := query.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(event, &fields); err != nil {
			t.Fatal(err)
		}
		if textValue(t, fields["type"]) != expected {
			t.Fatalf("stream order changed: %s", event)
		}
	}
	interrupted := make(chan error, 1)
	go func() { _, err := query.Interrupt(ctx); interrupted <- err }()
	control := server.receive(t)
	if textValue(t, control["method"]) != "query.interrupt" {
		t.Fatal("callback blocked query control")
	}
	server.send(t, map[string]any{"id": control["id"], "result": nil})
	if err := <-interrupted; err != nil {
		t.Fatal(err)
	}
	server.send(t, map[string]any{"method": "callback.cancel", "params": map[string]string{"callbackId": "b-native"}})
	answer := server.receive(t)
	if textValue(t, answer["id"]) != "b-native" || len(answer["error"]) == 0 || len(answer["result"]) != 0 {
		t.Fatalf("aborted callback did not remain an error: %v", answer)
	}
	server.send(t, map[string]any{"method": "query.end", "params": map[string]string{"queryId": params.QueryID}})
	if _, err := query.Next(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("query did not finish: %v", err)
	}
}

func TestClientRejectsTruncatedFramesAndUnblocksRequests(t *testing.T) {
	client, server, ctx := newPeer(t)
	finished := make(chan error, 1)
	go func() {
		_, err := client.GetSessionInfo(ctx, "session", json.RawMessage(`{"dir":"/isolated"}`))
		finished <- err
	}()
	server.receive(t)
	if _, err := io.WriteString(server.output, `{"jsonrpc":"2.0","id":`); err != nil {
		t.Fatal(err)
	}
	if err := server.output.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("truncated response was not retained: %v", err)
	}
}

func TestCanceledOpenClosesTheSameLateQuery(t *testing.T) {
	client, server, ctx := newPeer(t)
	opening, cancel := context.WithCancel(ctx)
	finished := make(chan error, 1)
	go func() { _, err := client.Query(opening, nil, nil); finished <- err }()
	request := server.receive(t)
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatalf("open cancellation was lost: %v", err)
	}
	cleanup := server.receive(t)
	if textValue(t, cleanup["method"]) != "query.close" {
		t.Fatal("canceled query was left open")
	}
	var before, after struct {
		QueryID string `json:"queryId"`
	}
	if err := json.Unmarshal(request["params"], &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(cleanup["params"], &after); err != nil {
		t.Fatal(err)
	}
	if before.QueryID == "" || after.QueryID != before.QueryID {
		t.Fatal("cleanup targeted another query")
	}
}

func TestClientCloseUnblocksARequestWhoseBridgeStoppedReading(t *testing.T) {
	client, _, ctx := newPeer(t)
	finished := make(chan error, 1)
	go func() { _, err := client.GetSessionInfo(ctx, "session", json.RawMessage(`{}`)); finished <- err }()
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; !errors.Is(err, claude.ErrClosed) {
		t.Fatalf("transport closure did not unblock request: %v", err)
	}
}
