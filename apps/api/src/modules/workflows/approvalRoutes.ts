import type { HarnessConfiguration, WorkflowVersion } from '@graphql/contracts'
import type { WorkflowDefinitionV2, WorkflowVersionV2 } from '@graphql/contracts/wave25'

/** These are immutable accepted versions, never a current editable workflow. */
export type ApprovalRouteVersion = WorkflowVersion | WorkflowVersionV2

export interface ImmutableApprovalRoute {
  workspaceId: string
  workflowId: string
  workflowVersionId: string
  requestingNodeId: string
  requestingAgentId: string
  requestingConfigurationVersionId: string
  /** Kept compatible with existing exact-occurrence authority consumers. */
  orchestratorNodeId: string
  reviewerAgentId: string
  reviewerConfigurationVersionId: string
  /** Only v2 has an explicit approval relationship identity. */
  relationshipId?: string
}

export function usesNativeSelfReview(configuration: HarnessConfiguration | undefined): boolean {
  return configuration?.harness === 'codex'
    && configuration.advanced?.approvalPolicy === 'on-request'
    && configuration.advanced.approvalsReviewer === 'auto_review'
}

/** Approval topology does not schedule, infer roles, select sessions, or grant access. */
export function hasSupportedApprovalTopology(version: WorkflowVersionV2): boolean {
  const graph = version.definition
  if (version.executionSemanticsVersion !== 2 || graph.executionSemanticsVersion !== 2
    || !graph.entryNodeId || graph.entryNodeId !== version.entryNodeId) return false
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  if (nodes.size !== graph.nodes.length
    || new Set(graph.nodes.map((node) => node.agentId)).size !== graph.nodes.length
    || new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length) return false
  const entry = nodes.get(version.entryNodeId)
  if (!entry) return false
  const assigned = new Set<string>()
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target) return false
    if (edge.kind === 'execution') {
      if (edge.target === entry.id) return false
      continue
    }
    if (edge.kind !== 'approval' || version.approval.handler !== 'orchestrator'
      || edge.source !== entry.id || edge.target === entry.id || assigned.has(edge.target)) return false
    assigned.add(edge.target)
  }
  return version.approval.handler !== 'orchestrator'
    || entry.agentId === version.approval.designatedOrchestratorAgentId
}

function ownPin(pins: Readonly<Record<string, string>>, id: string): string | undefined {
  return Object.hasOwn(pins, id) && typeof pins[id] === 'string' && pins[id]!.length > 0 ? pins[id] : undefined
}

/**
 * One fail-closed route resolver for acceptance, discovery and runtime authorization.
 * Callers must still validate pinned roles/configurations and live scopes, credentials,
 * revisions, ownership and exact sessions. A returned relationship is NOT a grant.
 *
 * Legacy accepted versions retain exact, undirected adjacency; v2 never falls back
 * to execution adjacency, transitive reachability, canvas order or another reviewer.
 */
export function resolveImmutableApprovalRoute(
  version: ApprovalRouteVersion,
  requestingNodeId: string,
  requestingAgentId: string,
): ImmutableApprovalRoute | undefined {
  const graph = version.definition
  const accepted = version.approval
  const selected = graph.approval
  if (!accepted || accepted.handler !== 'orchestrator'
    || selected?.handler !== accepted.handler
    || selected.designatedOrchestratorAgentId !== accepted.designatedOrchestratorAgentId
    || version.workspaceId !== graph.workspaceId || version.workflowId !== graph.id
    || version.version !== graph.version) return undefined
  const reviewerId = accepted.designatedOrchestratorAgentId
  if (!reviewerId || reviewerId === requestingAgentId) return undefined
  const requesters = graph.nodes.filter((node) => node.id === requestingNodeId)
  const reviewers = graph.nodes.filter((node) => node.agentId === reviewerId)
  if (requesters.length !== 1 || reviewers.length !== 1) return undefined
  const requester = requesters[0]!
  const reviewer = reviewers[0]!
  if (requester.agentId !== requestingAgentId || requester.id === reviewer.id) return undefined
  const requestingPin = ownPin(version.agentConfigurationVersionIds, requester.agentId)
  const reviewerPin = ownPin(version.agentConfigurationVersionIds, reviewer.agentId)
  if (!requestingPin || !reviewerPin) return undefined

  let relationshipId: string | undefined
  if ('executionSemanticsVersion' in version) {
    if (version.executionSemanticsVersion !== 2 || !hasSupportedApprovalTopology(version)) return undefined
    const relationship = version.definition.edges.find((edge) => edge.kind === 'approval'
      && edge.source === reviewer.id && edge.target === requester.id)
    if (!relationship) return undefined
    relationshipId = relationship.id
  } else {
    // A partially upgraded/mixed record cannot acquire legacy adjacency authority.
    if ('executionSemanticsVersion' in graph || graph.edges.some((edge) => 'kind' in edge)) return undefined
    if (!graph.edges.some((edge) => (edge.source === reviewer.id && edge.target === requester.id)
      || (edge.source === requester.id && edge.target === reviewer.id))) return undefined
  }
  return {
    workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    requestingNodeId: requester.id, requestingAgentId: requester.agentId,
    requestingConfigurationVersionId: requestingPin,
    orchestratorNodeId: reviewer.id, reviewerAgentId: reviewer.agentId,
    reviewerConfigurationVersionId: reviewerPin,
    ...(relationshipId === undefined ? {} : { relationshipId }),
  }
}

/** Explicit entry selection is available only on the frozen v2 definition. */
export function isApprovalDefinitionV2(
  definition: WorkflowVersion['definition'] | WorkflowDefinitionV2,
): definition is WorkflowDefinitionV2 {
  return 'executionSemanticsVersion' in definition && definition.executionSemanticsVersion === 2
}
