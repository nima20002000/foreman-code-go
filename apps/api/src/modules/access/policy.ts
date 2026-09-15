import {
  ManagementPrincipalSchema,
  type ManagementAction,
  type ManagementPrincipal,
} from '@graphql/contracts/management'

import { DomainError } from '../errors.js'

export interface AuthorizedResource {
  workspaceId?: string
  workflowId?: string
  runId?: string
}

function includesOrUnscoped(values: string[] | undefined, value: string | undefined): boolean {
  if (!values) return true
  return value !== undefined && values.includes(value)
}

export function isAuthorized(
  input: ManagementPrincipal,
  action: ManagementAction,
  resource: AuthorizedResource = {},
  now = new Date(),
): boolean {
  const principal = ManagementPrincipalSchema.parse(input)
  if (principal.audience !== 'operator' || principal.revokedAt || Date.parse(principal.expiresAt) <= now.getTime()) return false
  return principal.grants.some((grant) => grant.actions.includes(action)
    && includesOrUnscoped(grant.scope.workspaceIds, resource.workspaceId)
    && includesOrUnscoped(grant.scope.workflowIds, resource.workflowId)
    && includesOrUnscoped(grant.scope.runIds, resource.runId))
}

export function hasAction(principal: ManagementPrincipal, action: ManagementAction): boolean {
  const parsed = ManagementPrincipalSchema.parse(principal)
  return parsed.audience === 'operator' && !parsed.revokedAt && Date.parse(parsed.expiresAt) > Date.now()
    && parsed.grants.some((grant) => grant.actions.includes(action))
}

export function requireAuthorization(
  principal: ManagementPrincipal,
  action: ManagementAction,
  resource: AuthorizedResource = {},
): void {
  if (!isAuthorized(principal, action, resource)) {
    throw new DomainError('ACCESS_DENIED', 'The caller is not authorized for this operation and resource.', 403)
  }
}
