package modelcatalog_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/modelcatalog"
)

// This public regression targets the first authored reader, whose final
// cancellation check discarded the caller's cause after successful cleanup.
func TestReadCodexPreservesCancellationCauseAfterCleanup(t *testing.T) {
	cause := errors.New("caller canceled metadata inspection")
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	closed := 0
	code := 0
	session := &cancelDuringCloseSession{close: func() error {
		closed++
		cancel(cause)
		return nil
	}}
	inspection := modelcatalog.Inspection{
		Binary: "/owned-fixture/codex", ProviderVersion: "codex-cli 0.154.0",
		AssertUnchanged: func(context.Context) error { return nil },
		RunCommand: func(context.Context, modelcatalog.Command) (modelcatalog.CommandResult, error) {
			return modelcatalog.CommandResult{ExitCode: &code, Stdout: "[]"}, nil
		},
		Open: func(context.Context, modelcatalog.OpenOptions) (modelcatalog.Session, error) { return session, nil },
	}
	catalog, err := modelcatalog.ReadCodex(ctx, inspection, "/owned-fixture/workspace", nil)
	if !errors.Is(err, cause) {
		t.Fatalf("cancellation cause was lost: got %v, want original cause %v", err, cause)
	}
	if catalog != nil || closed != 1 {
		t.Fatalf("canceled read published catalog or missed cleanup: catalog=%v closes=%d", catalog, closed)
	}
}

type cancelDuringCloseSession struct{ close func() error }

func (*cancelDuringCloseSession) Start(context.Context) error { return nil }
func (*cancelDuringCloseSession) ListModels(context.Context, protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
	return protocol.V2ModelListResponse{Data: []*protocol.V2Model{}, NextCursor: protocol.Null[string]()}, nil
}
func (*cancelDuringCloseSession) Reject(context.Context, json.RawMessage, int, string) error {
	return errors.New("unexpected native request")
}
func (s *cancelDuringCloseSession) Close() error { return s.close() }
