package access

import (
	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// WorkerAction is the source policy's closed action argument, not a new grant.
type WorkerAction = contracts.ManagementAction

const (
	WorkerReadInteractions WorkerAction = "interactions:read"
	WorkerRespondInteractions WorkerAction = "interactions:respond"
	WorkerReportBug WorkerAction = "bug_reports:report"
)

// WorkerScopesForAction returns detached generated scope values containing only
// the three execution dimensions. They remain separate per grant.
func (p *Policy) WorkerScopesForAction(principal Principal, action WorkerAction) []contracts.ManagementGrantScope {
	result := make([]contracts.ManagementGrantScope, 0)
	_, hasAgent := principal.value.AgentID.Get()
	if !p.active(principal) || !hasAgent ||
		principal.value.Audience != contracts.ManagementPrincipalAudienceWorker {
		return result
	}
	if action != WorkerReadInteractions && action != WorkerRespondInteractions && action != WorkerReportBug {
		return result
	}
	for _, grant := range principal.value.Grants {
		workspaces, _ := grant.Scope.WorkspaceIDs.Get()
		workflows, _ := grant.Scope.WorkflowIDs.Get()
		runs, _ := grant.Scope.RunIDs.Get()
		if hasAction(grant, contracts.ManagementAction(action)) && len(workspaces) > 0 && len(workflows) > 0 && len(runs) > 0 {
			result = append(result, contracts.ManagementGrantScope{WorkspaceIDs: cloneOptional(grant.Scope.WorkspaceIDs),
				WorkflowIDs: cloneOptional(grant.Scope.WorkflowIDs), RunIDs: cloneOptional(grant.Scope.RunIDs)})
		}
	}
	return result
}

func (p *Policy) HasWorkerAction(principal Principal, action WorkerAction) bool {
	return len(p.WorkerScopesForAction(principal, action)) > 0
}

// WorkerScopeSummary is for context display only; authorization must use
// WorkerScopesForAction/CanReadInteraction rather than this union.
func (p *Policy) WorkerScopeSummary(principal Principal) (contracts.ManagementGrantScope, error) {
	_, hasAgent := principal.value.AgentID.Get()
	if !p.active(principal) || !hasAgent ||
		principal.value.Audience != contracts.ManagementPrincipalAudienceWorker {
		return contracts.ManagementGrantScope{}, domainerror.New("APP_ACCESS_DENIED", "The App caller is not authorized.", 403, nil)
	}
	var scopes []contracts.ManagementGrantScope
	for _, action := range []WorkerAction{WorkerReadInteractions, WorkerRespondInteractions, WorkerReportBug} {
		scopes = append(scopes, p.WorkerScopesForAction(principal, action)...)
	}
	if len(scopes) == 0 {
		return contracts.ManagementGrantScope{}, domainerror.New("APP_SCOPE_REQUIRED", "The App credential does not have an explicit execution scope.", 403, nil)
	}
	var workspaces, workflows, runs []contracts.ID
	for _, scope := range scopes {
		workspaceIDs, _ := scope.WorkspaceIDs.Get()
		workflowIDs, _ := scope.WorkflowIDs.Get()
		runIDs, _ := scope.RunIDs.Get()
		workspaces = appendUnique(workspaces, workspaceIDs)
		workflows = appendUnique(workflows, workflowIDs)
		runs = appendUnique(runs, runIDs)
	}
	return contracts.ManagementGrantScope{WorkspaceIDs: contracts.Some(workspaces),
		WorkflowIDs: contracts.Some(workflows), RunIDs: contracts.Some(runs)}, nil
}

func appendUnique[T identity](values []T, additions []T) []T {
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		seen[value.IdentityKey()] = true
	}
	for _, value := range additions {
		if !seen[value.IdentityKey()] {
			values = append(values, value)
			seen[value.IdentityKey()] = true
		}
	}
	return values
}

func workerMatches(scope contracts.ManagementGrantScope, resource Resource) bool {
	return includesOrUnscoped(scope.WorkspaceIDs, resource.WorkspaceID) &&
		includesOrUnscoped(scope.WorkflowIDs, resource.WorkflowID) &&
		includesOrUnscoped(scope.RunIDs, resource.RunID)
}

func (p *Policy) CanReadInteraction(principal Principal, resource Resource) bool {
	for _, scope := range p.WorkerScopesForAction(principal, WorkerReadInteractions) {
		if workerMatches(scope, resource) {
			return true
		}
	}
	return false
}

// InteractionAuthority closes over the domain's actual DurableInteraction and
// applies its Orchestrator/reviewer/self-review policy. The lane supplies it;
// absence or rejection never becomes permission.
type InteractionAuthority func(agentID contracts.ID, resource Resource) error

func (p *Policy) CanRespondToInteraction(principal Principal, resource Resource, authority InteractionAuthority) bool {
	agentID, hasAgent := principal.value.AgentID.Get()
	if !hasAgent || authority == nil || !p.CanReadInteraction(principal, resource) {
		return false
	}
	for _, scope := range p.WorkerScopesForAction(principal, WorkerRespondInteractions) {
		if workerMatches(scope, resource) {
			return authority(agentID, resource) == nil
		}
	}
	return false
}

// CanUserInteract preserves the source's separate approval-user authority. It
// never confers Operator or Worker powers and considers only execution scope.
func (p *Policy) CanUserInteract(principal Principal, action WorkerAction, resource Resource) bool {
	if !p.active(principal) || principal.value.Audience != contracts.ManagementPrincipalAudienceUser ||
		(action != WorkerReadInteractions && action != WorkerRespondInteractions) {
		return false
	}
	for _, grant := range principal.value.Grants {
		if hasAction(grant, contracts.ManagementAction(action)) && workerMatches(grant.Scope, resource) {
			return true
		}
	}
	return false
}
