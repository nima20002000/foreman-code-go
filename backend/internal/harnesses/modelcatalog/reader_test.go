package modelcatalog_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/modelcatalog"
)

type recordedSession struct {
	start  func(context.Context) error
	list   func(context.Context, protocol.V2ModelListParams) (protocol.V2ModelListResponse, error)
	reject func(context.Context, json.RawMessage, int, string) error
	close  func() error
}

func (s *recordedSession) Start(ctx context.Context) error { return s.start(ctx) }
func (s *recordedSession) ListModels(ctx context.Context, params protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
	return s.list(ctx, params)
}
func (s *recordedSession) Reject(ctx context.Context, id json.RawMessage, code int, message string) error {
	return s.reject(ctx, id, code, message)
}
func (s *recordedSession) Close() error { return s.close() }

type readerFixture struct {
	inspection modelcatalog.Inspection
	session    *recordedSession
	checks     int
	starts     int
	closes     int
	reads      []protocol.V2ModelListParams
	commands   []modelcatalog.Command
	opens      []modelcatalog.OpenOptions
}

func newReaderFixture() *readerFixture {
	f := &readerFixture{}
	f.session = &recordedSession{
		start: func(context.Context) error { f.starts++; return nil },
		list: func(_ context.Context, params protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
			f.reads = append(f.reads, params)
			return protocol.V2ModelListResponse{Data: []*protocol.V2Model{}, NextCursor: protocol.Null[string]()}, nil
		},
		reject: func(context.Context, json.RawMessage, int, string) error { return errors.New("unexpected native request") },
		close:  func() error { f.closes++; return nil },
	}
	f.inspection = modelcatalog.Inspection{
		Binary: "/owned-native/codex", ProviderVersion: "codex-cli 0.154.0",
		AssertUnchanged: func(context.Context) error { f.checks++; return nil },
		RunCommand: func(_ context.Context, command modelcatalog.Command) (modelcatalog.CommandResult, error) {
			f.commands = append(f.commands, command)
			return successfulCommand("[]"), nil
		},
		Open: func(_ context.Context, options modelcatalog.OpenOptions) (modelcatalog.Session, error) {
			f.opens = append(f.opens, options)
			return f.session, nil
		},
	}
	return f
}

func nativeModel(slug string) *protocol.V2Model {
	return &protocol.V2Model{Model: slug, DisplayName: "Native " + slug,
		SupportedReasoningEfforts: []*protocol.V2ReasoningEffortOption{{ReasoningEffort: "high"}}}
}

func requireReaderInvalid(t *testing.T, err error) {
	t.Helper()
	requireCatalogError(t, err, "CODEX_MODEL_CATALOG_INVALID",
		"Codex codex-cli 0.154.0 does not satisfy the model/list catalog response contract.", false)
}

func TestReadCodexMetadataPages(t *testing.T) {
	f := newReaderFixture()
	first, second := nativeModel("first"), nativeModel("second")
	first.Hidden = true
	first.AdditionalSpeedTiers = protocol.Some([]string{"fast"})
	f.session.list = func(_ context.Context, params protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
		f.reads = append(f.reads, params)
		if len(f.reads) == 1 {
			return protocol.V2ModelListResponse{Data: []*protocol.V2Model{first}, NextCursor: protocol.Some("next")}, nil
		}
		return protocol.V2ModelListResponse{Data: []*protocol.V2Model{second}, NextCursor: protocol.Some("")}, nil
	}
	catalog, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil)
	want := `{"models":[{"slug":"first","display_name":"Native first","visibility":"hide","priority":0,"supported_reasoning_levels":[{"effort":"high"}],"additional_speed_tiers":["fast"]},{"slug":"second","display_name":"Native second","visibility":"list","priority":1,"supported_reasoning_levels":[{"effort":"high"}]}]}`
	if err != nil || !reflect.DeepEqual(catalog, decodeValue(t, want)) {
		t.Fatalf("wrong complete catalog: %v / %v", catalog, err)
	}
	if f.checks != 2 || f.starts != 1 || f.closes != 1 || len(f.reads) != 2 {
		t.Fatalf("wrong metadata lifecycle: checks=%d starts=%d closes=%d reads=%d", f.checks, f.starts, f.closes, len(f.reads))
	}
	for index, params := range f.reads {
		hidden, present, null := params.IncludeHidden.Value()
		limit, limited, limitNull := params.Limit.Value()
		cursor, cursored, cursorNull := params.Cursor.Value()
		if !hidden || !present || null || limit != 100 || !limited || limitNull || cursorNull ||
			index == 0 && cursored || index == 1 && (!cursored || cursor != "next") {
			t.Fatalf("wrong native model/list params on page %d: %+v", index, params)
		}
	}
}

