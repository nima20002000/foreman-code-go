package httpserver_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

func contractErrorResponse(t *testing.T, failure error) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("GET /api/contract-error", httpserver.ErrorHandler{}.Wrap(func(http.ResponseWriter, *http.Request) error { return failure }))
	recorder := httptest.NewRecorder()
	httpserver.WithRequestID(mux).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/contract-error", nil))
	return recorder
}

func contractMember(t *testing.T, value any, key string) any {
	t.Helper()
	object, ok := value.(jsonvalue.Object)
	if !ok { t.Fatalf("expected object for %q, got %T", key, value) }
	wanted, err := jsonvalue.FromUTF8(key)
	if err != nil { t.Fatal(err) }
	for _, member := range object { if member.Key.Equal(wanted) { return member.Value } }
	t.Fatalf("missing member %q", key)
	return nil
}

func contractUnits(t *testing.T, value any, wanted []uint16) {
	t.Helper()
	actual, ok := value.(jsonvalue.UTF16String)
	if !ok || !actual.Equal(jsonvalue.UTF16String(wanted)) { t.Fatalf("UTF16 = %#v, want %#v", value, wanted) }
}

func TestContractErrorHTTPProjectsOrderedSharedIssues(t *testing.T) {
	failure := &contracts.ValidationError{SchemaID: "isolated.schema", Issues: []contracts.Issue{
		{Code: "custom", Path: []any{contracts.TextFromUTF16([]uint16{'x', 0xd800}), 2}, Message: contracts.TextFromUTF16([]uint16{'m', 0xdfff}),
			Properties: jsonvalue.Object{{Key: jsonvalue.UTF16String{'p'}, Value: true}}},
		{Code: "invalid_type", Path: []any{}, Message: contracts.TextFromUTF16([]uint16{'s', 'e', 'c', 'o', 'n', 'd'})},
	}}
	response := contractErrorResponse(t, failure)
	if response.Code != http.StatusBadRequest { t.Fatalf("shared validation status = %d, want 400; body = %s", response.Code, response.Body.String()) }
	parsed, err := jsonvalue.Parse(response.Body.Bytes())
	if err != nil { t.Fatal(err) }
	envelope := contractMember(t, parsed, "error")
	contractUnits(t, contractMember(t, envelope, "code"), []uint16{'I','N','V','A','L','I','D','_','R','E','Q','U','E','S','T'})
	requestID, ok := contractMember(t, envelope, "requestId").(jsonvalue.UTF16String)
	if !ok || len(requestID) == 0 { t.Fatal("public validation envelope lost request identity") }
	issues, ok := contractMember(t, contractMember(t, envelope, "details"), "issues").([]any)
	if !ok || len(issues) != 2 { t.Fatal("ordered source issues were dropped") }
	for _, issue := range issues { if object, ok := issue.(jsonvalue.Object); !ok || len(object) != 2 { t.Fatal("projection leaked schema/code/properties or lost path/message") } }
	path, ok := contractMember(t, issues[0], "path").([]any)
	if !ok || len(path) != 2 { t.Fatal("issue path changed") }
	contractUnits(t, path[0], []uint16{'x', 0xd800})
	if path[1] != json.Number("2") { t.Fatalf("numeric path = %#v", path[1]) }
	contractUnits(t, contractMember(t, issues[0], "message"), []uint16{'m', 0xdfff})
	contractUnits(t, contractMember(t, issues[1], "message"), []uint16{'s','e','c','o','n','d'})
	if empty, ok := contractMember(t, issues[1], "path").([]any); !ok || len(empty) != 0 { t.Fatal("empty issue path did not remain an array") }
}

func TestContractErrorHTTPKeepsWrappedAndSetupFailuresInternal(t *testing.T) {
	validation := &contracts.ValidationError{SchemaID: "test"}
	cases := []struct { name string; failure error }{
		{"wrapped_validation", fmt.Errorf("outer operation: %w", validation)},
		{"unsupported_schema", &contracts.SchemaSupportError{SchemaID: "test", Reason: "unsupported fixture"}},
		{"setup", fmt.Errorf("shared contract setup failed")},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			response := contractErrorResponse(t, scenario.failure)
			var envelope map[string]map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil { t.Fatal(err) }
			if response.Code != 500 || envelope["error"]["code"] != "INTERNAL_ERROR" || envelope["error"]["details"] != nil {
				t.Fatalf("non-direct validation was exposed: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestContractErrorHTTPPreservesDirectDomainFailure(t *testing.T) {
	failure := domainerror.New("ACCESS_DENIED", "The caller is not authorized for this operation and resource.", 403, map[string]any{"existing": true})
	response := contractErrorResponse(t, failure)
	var envelope map[string]map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil { t.Fatal(err) }
	if response.Code != 403 || envelope["error"]["code"] != "ACCESS_DENIED" { t.Fatalf("domain error changed: %d %s", response.Code, response.Body.String()) }
}

func TestContractErrorHTTPMapsGeneratedValidation(t *testing.T) {
	registry, err := contracts.NewGeneratedRegistry()
	if err != nil { t.Fatal(err) }
	_, failure := contracts.ParseManagementPrincipal(registry, json.RawMessage(`{"id":12}`))
	if _, ok := failure.(*contracts.ValidationError); !ok { t.Fatalf("generated fixture did not reach shared validation: %v", failure) }
	response := contractErrorResponse(t, failure)
	if response.Code != 400 { t.Fatalf("generated validation status = %d, want 400; body = %s", response.Code, response.Body.String()) }
	var envelope map[string]map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil { t.Fatal(err) }
	if envelope["error"]["message"] != "The request does not match its shared contract." { t.Fatalf("message = %#v", envelope["error"]["message"]) }
	details, ok := envelope["error"]["details"].(map[string]any)
	if !ok { t.Fatal("generated issue details missing") }
	issues, ok := details["issues"].([]any)
	if !ok || len(issues) == 0 { t.Fatal("generated issues missing") }
}
