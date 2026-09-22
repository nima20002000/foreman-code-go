import { createHash } from 'node:crypto'
import type { AgentConfigurationVersion, WorkflowVersion } from '@graphql/contracts'
import type { WorkflowRelationship } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { resolveImmutableApprovalRoute, usesNativeSelfReview } from './approvalRoutes.js'

/**
 * Derive ONLY justified approval records from a prior accepted immutable version.
 * Does not persist a migration, rewrite execution edges, or read a current draft.
 * The execution-semantics migration must independently qualify legacy route rules.
 */
export function deriveLegacyApprovalRelationships(
  version: WorkflowVersion,
  configurations: readonly AgentConfigurationVersion[],
): readonly WorkflowRelationship[] {
  const graph = version.definition
  if ('executionSemanticsVersion' in version || 'executionSemanticsVersion' in graph
    || graph.edges.some((edge) => 'kind' in edge)
    || graph.workspaceId !== version.workspaceId || graph.id !== version.workflowId || graph.version !== version.version
    || graph.approval?.handler !== version.approval?.handler
    || graph.approval?.designatedOrchestratorAgentId !== version.approval?.designatedOrchestratorAgentId) {
    throw new DomainError('APPROVAL_MIGRATION_SOURCE_INVALID', 'Approval migration requires a consistent accepted legacy version.', 409)
  }
  if (version.approval?.handler !== 'orchestrator') return []
  const configs = new Map(configurations.map((configuration) => [configuration.id, configuration]))
  if (configs.size !== configurations.length) {
    throw new DomainError('APPROVAL_MIGRATION_SOURCE_INVALID', 'Approval configuration identities must be unambiguous.', 409)
  }
  for (const node of graph.nodes) {
    const configuration = configs.get(version.agentConfigurationVersionIds[node.agentId]!)
    if (!configuration || configuration.workspaceId !== version.workspaceId || configuration.agentId !== node.agentId) {
      throw new DomainError('APPROVAL_MIGRATION_SOURCE_INVALID', 'Approval migration requires the exact previously accepted configuration records.', 409)
    }
  }
  const reviewerId = version.approval.designatedOrchestratorAgentId!
  const reviewer = configs.get(version.agentConfigurationVersionIds[reviewerId]!)
  if (reviewer?.productRole !== 'orchestrator' || graph.nodes.filter((node) => node.agentId === reviewerId).length !== 1) {
    throw new DomainError('APPROVAL_MIGRATION_SOURCE_INVALID', 'The previously accepted reviewer must be unique and use its pinned Orchestrator role.', 409)
  }
  const existingIds = new Set(graph.edges.map((edge) => edge.id))
  const relationships: WorkflowRelationship[] = []
  for (const node of graph.nodes) {
    if (node.agentId === reviewerId || usesNativeSelfReview(configs.get(version.agentConfigurationVersionIds[node.agentId]!)!.harness)) continue
    const route = resolveImmutableApprovalRoute(version, node.id, node.agentId)
    if (!route) {
      throw new DomainError('APPROVAL_MIGRATION_SOURCE_INVALID', 'A transitive path or a different node occurrence cannot justify an approval assignment.', 409)
    }
    const id = 'approval:' + createHash('sha256')
      .update(JSON.stringify([version.id, route.orchestratorNodeId, route.requestingNodeId])).digest('hex')
    if (existingIds.has(id)) {
      throw new DomainError('APPROVAL_MIGRATION_ID_CONFLICT', 'The derived approval relationship ID collides with an existing record.', 409)
    }
    existingIds.add(id)
    relationships.push({ id, kind: 'approval', source: route.orchestratorNodeId, target: route.requestingNodeId })
  }
  return relationships
}
