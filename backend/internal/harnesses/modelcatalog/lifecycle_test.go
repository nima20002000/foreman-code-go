package modelcatalog_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/modelcatalog"
)

func TestReadCodexFailureLifecycle(t *testing.T) {
	for _, phase := range []string{"initial identity", "MCP command", "open", "start", "page", "final identity"} {
		t.Run(phase, func(t *testing.T) {
			f := newReaderFixture()
			failure := errors.New("private " + phase + " failure")
			switch phase {
			case "initial identity":
				f.inspection.AssertUnchanged = func(context.Context) error { return failure }
			case "MCP command":
				f.inspection.RunCommand = func(context.Context, modelcatalog.Command) (modelcatalog.CommandResult, error) {
					return modelcatalog.CommandResult{}, failure
				}
			case "open":
				f.inspection.Open = func(context.Context, modelcatalog.OpenOptions) (modelcatalog.Session, error) { return nil, failure }
			case "start":
				f.session.start = func(context.Context) error { return failure }
			case "page":
				f.session.list = func(context.Context, protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
					return protocol.V2ModelListResponse{}, failure
				}
			case "final identity":
				f.inspection.AssertUnchanged = func(context.Context) error {
					f.checks++
					if f.checks == 2 {
						return failure
					}
					return nil
				}
			}
			catalog, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil)
			if err != failure || catalog != nil {
				t.Fatalf("failure identity or atomic publication changed: got %v / %v", err, catalog)
			}
			owned := phase == "start" || phase == "page" || phase == "final identity"
			if owned && f.closes != 1 || !owned && f.closes != 0 {
				t.Fatalf("wrong owned cleanup count: %d", f.closes)
			}
			if phase == "initial identity" && (len(f.commands) != 0 || len(f.opens) != 0) {
				t.Fatal("native process work started before installation identity was established")
			}
		})
	}
}

func TestReadCodexCleanupPrecedence(t *testing.T) {
	for _, mode := range []string{"cleanup only", "read and cleanup", "cancellation and cleanup"} {
		t.Run(mode, func(t *testing.T) {
			f := newReaderFixture()
			inspectionFailure := errors.New("private inspection failure")
			cleanupFailure := errors.New("private physical cleanup failure")
			ctx, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			if mode == "read and cleanup" {
				f.session.list = func(context.Context, protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
					return protocol.V2ModelListResponse{}, inspectionFailure
				}
			}
			f.session.close = func() error {
				f.closes++
				if mode == "cancellation and cleanup" {
					cancel(inspectionFailure)
				}
				return cleanupFailure
			}
			catalog, err := modelcatalog.ReadCodex(ctx, f.inspection, "/owned-workspace", nil)
			if catalog != nil || f.closes != 1 {
				t.Fatal("failed cleanup published metadata or did not run exactly once")
			}
			if mode == "read and cleanup" {
				var combined *modelcatalog.CleanupError
				if !errors.As(err, &combined) || combined.Error() != "Native model inspection and cleanup failed." ||
					!errors.Is(err, inspectionFailure) || !errors.Is(err, cleanupFailure) || combined.CleanupCause != cleanupFailure {
					t.Fatalf("dual failure identity/message changed: %v", err)
				}
			} else if err != cleanupFailure {
				t.Fatalf("cleanup failure lost precedence: %v", err)
			}
		})
	}
}

func TestReadCodexCancellationDuringPageRead(t *testing.T) {
	f := newReaderFixture()
	cause := errors.New("caller canceled active metadata page")
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	f.session.list = func(active context.Context, _ protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
		if active != ctx {
			t.Fatal("caller context did not reach the native page read")
		}
		cancel(cause)
		return protocol.V2ModelListResponse{}, context.Cause(active)
	}
	catalog, err := modelcatalog.ReadCodex(ctx, f.inspection, "/owned-workspace", nil)
	if !errors.Is(err, cause) || catalog != nil || f.closes != 1 {
		t.Fatalf("canceled page lost its cause, published, or missed cleanup: %v / %v / %d", err, catalog, f.closes)
	}
}

func TestReadCodexRefreshAfterCleanup(t *testing.T) {
	for _, phase := range []string{"page", "close"} {
		t.Run(phase, func(t *testing.T) {
			f := newReaderFixture()
			warning := func() {
				done := make(chan struct{})
				go func() { f.opens[0].OnRefreshFailure(); close(done) }()
				<-done
			}
			if phase == "page" {
				f.session.list = func(context.Context, protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
					warning()
					return protocol.V2ModelListResponse{Data: []*protocol.V2Model{}, NextCursor: protocol.Null[string]()}, nil
				}
			}
			f.session.close = func() error {
				f.closes++
				if phase == "close" {
					warning()
				}
				return nil
			}
			catalog, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil)
			if err != nil || f.closes != 1 || !reflect.DeepEqual(catalog, decodeValue(t, `{"models":[],"modelCatalogSource":"cached"}`)) {
				t.Fatalf("late native refresh warning lost: catalog=%v error=%v closes=%d", catalog, err, f.closes)
			}
		})
	}
}

func TestReadCodexRefreshDoesNotHideInvalidMetadata(t *testing.T) {
	f := newReaderFixture()
	f.session.list = func(context.Context, protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
		f.opens[0].OnRefreshFailure()
		return protocol.V2ModelListResponse{Data: []*protocol.V2Model{nativeModel("")}}, nil
	}
	catalog, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil)
	requireReaderInvalid(t, err)
	if catalog != nil || f.closes != 1 {
		t.Fatal("refresh warning hid invalid metadata or missed cleanup")
	}
}
