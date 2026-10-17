package placement_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/placement"
)

const choicesPattern = "GET /api/management/workspaces/{workspaceId}/workflows/{workflowId}/nodes/{nodeId}/placement-choices"
const choicesPath = "/api/management/workspaces/workspace-a/workflows/workflow-a/nodes/node-a/placement-choices"
const readbackPattern = "GET /api/management/workspaces/{workspaceId}/workflows/{workflowId}/runs/{runId}/nodes/{nodeId}/placement"
const readbackPath = "/api/management/workspaces/workspace-a/workflows/workflow-a/runs/run-a/nodes/node-a/placement"

func placementRoute(pattern string, handler httpserver.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle(pattern, (httpserver.ErrorHandler{}).Wrap(handler))
	return httpserver.WithRequestID(mux)
}

func requirePrivateRead(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("Cache-Control = %q, want private, no-store", got)
	}
	if got := recorder.Header().Get("Vary"); got != "Authorization, Cookie" {
		t.Errorf("Vary = %q, want Authorization, Cookie", got)
	}
}

func TestPlacementChoicesRejectQueryScopeOverrides(t *testing.T) {
	for _, query := range []string{
		"workspaceId=another-workspace",
		"workflowId=another-workflow",
		"nodeId=another-node",
		"workspaceId=workspace-a",
		"workflowId=workflow-a",
		"nodeId=node-a",
		"workspaceId=",
		"workflowId",
		"nodeId=node-a&nodeId=another-node",
		"agentConfigurationVersionId=configuration-a&%77orkspaceId=workspace-a",
		"workspaceId=%ZZ",
		"workflowId=%",
	} {
		t.Run(query, func(t *testing.T) {
			route := placementRoute(choicesPattern, placement.ChoicesHTTP(func(w http.ResponseWriter, _ *http.Request) error {
				return httpserver.WriteJSON(w, http.StatusOK, "discovery must not run")
			}))
			recorder := httptest.NewRecorder()
			route.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, choicesPath+"?"+query, nil))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("response = %d %s, want scope rejection", recorder.Code, recorder.Body.String())
			}
			var envelope struct {
				Error map[string]any `json:"error"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Error["code"] != "RESOURCE_ID_MISMATCH" ||
				envelope.Error["message"] != "Placement choice scope must be supplied in the URL." ||
				envelope.Error["requestId"] == "" || envelope.Error["requestId"] == nil {
				t.Fatalf("unexpected public error: %s", recorder.Body.String())
			}
			requirePrivateRead(t, recorder)
		})
	}
}

func TestPlacementChoicesPreserveDiscoveryInputs(t *testing.T) {
	route := placementRoute(choicesPattern, placement.ChoicesHTTP(func(w http.ResponseWriter, r *http.Request) error {
		// These are a test handler's observations, not copied placement DTOs.
		return httpserver.WriteJSON(w, http.StatusOK, []string{
			r.PathValue("workspaceId"), r.PathValue("workflowId"), r.PathValue("nodeId"),
			r.URL.Query().Get("agentConfigurationVersionId"), r.Header.Get("Authorization"),
		})
	}))
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, choicesPath+"?agentConfigurationVersionId=configuration-a", nil)
	request.Header.Set("Authorization", "Bearer isolated-test-caller")
	route.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("response = %d %s, want discovery input readback", recorder.Code, recorder.Body.String())
	}
	var got []string
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := []string{"workspace-a", "workflow-a", "node-a", "configuration-a", "Bearer isolated-test-caller"}
	if len(got) != len(want) {
		t.Fatalf("discovery inputs = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("discovery inputs = %#v, want %#v", got, want)
		}
	}
	requirePrivateRead(t, recorder)
}

func TestPlacementReadResponsesKeepPrivateCachePolicy(t *testing.T) {
	for _, routeCase := range []struct {
		name    string
		pattern string
		path    string
		wrap    func(httpserver.Handler) httpserver.Handler
	}{
		{name: "accepted placement", pattern: readbackPattern, path: readbackPath, wrap: placement.ReadbackHTTP},
		{name: "placement choices", pattern: choicesPattern, path: choicesPath, wrap: placement.ChoicesHTTP},
	} {
		for _, fail := range []bool{false, true} {
			name := routeCase.name + " success"
			if fail {
				name = routeCase.name + " failure"
			}
			t.Run(name, func(t *testing.T) {
				route := placementRoute(routeCase.pattern, routeCase.wrap(func(w http.ResponseWriter, _ *http.Request) error {
					if fail {
						return domainerror.New("RUN_NOT_FOUND", "Run not found in this workspace and workflow.", 404, nil)
					}
					return httpserver.WriteJSON(w, http.StatusOK, "isolated read result")
				}))
				recorder := httptest.NewRecorder()
				recorder.Header().Set("Cache-Control", "public, max-age=600")
				recorder.Header().Set("Vary", "Accept-Encoding")
				route.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, routeCase.path, nil))
				status := http.StatusOK
				if fail {
					status = http.StatusNotFound
				}
				if recorder.Code != status {
					t.Fatalf("response = %d %s, want status %d", recorder.Code, recorder.Body.String(), status)
				}
				requirePrivateRead(t, recorder)
			})
		}
	}
}
