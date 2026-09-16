import {
  AcceptedWorkflowApprovalConfigurationSchema,
  type AcceptedWorkflowApprovalConfiguration,
  type Agent,
  type WorkflowApprovalConfiguration,
  type WorkflowDefinition,
} from '@graphql/contracts'

import { DomainError } from '../errors.js'

/** Validate accepted authority from durable Agent records, never display role strings or graph edges. */
export function validateWorkflowApproval(
  definition: WorkflowDefinition,
  approval: WorkflowApprovalConfiguration,
  agents: readonly Agent[],
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
  return accepted.data
}
