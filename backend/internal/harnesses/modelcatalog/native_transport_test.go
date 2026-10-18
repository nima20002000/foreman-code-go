package modelcatalog_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/modelcatalog"
)

// This fake native peer exercises the existing real Transport and generated
// ListModels client over owned in-memory stdio. It is not a provider
// installation, emitted-schema qualification, or real-process smoke receipt.
func TestReadCodexUsesGeneratedTransportWithoutInference(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverInput, clientInput := io.Pipe()
	clientOutput, serverOutput := io.Pipe()
	t.Cleanup(func() {
		_ = serverInput.Close()
		_ = clientInput.Close()
		_ = clientOutput.Close()
		_ = serverOutput.Close()
	})
	finished := make(chan nativeWireResult, 1)
	go func() {
		result := serveNativeCatalog(serverInput, serverOutput)
		_ = serverInput.Close()
		_ = serverOutput.Close()
		finished <- result
	}()
	var observed nativeWireResult
	inspection := modelcatalog.Inspection{
		Binary: "/owned-pipe-fixture/codex", ProviderVersion: "codex-cli 0.154.0",
		AssertUnchanged: func(context.Context) error { return nil },
		RunCommand: func(context.Context, modelcatalog.Command) (modelcatalog.CommandResult, error) {
			return successfulCommand("[]"), nil
		},
		Open: func(_ context.Context, options modelcatalog.OpenOptions) (modelcatalog.Session, error) {
			transport, err := codex.NewTransport(codex.Streams{Input: clientInput, Output: clientOutput},
				codex.Options{Protocol: catalogFixtureProtocol{}, OnRequest: options.OnRequest, RequestTimeout: 2 * time.Second})
			if err != nil {
				return nil, err
			}
			return &ownedPipeSession{Transport: transport, finish: func() error {
				select {
				case result := <-finished:
					observed = result
					return result.err
				case <-ctx.Done():
					return context.Cause(ctx)
				}
			}}, nil
		},
	}
	catalog, err := modelcatalog.ReadCodex(ctx, inspection, "/owned-pipe-workspace", nil)
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"models":[{"slug":"wire-first","display_name":"Wire first","visibility":"list","priority":0,"supported_reasoning_levels":[{"effort":"high"}]},{"slug":"wire-second","display_name":"Wire second","visibility":"hide","priority":1,"supported_reasoning_levels":[],"additional_speed_tiers":[]}]}`
	if !reflect.DeepEqual(catalog, decodeValue(t, expected)) || !observed.rejected || observed.pages != 2 {
		t.Fatalf("native transport metadata result changed: catalog=%v rejected=%t pages=%d", catalog, observed.rejected, observed.pages)
	}
	if !reflect.DeepEqual(observed.methods, []string{"initialize", "initialized", "model/list", "model/list"}) {
		t.Fatalf("metadata performed unexpected native work: %v", observed.methods)
	}
}

type ownedPipeSession struct {
	*codex.Transport
	finish func() error
}

func (s *ownedPipeSession) Close() error {
	return errors.Join(s.Transport.Close(), s.finish())
}

type nativeWireResult struct {
	methods  []string
	pages    int
	rejected bool
	err      error
}

func serveNativeCatalog(input io.Reader, output io.Writer) (observed nativeWireResult) {
	decoder, encoder := json.NewDecoder(input), json.NewEncoder(output)
	for {
		var message map[string]json.RawMessage
		if err := decoder.Decode(&message); err != nil {
			if !errors.Is(err, io.EOF) {
				observed.err = err
			}
			return observed
		}
		var method string
		if err := json.Unmarshal(message["method"], &method); err != nil {
			observed.err = err
			return observed
		}
		observed.methods = append(observed.methods, method)
		var response json.RawMessage
		switch method {
		case "initialize":
			response = json.RawMessage(`{"codexHome":"/owned-pipe-home","platformFamily":"unix","platformOs":"linux","userAgent":"catalog-fixture"}`)
		case "initialized":
			continue
		case "model/list":
			observed.pages++
			if err := assertNativePageParams(message["params"], observed.pages); err != nil {
				observed.err = err
				return observed
			}
			if observed.pages == 1 {
				if err := rejectNativeApproval(decoder, encoder); err != nil {
					observed.err = err
					return observed
				}
				observed.rejected = true
				response = json.RawMessage(`{"data":[{"id":"wire-first","model":"wire-first","displayName":"Wire first","description":"Metadata","hidden":false,"isDefault":true,"defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high","description":"High"}]}],"nextCursor":"second-page"}`)
			} else if observed.pages == 2 {
				response = json.RawMessage(`{"data":[{"id":"wire-second","model":"wire-second","displayName":"Wire second","description":"Metadata","hidden":true,"isDefault":false,"defaultReasoningEffort":"high","supportedReasoningEfforts":[],"additionalSpeedTiers":[]}],"nextCursor":null}`)
			} else {
				observed.err = errors.New("unexpected extra metadata page")
				return observed
			}
		default:
			observed.err = fmt.Errorf("metadata attempted native method %q", method)
			return observed
		}
		if err := encoder.Encode(map[string]any{"id": message["id"], "result": response}); err != nil {
			observed.err = err
			return observed
		}
	}
}

func assertNativePageParams(raw json.RawMessage, page int) error {
	var params map[string]json.RawMessage
	if err := json.Unmarshal(raw, &params); err != nil {
		return err
	}
	if string(params["includeHidden"]) != "true" || string(params["limit"]) != "100" {
		return errors.New("native model read omitted hidden models or page limit")
	}
	cursor, exists := params["cursor"]
	if page == 1 && exists || page == 2 && string(cursor) != `"second-page"` {
		return errors.New("native model cursor was not forwarded exactly")
	}
	return nil
}

func rejectNativeApproval(decoder *json.Decoder, encoder *json.Encoder) error {
	if err := encoder.Encode(map[string]any{"id": "metadata-approval", "method": "item/commandExecution/requestApproval", "params": map[string]any{"command": "never-execute"}}); err != nil {
		return err
	}
	var response struct {
		ID    string `json:"id"`
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := decoder.Decode(&response); err != nil {
		return err
	}
	if response.ID != "metadata-approval" || response.Error.Code != -32601 || response.Error.Message != "Model inspection cannot answer native requests." {
		return errors.New("metadata inspection did not reject native approval")
	}
	return nil
}

type catalogFixtureProtocol struct{}

func (catalogFixtureProtocol) ProviderVersion() string { return "codex-cli 0.154.0" }
func (catalogFixtureProtocol) Request(request codex.Request) error {
	if request.Method != "initialize" && request.Method != "model/list" {
		return errors.New("fixture rejects non-metadata request")
	}
	return nil
}
func (catalogFixtureProtocol) Notification(codex.Notification) error { return nil }
func (catalogFixtureProtocol) ServerRequest(request codex.Request) error {
	if request.Method != "item/commandExecution/requestApproval" {
		return errors.New("unexpected fixture server request")
	}
	return nil
}
func (catalogFixtureProtocol) Response(_ string, result json.RawMessage) error {
	if !json.Valid(result) {
		return errors.New("invalid fixture response")
	}
	return nil
}
func (catalogFixtureProtocol) ServerResponse(string, json.RawMessage) error { return nil }