func TestReadCodexPaginationBounds(t *testing.T) {
	for _, mode := range []string{"empty continuation", "repeated cursor", "exact bound", "over bound"} {
		t.Run(mode, func(t *testing.T) {
			f := newReaderFixture()
			f.session.list = func(_ context.Context, params protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
				f.reads = append(f.reads, params)
				if mode == "empty continuation" {
					return protocol.V2ModelListResponse{Data: []*protocol.V2Model{}, NextCursor: protocol.Some("more")}, nil
				}
				if mode == "repeated cursor" {
					return protocol.V2ModelListResponse{Data: []*protocol.V2Model{nativeModel(fmt.Sprint(len(f.reads)))}, NextCursor: protocol.Some("repeated")}, nil
				}
				count := 10_000
				if mode == "over bound" {
					count++
				}
				models := make([]*protocol.V2Model, count)
				for index := range models {
					models[index] = nativeModel(fmt.Sprint(index))
				}
				return protocol.V2ModelListResponse{Data: models, NextCursor: protocol.Null[string]()}, nil
			}
			catalog, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil)
			if mode == "exact bound" {
				if err != nil || catalog == nil {
					t.Fatalf("exact native model bound rejected: %v", err)
				}
			} else {
				requireReaderInvalid(t, err)
				if catalog != nil {
					t.Fatal("invalid pagination published a partial catalog")
				}
			}
			if f.closes != 1 || len(f.reads) > 2 {
				t.Fatalf("metadata paging did not close promptly: closes=%d reads=%d", f.closes, len(f.reads))
			}
		})
	}
}

func TestReadCodexRejectsMalformedTypedModels(t *testing.T) {
	cases := map[string][]*protocol.V2Model{
		"null data": nil,
		"null model": {nil},
		"missing levels": {{Model: "model"}},
		"null level": {{Model: "model", SupportedReasoningEfforts: []*protocol.V2ReasoningEffortOption{nil}}},
		"empty slug": {nativeModel("")},
		"duplicate models": {nativeModel("same"), nativeModel("same")},
		"empty effort": {{Model: "model", SupportedReasoningEfforts: []*protocol.V2ReasoningEffortOption{{ReasoningEffort: ""}}}},
		"null speed tiers": {{Model: "model", SupportedReasoningEfforts: []*protocol.V2ReasoningEffortOption{}, AdditionalSpeedTiers: protocol.Null[[]string]()}},
	}
	for name, models := range cases {
		t.Run(name, func(t *testing.T) {
			f := newReaderFixture()
			f.session.list = func(context.Context, protocol.V2ModelListParams) (protocol.V2ModelListResponse, error) {
				return protocol.V2ModelListResponse{Data: models, NextCursor: protocol.Null[string]()}, nil
			}
			catalog, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil)
			requireReaderInvalid(t, err)
			if catalog != nil || f.closes != 1 {
				t.Fatalf("malformed native response published or leaked: catalog=%v closes=%d", catalog, f.closes)
			}
		})
	}
}

