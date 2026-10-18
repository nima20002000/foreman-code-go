package access_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/access"
	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

var accessNow = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

func newPolicy(t *testing.T) *access.Policy {
	t.Helper()
	registry, err := contracts.NewGeneratedRegistry()
	if err != nil {
		t.Fatal(err)
	}
	policy, err := access.NewPolicy(registry, func() time.Time { return accessNow })
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func textID(t *testing.T, value string) contracts.ID {
	t.Helper()
	text, err := contracts.TextFromUTF8(value)
	if err != nil {
		t.Fatal(err)
	}
	return text
}

func principal(t *testing.T, policy *access.Policy, audience, grants string) access.Principal {
	t.Helper()
	agent := ""
	if audience == "worker" {
		agent = `,"agentId":"agent-test"`
	}
	raw := fmt.Sprintf(`{"id":"principal-test","name":"test","audience":%q%s,"grants":%s,"expiresAt":"2026-10-19T00:00:00.000Z","revokedAt":null}`, audience, agent, grants)
	value, err := policy.ParsePrincipal(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestAccessOperatorRequiresEveryScopeInOneGrant(t *testing.T) {
	policy := newPolicy(t)
	uuid := "11111111-1111-4111-8111-111111111111"
	dimensions := []struct {
		name string
		set func(*access.Resource, contracts.Text)
	}{
		{"workspaceIds", func(r *access.Resource, id contracts.Text) { r.WorkspaceID = contracts.Some(id) }},
		{"workflowIds", func(r *access.Resource, id contracts.Text) { r.WorkflowID = contracts.Some(id) }},
		{"runIds", func(r *access.Resource, id contracts.Text) { r.RunID = contracts.Some(id) }},
		{"mainIds", func(r *access.Resource, id contracts.Text) { r.MainID = contracts.Some(id) }},
		{"deviceIds", func(r *access.Resource, id contracts.Text) { r.DeviceID = contracts.Some(id) }},
		{"applicationInstallationIds", func(r *access.Resource, id contracts.Text) { r.ApplicationInstallationID = contracts.Some(id) }},
		{"providerAccountIds", func(r *access.Resource, id contracts.Text) { r.ProviderAccountID = contracts.Some(id) }},
	}
	for _, dimension := range dimensions {
		t.Run(dimension.name, func(t *testing.T) {
			grants := fmt.Sprintf(`[{"actions":["capabilities:read"],"scope":{%q:[%q]}}]`, dimension.name, uuid)
			p := principal(t, policy, "operator", grants)
			var resource access.Resource
			if policy.IsAuthorized(p, "capabilities:read", resource) {
				t.Fatal("missing requested dimension matched a restricted grant")
			}
			dimension.set(&resource, textID(t, uuid))
			if !policy.IsAuthorized(p, "capabilities:read", resource) {
				t.Fatal("matching requested dimension did not authorize")
			}
			dimension.set(&resource, textID(t, "22222222-2222-4222-8222-222222222222"))
			if policy.IsAuthorized(p, "capabilities:read", resource) {
				t.Fatal("different identifier matched a restricted grant")
			}
			empty := principal(t, policy, "operator", fmt.Sprintf(`[{"actions":["capabilities:read"],"scope":{%q:[]}}]`, dimension.name))
			if policy.IsAuthorized(empty, "capabilities:read", resource) {
				t.Fatal("empty scope restriction became unscoped")
			}
		})
	}
	p := principal(t, policy, "operator", `[
		{"actions":["runs:read"],"scope":{"workspaceIds":["w1"],"runIds":["r1"]}},
		{"actions":["runs:read"],"scope":{"workspaceIds":["w2"],"runIds":["r2"]}}]`)
	if policy.IsAuthorized(p, "runs:read", access.Resource{WorkspaceID: contracts.Some(textID(t, "w1")), RunID: contracts.Some(textID(t, "r2"))}) {
		t.Fatal("scope dimensions were spliced across separate grants")
	}
}

func TestAccessCatalogVisibilityStillRequiresResourceAuthorization(t *testing.T) {
	policy := newPolicy(t)
	p := principal(t, policy, "operator", `[{"actions":["runs:read"],"scope":{"runIds":["r1"]}}]`)
	if !policy.HasAction(p, "runs:read") || policy.IsAuthorized(p, "runs:read", access.Resource{}) || policy.HasAction(p, "runs:stop") {
		t.Fatal("catalog visibility was confused with execution authority")
	}
	request := httptest.NewRequest(http.MethodGet, "/api/runs/missing", nil)
	recorder := httptest.NewRecorder()
	httpserver.ErrorHandler{}.Wrap(func(http.ResponseWriter, *http.Request) error {
		return policy.Require(p, "runs:stop", access.Resource{})
	}).ServeHTTP(recorder, request)
	var outcome struct { Error struct { Code, Message string } }
	if err := json.Unmarshal(recorder.Body.Bytes(), &outcome); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != 403 || outcome.Error.Code != "ACCESS_DENIED" ||
		outcome.Error.Message != "The caller is not authorized for this operation and resource." {
		t.Fatalf("public denial = %d %s", recorder.Code, recorder.Body.Bytes())
	}
}

func TestAccessAudiencesRevocationAndExpiryRemainSeparate(t *testing.T) {
	policy := newPolicy(t)
	for _, audience := range []string{"operator", "worker", "user"} {
		p := principal(t, policy, audience, `[{"actions":["capabilities:read"],"scope":{}}]`)
		if got := policy.IsAuthorized(p, "capabilities:read", access.Resource{}); got != (audience == "operator") {
			t.Fatalf("audience %s operator authority = %v", audience, got)
		}
	}
	base := principal(t, policy, "operator", `[{"actions":["capabilities:read"],"scope":{}}]`).Generated()
	for _, change := range []func(*contracts.ManagementPrincipal){
		func(p *contracts.ManagementPrincipal) { p.ExpiresAt = textID(t, "2026-10-18T12:00:00.000Z") },
		func(p *contracts.ManagementPrincipal) { p.RevokedAt = contracts.Present(textID(t, "2026-10-17T00:00:00Z")) },
	} {
		changed := base
		change(&changed)
		p, err := policy.Snapshot(changed)
		if err != nil { t.Fatal(err) }
		if policy.HasAction(p, "capabilities:read") || policy.IsAuthorized(p, "capabilities:read", access.Resource{}) {
			t.Fatal("expired-at-boundary or revoked principal retained authority")
		}
	}
}

func TestAccessSnapshotDetachesMutableGrantAndScopeArrays(t *testing.T) {
	policy := newPolicy(t)
	parsed := principal(t, policy, "operator", `[{"actions":["runs:read"],"scope":{"runIds":["r1"]}}]`)
	input := parsed.Generated()
	snapshot, err := policy.Snapshot(input)
	if err != nil { t.Fatal(err) }
	input.Grants[0].Actions[0] = "runs:stop"
	ids, _ := input.Grants[0].Scope.RunIDs.Get()
	ids[0] = textID(t, "r2")
	returned := snapshot.Generated()
	returned.Grants[0].Actions[0] = "runs:stop"
	returnedIDs, _ := returned.Grants[0].Scope.RunIDs.Get()
	returnedIDs[0] = textID(t, "r2")
	r1 := access.Resource{RunID: contracts.Some(textID(t, "r1"))}
	if !policy.IsAuthorized(snapshot, "runs:read", r1) || policy.IsAuthorized(snapshot, "runs:stop", r1) {
		t.Fatal("mutable input or returned generated values changed the authorization snapshot")
	}
	reparsed, err := policy.Snapshot(input)
	if err != nil { t.Fatal(err) }
	if !policy.IsAuthorized(reparsed, "runs:stop", access.Resource{RunID: contracts.Some(textID(t, "r2"))}) {
		t.Fatal("mutable source values reused an earlier validation cache")
	}
}

func TestAccessLosslessPrincipalAndScopeIdentity(t *testing.T) {
	policy := newPolicy(t)
	raw := `{"id":"\ud800","name":" test ","audience":"operator","grants":[{"actions":["runs:read"],"scope":{"runIds":["\ud800"]}}],"expiresAt":"2026-10-19T00:00:00Z","revokedAt":null}`
	p, err := policy.ParsePrincipal(json.RawMessage(raw))
	if err != nil { t.Fatal(err) }
	lone := contracts.TextFromUTF16([]uint16{0xd800})
	replacement := textID(t, "\ufffd")
	if p.IdentityKey() != lone.IdentityKey() || p.IdentityKey() == replacement.IdentityKey() {
		t.Fatal("principal identity replaced or collapsed UTF16 units")
	}
	if !policy.IsAuthorized(p, "runs:read", access.Resource{RunID: contracts.Some(lone)}) ||
		policy.IsAuthorized(p, "runs:read", access.Resource{RunID: contracts.Some(replacement)}) {
		t.Fatal("scope identity replaced or collapsed UTF16 units")
	}
	name, err := p.Generated().Name.UTF8()
	if err != nil || name != "test" { t.Fatalf("generated normalization = %q, %v", name, err) }
}

func TestAccessWorkerNeedsOneCompleteExecutionGrant(t *testing.T) {
	policy := newPolicy(t)
	for _, grants := range []string{
		`[{"actions":["interactions:read"],"scope":{}}]`,
		`[{"actions":["interactions:read"],"scope":{"workspaceIds":["w"],"workflowIds":["f"]}},{"actions":["interactions:read"],"scope":{"runIds":["r"]}}]`,
		`[{"actions":["interactions:read"],"scope":{"workspaceIds":[],"workflowIds":["f"],"runIds":["r"]}}]`,
	} {
		p := principal(t, policy, "worker", grants)
		if policy.HasWorkerAction(p, access.WorkerReadInteractions) { t.Fatal("incomplete execution grant authorized a Worker") }
	}
	p := principal(t, policy, "worker", `[{"actions":["interactions:read"],"scope":{"workspaceIds":["w"],"workflowIds":["f"],"runIds":["r"]}}]`)
	if !policy.HasWorkerAction(p, access.WorkerReadInteractions) || policy.HasWorkerAction(p, access.WorkerRespondInteractions) {
		t.Fatal("Worker action visibility did not preserve explicit source grants")
	}
}

func executionResource(t *testing.T, workspace, workflow, run string) access.Resource {
	t.Helper()
	return access.Resource{WorkspaceID: contracts.Some(textID(t, workspace)),
		WorkflowID: contracts.Some(textID(t, workflow)), RunID: contracts.Some(textID(t, run))}
}

func TestAccessWorkerResponseRequiresReadAndDomainAuthority(t *testing.T) {
	policy := newPolicy(t)
	p := principal(t, policy, "worker", `[{"actions":["interactions:read","interactions:respond"],"scope":{"workspaceIds":["w"],"workflowIds":["f"],"runIds":["r"]}}]`)
	resource := executionResource(t, "w", "f", "r")
	if !policy.CanReadInteraction(p, resource) || policy.CanRespondToInteraction(p, resource, nil) {
		t.Fatal("response skipped mandatory domain authority")
	}
	called := 0
	authority := func(agent contracts.ID, received access.Resource) error {
		called++
		if !agent.Equal(textID(t, "agent-test")) { t.Fatal("domain authority received a different Agent subject") }
		return errors.New("fixture reviewer denial")
	}
	if policy.CanRespondToInteraction(p, resource, authority) || called != 1 { t.Fatal("domain denial was discarded") }
	if !policy.CanRespondToInteraction(p, resource, func(contracts.ID, access.Resource) error { return nil }) {
		t.Fatal("same-resource read/respond plus domain authority did not authorize")
	}
	if policy.CanRespondToInteraction(p, executionResource(t, "w", "f", "other"), authority) || called != 1 {
		t.Fatal("wrong resource reached domain authority")
	}
}

func TestAccessWorkerSummaryDoesNotSpliceAuthorization(t *testing.T) {
	policy := newPolicy(t)
	p := principal(t, policy, "worker", `[
		{"actions":["interactions:read"],"scope":{"workspaceIds":["w1"],"workflowIds":["f1"],"runIds":["r1"]}},
		{"actions":["interactions:read","bug_reports:report"],"scope":{"workspaceIds":["w2"],"workflowIds":["f2"],"runIds":["r2"]}}]`)
	summary, err := policy.WorkerScopeSummary(p)
	if err != nil { t.Fatal(err) }
	ids, present := summary.RunIDs.Get()
	if !present || len(ids) != 2 || !ids[0].Equal(textID(t, "r1")) || !ids[1].Equal(textID(t, "r2")) {
		t.Fatalf("context scope summary = %#v", ids)
	}
	if policy.CanReadInteraction(p, executionResource(t, "w1", "f1", "r2")) { t.Fatal("display union became authority") }
	ids[0] = textID(t, "outside")
	if !policy.CanReadInteraction(p, executionResource(t, "w1", "f1", "r1")) { t.Fatal("display mutation changed authority") }
}

func TestAccessApprovalUserNeverBecomesOperatorOrWorker(t *testing.T) {
	policy := newPolicy(t)
	p := principal(t, policy, "user", `[{"actions":["interactions:read","interactions:respond","capabilities:read"],"scope":{}}]`)
	if !policy.CanUserInteract(p, access.WorkerReadInteractions, access.Resource{}) ||
		!policy.CanUserInteract(p, access.WorkerRespondInteractions, access.Resource{}) {
		t.Fatal("source unscoped approval-user interaction authority was lost")
	}
	if policy.HasAction(p, "capabilities:read") || policy.HasWorkerAction(p, access.WorkerReadInteractions) ||
		policy.CanReadInteraction(p, executionResource(t, "w", "f", "r")) {
		t.Fatal("approval user acquired another audience's authority")
	}
}

func TestAccessDelegationIntersectsActionsAndEveryScope(t *testing.T) {
	policy := newPolicy(t)
	issued := principal(t, policy, "operator", `[{"actions":["runs:read","runs:read","runs:stop"],"scope":{"workspaceIds":["w1","w2","w1"],"runIds":["r1"]}}]`).Generated()
	current := principal(t, policy, "operator", `[
		{"actions":["runs:read"],"scope":{"workspaceIds":["w1"],"runIds":["r1"]}},
		{"actions":["runs:stop"],"scope":{"workspaceIds":["w2"],"runIds":["r2"]}}]`).Generated()
	grants := access.IntersectGrants(issued.Grants, current.Grants)
	if len(grants) != 1 || len(grants[0].Actions) != 2 || grants[0].Actions[0] != "runs:read" || grants[0].Actions[1] != "runs:read" {
		t.Fatalf("action intersection/order = %#v", grants)
	}
	ids, _ := grants[0].Scope.WorkspaceIDs.Get()
	if len(ids) != 2 || !ids[0].Equal(textID(t, "w1")) || !ids[1].Equal(textID(t, "w1")) { t.Fatal("left scope order/duplicates changed") }
	ids[0] = textID(t, "mutated")
	originalIDs, _ := issued.Grants[0].Scope.WorkspaceIDs.Get()
	if !originalIDs[0].Equal(textID(t, "w1")) { t.Fatal("intersection shares its caller's mutable scope") }
	unscoped := principal(t, policy, "operator", `[{"actions":["runs:read"],"scope":{}}]`).Generated()
	if result := access.IntersectGrants(unscoped.Grants, current.Grants); len(result) != 1 { t.Fatal("absent scope did not retain the other restriction") }
}

func TestAccessTimestampPrecisionAndOffsetBoundaries(t *testing.T) {
	policy := newPolicy(t)
	base := principal(t, policy, "operator", `[{"actions":["capabilities:read"],"scope":{}}]`).Generated()
	for _, test := range []struct { name, expires string; accepted, active bool }{
		{"exact", "2026-10-18T12:00:00Z", true, false},
		{"submillisecond", "2026-10-18T12:00:00.000999999999Z", true, false},
		{"next_millisecond", "2026-10-18T12:00:00.001000000001Z", true, true},
		{"offset_same_instant", "2026-10-18T14:00:00+02:00", true, false},
		{"offset_next_millisecond", "2026-10-18T10:00:00.001-02:00", true, true},
		{"minute_precision", "2026-10-18T12:01Z", false, false},
		{"compact_offset", "2026-10-18T14:00:00+0200", false, false},
		{"year_zero", "0000-01-01T00:00:00Z", true, false},
		{"far_future", "9999-12-31T23:59:59.999Z", true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := base
			value.ExpiresAt = textID(t, test.expires)
			p, err := policy.Snapshot(value)
			if (err == nil) != test.accepted { t.Fatalf("schema acceptance = %v, error %v", err == nil, err) }
			if err == nil && policy.HasAction(p, "capabilities:read") != test.active { t.Fatal("millisecond authorization boundary differs") }
		})
	}
}

func TestAccessZeroValuesFailClosed(t *testing.T) {
	if _, err := access.NewPolicy(nil, nil); err == nil { t.Fatal("missing generated registry was accepted") }
	var policy access.Policy
	if policy.HasAction(access.Principal{}, "capabilities:read") || policy.IsAuthorized(access.Principal{}, "capabilities:read", access.Resource{}) {
		t.Fatal("zero policy or principal authorized")
	}
	if (access.Principal{}).IdentityKey() != "" { t.Fatal("zero principal supplied an identity") }
}
