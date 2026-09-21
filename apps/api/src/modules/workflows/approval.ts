import {
  AcceptedWorkflowApprovalConfigurationSchema,
  directApprovalConnection,
  type AcceptedWorkflowApprovalConfiguration,
  type Agent,
  type WorkflowApprovalConfiguration,
  type WorkflowDefinition,
  type WorkflowVersion,
} from '@graphql/contracts'

import { DomainError } from '../errors.js'
import { validateReviewerBootstrap } from './reviewerBootstrap.js'

/** Role/designation checks. Each routed request additionally needs a direct edge in its Run version. */
export function validateWorkflowApproval(
  definition: WorkflowDefinition,
  approval: WorkflowApprovalConfiguration,
  agents: readonly Pick<Agent, 'id' | 'productRole' | 'harnessConfiguration'>[],
): AcceptedWorkflowApprovalConfiguration {
  const accepted = AcceptedWorkflowApprovalConfigurationSchema.safeParse(approval)
  if (!accepted.success) {
    throw new DomainError('WORKFLOW_APPROVAL_INCOMPLETE', 'Executable workflow approval settings are incomplete or invalid.', 409)
  }
  const referenced = new Set(definition.nodes.map((node) => node.agentId))
  const durable = new Map(agents.map((agent) => [agent.id, agent]))
  if (accepted.data.handler !== 'orchestrator') return accepted.data
  const designatedId = accepted.data.designatedOrchestratorAgentId!
  if (!referenced.has(designatedId)) {
    throw new DomainError('APPROVAL_ORCHESTRATOR_WRONG_WORKFLOW', 'The designated Orchestrator must belong to this workflow.', 409)
  }
  if (durable.get(designatedId)?.productRole !== 'orchestrator') {
    throw new DomainError('APPROVAL_ORCHESTRATOR_ROLE_REQUIRED', 'The designated approval Agent is not an Orchestrator.', 409)
  }
  const distinctCoder = [...referenced].some((id) => id !== designatedId && durable.get(id)?.productRole === 'coder')
  if (!distinctCoder) {
    throw new DomainError('APPROVAL_DISTINCT_CODER_REQUIRED', 'Orchestrator-handled workflows require a distinct Coder.', 409)
  }
  validateReviewerBootstrap(definition, accepted.data, durable.get(designatedId)?.harnessConfiguration)
  for (const node of definition.nodes) {
    if (node.agentId === designatedId) continue
    const configuration = durable.get(node.agentId)?.harnessConfiguration
    // Explicit native Codex self-review is per node, not a workflow-wide bypass.
    if (configuration?.harness === 'codex' && configuration.advanced?.approvalPolicy === 'on-request'
      && configuration.advanced.approvalsReviewer === 'auto_review') continue
    if (!directApprovalConnection(definition, node.id, node.agentId, designatedId)) {
      throw new DomainError('APPROVAL_DIRECT_CONNECTION_REQUIRED',
        'Every node using routed approval needs a direct edge to the designated Orchestrator. A transitive path does not grant approval authority.',
        409, { workflowNodeId: node.id })
    }
  }
  return accepted.data
}

/** Missing in both places is legacy; a configured version must never silently lose its authority. */
export function acceptedRunApproval(version: WorkflowVersion): AcceptedWorkflowApprovalConfiguration | undefined {
  const selection = version.definition.approval
  const accepted = version.approval
  if (!selection && !accepted) return undefined
  if (!selection || !accepted || selection.handler !== accepted.handler
    || selection.designatedOrchestratorAgentId !== accepted.designatedOrchestratorAgentId
    || (accepted.designatedOrchestratorAgentId
      && !version.definition.nodes.some((node) => node.agentId === accepted.designatedOrchestratorAgentId))) {
    throw new DomainError('WORKFLOW_APPROVAL_SNAPSHOT_INVALID', 'The saved approval snapshot is inconsistent. Save the workflow again before starting it.', 409)
  }
  return AcceptedWorkflowApprovalConfigurationSchema.parse(accepted)
}
