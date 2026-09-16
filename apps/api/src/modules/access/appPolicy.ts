import type { DurableInteraction } from '@graphql/contracts'
import { ManagementPrincipalSchema, type ManagementAction, type ManagementPrincipal } from '@graphql/contracts/management'

import { DomainError } from '../errors.js'
import { assertOrchestratorInteractionAuthority } from '../interactions/authorization.js'

export interface WorkerScope {
  workspaceIds?: readonly string[]
  workflowIds?: readonly string[]
  runIds?: readonly string[]
}

export function hasWorkerAction(principal: ManagementPrincipal, action: Extract<ManagementAction, 'interactions:read' | 'interactions:respond'>): boolean {
  const parsed = ManagementPrincipalSchema.parse(principal)
  return parsed.audience === 'worker' && !parsed.revokedAt && Date.parse(parsed.expiresAt) > Date.now()
    && parsed.grants.some((grant) => grant.actions.includes(action))
}

function includes(values: readonly string[] | undefined, value: string): boolean {
  return values === undefined || values.includes(value)
}

/** App policy is intentionally independent from Operator management actions. */
export function workerScope(principal: ManagementPrincipal): WorkerScope {
  const parsed = ManagementPrincipalSchema.parse(principal)
  if (parsed.audience !== 'worker' || !parsed.agentId || parsed.revokedAt
    || Date.parse(parsed.expiresAt) <= Date.now()) {
    throw new DomainError('APP_ACCESS_DENIED', 'The App caller is not authorized.', 403)
  }
  const workspaceIds = new Set<string>()
  const workflowIds = new Set<string>()
  const runIds = new Set<string>()
  for (const grant of parsed.grants) {
    if (grant.scope.workspaceIds) grant.scope.workspaceIds.forEach((id) => workspaceIds.add(id))
    if (grant.scope.workflowIds) grant.scope.workflowIds.forEach((id) => workflowIds.add(id))
    if (grant.scope.runIds) grant.scope.runIds.forEach((id) => runIds.add(id))
  }
  if (workspaceIds.size === 0 || workflowIds.size === 0 || runIds.size === 0) {
    throw new DomainError('APP_SCOPE_REQUIRED', 'The App credential does not have an explicit execution scope.', 403)
  }
  return {
    workspaceIds: [...workspaceIds],
    workflowIds: [...workflowIds],
    runIds: [...runIds],
  }
}

export function canReadInteraction(principal: ManagementPrincipal, interaction: DurableInteraction): boolean {
  if (!hasWorkerAction(principal, 'interactions:read')) return false
  const scope = workerScope(principal)
  return includes(scope.workspaceIds, interaction.workspaceId)
    && includes(scope.workflowIds, interaction.workflowId)
    && includes(scope.runIds, interaction.runId)
}

export function canRespondToInteraction(principal: ManagementPrincipal, interaction: DurableInteraction): boolean {
  if (!hasWorkerAction(principal, 'interactions:respond') || !canReadInteraction(principal, interaction) || !principal.agentId) return false
  try {
    assertOrchestratorInteractionAuthority(interaction, {
      agentId: principal.agentId,
      workspaceId: interaction.workspaceId,
      workflowId: interaction.workflowId,
    })
    return true
  } catch {
    return false
  }
}

export function requireReadableInteraction(principal: ManagementPrincipal, interaction: DurableInteraction | undefined): DurableInteraction {
  if (!interaction || !canReadInteraction(principal, interaction)) {
    throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
  }
  return interaction
}

export function requireRespondableInteraction(principal: ManagementPrincipal, interaction: DurableInteraction | undefined): DurableInteraction {
  if (!interaction || !canRespondToInteraction(principal, interaction)) {
    // Deliberately non-enumerating: wrong workflow, reviewer, and self-review look absent.
    throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
  }
  return interaction
}