func TestReadCodexMetadataIsolation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		configured string
		disabled   []string
	}{
		{"none", `[]`, []string{}},
		{"supported", `[{"name":"graphql"},{"name":"foreman-code"}]`, []string{"foreman-code", "graphql"}},
		{"legacy and unrelated", `[{"name":"other-server"},{"name":"graphql-operator"},{"name":"graphql-app"}]`, []string{"graphql-app", "graphql-operator"}},
		{"duplicate and empty", `[{"name":"foreman-code"},{"name":"foreman-code"},{"name":""}]`, []string{"foreman-code"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newReaderFixture()
			source := map[string]string{"CODEX_HOME": "/owned-provider-home", "OPENAI_API_KEY": "provider-fixture-key",
				"FOREMAN_CODE_MCP_TOKEN": "scoped-token", "GRAPHQL_MCP_TOKEN": "legacy-token", "NODE_OPTIONS": "controller-loader",
				"JOB_DISPATCH_DATABASE_URL": "controller-db", "PGPASSWORD": "db-password", "OPERATOR_SECRET": "operator-secret",
				"GRAPHQL_OPERATOR_OWNER": "owner", "FOREMAN_CODE_APP_STATE": "state", "FOREMAN_CODE_TEST_OWNER": "test-owner",
				"GRAPHQL_PRODUCTION_DB_PASSWORD": "legacy-db", "FOREMAN_CODE_PRODUCTION_DB_PASSWORD": "current-db", "NO_COLOR": "0"}
			original := make(map[string]string, len(source))
			for key, value := range source {
				original[key] = value
			}
			f.inspection.RunCommand = func(_ context.Context, command modelcatalog.Command) (modelcatalog.CommandResult, error) {
				f.commands = append(f.commands, command)
				return successfulCommand(tc.configured), nil
			}
			_, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", source)
			if err != nil || len(f.commands) != 1 || len(f.opens) != 1 {
				t.Fatalf("metadata setup failed: %v", err)
			}
			command, options := f.commands[0], f.opens[0]
			if command.Binary != f.inspection.Binary || command.Directory != "/owned-workspace" ||
				!reflect.DeepEqual(command.Arguments, []string{"mcp", "list", "--json"}) || options.Binary != command.Binary ||
				options.Directory != command.Directory || !reflect.DeepEqual(options.DisabledMCPNames, tc.disabled) {
				t.Fatalf("wrong native metadata invocation: %+v / %+v", command, options)
			}
			for _, environment := range []map[string]string{command.Environment, options.Environment} {
				if environment["CODEX_HOME"] != source["CODEX_HOME"] || environment["OPENAI_API_KEY"] != source["OPENAI_API_KEY"] || environment["NO_COLOR"] != "1" {
					t.Fatal("owning provider environment was not retained")
				}
				for key := range source {
					if key != "CODEX_HOME" && key != "OPENAI_API_KEY" && key != "NO_COLOR" {
						if _, delivered := environment[key]; delivered {
							t.Fatalf("controller variable was delivered: %s", key)
						}
					}
				}
			}
			if options.Environment["RUST_LOG"] != "codex_models_manager=error,codex_core::models_manager=error" || !reflect.DeepEqual(source, original) {
				t.Fatal("metadata logging policy or caller environment changed")
			}
		})
	}
}

func TestReadCodexRefusesInvalidMCPInspection(t *testing.T) {
	for _, raw := range []string{"{", "{}", "[null]", `[{"name":2}]`, "[" + strings.Repeat(`{"name":"a"},`, 500) + `{"name":"a"}]`} {
		f := newReaderFixture()
		f.inspection.RunCommand = func(context.Context, modelcatalog.Command) (modelcatalog.CommandResult, error) { return successfulCommand(raw), nil }
		catalog, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil)
		requireCatalogError(t, err, "CODEX_MCP_INSPECTION_FAILED", "Codex MCP configuration inspection failed; absence was not established.", false)
		if catalog != nil || len(f.opens) != 0 || f.starts != 0 {
			t.Fatal("invalid MCP configuration started metadata transport")
		}
	}
	for _, code := range []*int{nil, newInt(2)} {
		f := newReaderFixture()
		f.inspection.RunCommand = func(context.Context, modelcatalog.Command) (modelcatalog.CommandResult, error) {
			return modelcatalog.CommandResult{ExitCode: code, Stdout: "[]", Stderr: "private provider detail"}, nil
		}
		_, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil)
		requireCatalogError(t, err, "CODEX_MCP_INSPECTION_FAILED", "Codex MCP configuration inspection failed; absence was not established.", false)
		if len(f.opens) != 0 {
			t.Fatal("failed MCP probe opened a session")
		}
	}
	// The exact frozen limit remains usable; repeated names do not increase it.
	f := newReaderFixture()
	f.inspection.RunCommand = func(context.Context, modelcatalog.Command) (modelcatalog.CommandResult, error) {
		return successfulCommand("[" + strings.Repeat(`{"name":"a"},`, 499) + `{"name":"a"}]`), nil
	}
	if _, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil); err != nil {
		t.Fatalf("exact MCP inspection bound rejected: %v", err)
	}
}

func TestReadCodexRejectsNativeRequests(t *testing.T) {
	f := newReaderFixture()
	requests := 0
	f.session.start = func(ctx context.Context) error {
		return f.opens[0].OnRequest(ctx, codex.Request{ID: json.RawMessage(`"native-request"`), Method: "item/commandExecution/requestApproval"})
	}
	f.session.reject = func(_ context.Context, id json.RawMessage, code int, message string) error {
		requests++
		if string(id) != `"native-request"` || code != -32601 || message != "Model inspection cannot answer native requests." {
			t.Fatalf("wrong native metadata rejection: id=%s code=%d message=%q", id, code, message)
		}
		return nil
	}
	if _, err := modelcatalog.ReadCodex(context.Background(), f.inspection, "/owned-workspace", nil); err != nil || requests != 1 || f.closes != 1 {
		t.Fatalf("metadata callback failed: error=%v requests=%d closes=%d", err, requests, f.closes)
	}
}
