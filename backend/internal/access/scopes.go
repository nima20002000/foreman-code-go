package access

import "github.com/nima20002000/foreman-code-go/backend/internal/contracts"

type identity interface { IdentityKey() string }

func includesOrUnscoped[T identity](values contracts.Optional[[]T], value contracts.Optional[T]) bool {
	allowed, scoped := values.Get()
	if !scoped {
		return true
	}
	wanted, present := value.Get()
	if !present {
		return false
	}
	for _, candidate := range allowed {
		if candidate.IdentityKey() == wanted.IdentityKey() {
			return true
		}
	}
	return false
}

func matchesScope(scope contracts.ManagementGrantScope, resource Resource) bool {
	return includesOrUnscoped(scope.WorkspaceIDs, resource.WorkspaceID) &&
		includesOrUnscoped(scope.WorkflowIDs, resource.WorkflowID) &&
		includesOrUnscoped(scope.RunIDs, resource.RunID) &&
		includesOrUnscoped(scope.MainIDs, resource.MainID) &&
		includesOrUnscoped(scope.DeviceIDs, resource.DeviceID) &&
		includesOrUnscoped(scope.ApplicationInstallationIDs, resource.ApplicationInstallationID) &&
		includesOrUnscoped(scope.ProviderAccountIDs, resource.ProviderAccountID)
}

func hasAction(grant contracts.ManagementGrant, action contracts.ManagementAction) bool {
	for _, candidate := range grant.Actions {
		if candidate == action {
			return true
		}
	}
	return false
}

func cloneOptional[T any](value contracts.Optional[[]T]) contracts.Optional[[]T] {
	items, present := value.Get()
	if !present {
		return value
	}
	copy := make([]T, len(items))
	copy = append(copy[:0], items...)
	return contracts.Some(copy)
}

func cloneScope(value contracts.ManagementGrantScope) contracts.ManagementGrantScope {
	value.WorkspaceIDs = cloneOptional(value.WorkspaceIDs)
	value.WorkflowIDs = cloneOptional(value.WorkflowIDs)
	value.RunIDs = cloneOptional(value.RunIDs)
	value.MainIDs = cloneOptional(value.MainIDs)
	value.DeviceIDs = cloneOptional(value.DeviceIDs)
	value.ApplicationInstallationIDs = cloneOptional(value.ApplicationInstallationIDs)
	value.ProviderAccountIDs = cloneOptional(value.ProviderAccountIDs)
	return value
}

func cloneGrants(values []contracts.ManagementGrant) []contracts.ManagementGrant {
	copy := make([]contracts.ManagementGrant, len(values))
	for index, value := range values {
		copy[index] = value
		copy[index].Actions = append([]contracts.ManagementAction{}, value.Actions...)
		copy[index].Scope = cloneScope(value.Scope)
	}
	return copy
}

func clonePrincipal(value contracts.ManagementPrincipal) contracts.ManagementPrincipal {
	value.Grants = cloneGrants(value.Grants)
	return value
}

func intersectOptional[T identity](left, right contracts.Optional[[]T]) contracts.Optional[[]T] {
	l, hasLeft := left.Get()
	r, hasRight := right.Get()
	if !hasLeft {
		return cloneOptional(right)
	}
	if !hasRight {
		return cloneOptional(left)
	}
	keys := make(map[string]bool, len(r))
	for _, value := range r {
		keys[value.IdentityKey()] = true
	}
	result := make([]T, 0, len(l))
	for _, value := range l {
		if keys[value.IdentityKey()] {
			result = append(result, value)
		}
	}
	return contracts.Some(result)
}

func emptyRestriction[T any](value contracts.Optional[[]T]) bool {
	items, present := value.Get()
	return present && len(items) == 0
}

// IntersectGrants preserves the source cross-product, left action/ID order and
// duplicates. Restrictions remain in the same grant; empty intersections remove
// the grant. It never manufactures an action or expands a scope.
func IntersectGrants(issued, current []contracts.ManagementGrant) []contracts.ManagementGrant {
	result := make([]contracts.ManagementGrant, 0)
	for _, left := range issued {
		for _, right := range current {
			actions := make([]contracts.ManagementAction, 0)
			for _, action := range left.Actions {
				if hasAction(right, action) {
					actions = append(actions, action)
				}
			}
			if len(actions) == 0 {
				continue
			}
			scope := contracts.ManagementGrantScope{
				WorkspaceIDs: intersectOptional(left.Scope.WorkspaceIDs, right.Scope.WorkspaceIDs),
				WorkflowIDs: intersectOptional(left.Scope.WorkflowIDs, right.Scope.WorkflowIDs),
				RunIDs: intersectOptional(left.Scope.RunIDs, right.Scope.RunIDs),
				MainIDs: intersectOptional(left.Scope.MainIDs, right.Scope.MainIDs),
				DeviceIDs: intersectOptional(left.Scope.DeviceIDs, right.Scope.DeviceIDs),
				ApplicationInstallationIDs: intersectOptional(left.Scope.ApplicationInstallationIDs, right.Scope.ApplicationInstallationIDs),
				ProviderAccountIDs: intersectOptional(left.Scope.ProviderAccountIDs, right.Scope.ProviderAccountIDs),
			}
			if emptyRestriction(scope.WorkspaceIDs) || emptyRestriction(scope.WorkflowIDs) ||
				emptyRestriction(scope.RunIDs) || emptyRestriction(scope.MainIDs) || emptyRestriction(scope.DeviceIDs) ||
				emptyRestriction(scope.ApplicationInstallationIDs) || emptyRestriction(scope.ProviderAccountIDs) {
				continue
			}
			result = append(result, contracts.ManagementGrant{Actions: actions, Scope: scope})
		}
	}
	return result
}
