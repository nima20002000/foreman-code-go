import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import {
  AcceptedWorkflowApprovalConfigurationSchema,
  CodexSessionCompatibilitySchema,
  validateHarnessWorkflowCompatibility,
  type HarnessConfiguration,
  type WorkflowApprovalConfiguration,
} from '@foreman-code/contracts'

import { DomainError } from '../errors.js'
import { CLAUDE_FULL_ACCESS_REQUIRED, CLAUDE_EXTERNAL_MCP_UNSUPPORTED,
  ClaudeSupportedMcpServersSchema } from '@foreman-code/contracts/claude'

export function assertClaudeFullAccess(configuration: HarnessConfiguration): void {
  if (configuration.harness !== 'claude') return
  if (configuration.sandbox !== 'danger-full-access') {
    throw new DomainError('CLAUDE_FULL_ACCESS_REQUIRED', CLAUDE_FULL_ACCESS_REQUIRED, 400)
  }
  if (!ClaudeSupportedMcpServersSchema.safeParse(configuration.mcpServers).success) {
    throw new DomainError('CLAUDE_EXTERNAL_MCP_UNSUPPORTED', CLAUDE_EXTERNAL_MCP_UNSUPPORTED, 400)
  }
}

/** Approval authority is explicit; missing legacy fields never select another transport. */
export function assertNativeWorkflowConfiguration(
  configuration: HarnessConfiguration,
  approval?: WorkflowApprovalConfiguration,
  designatedOrchestrator = false,
): void {
  if (configuration.harness === 'opencode') throw new DomainError('HARNESS_RETIRED',
    RETIRED_OPENCODE_MESSAGE, 409)
  assertClaudeFullAccess(configuration)
  if (approval && !AcceptedWorkflowApprovalConfigurationSchema.safeParse(approval).success) {
    throw new DomainError('WORKFLOW_APPROVAL_INCOMPLETE', 'Reopen and save the workflow with complete approval settings before starting it.', 409)
  }
  try { validateHarnessWorkflowCompatibility(configuration, approval?.handler, designatedOrchestrator) }
  catch {
    throw new DomainError('WORKFLOW_HARNESS_APPROVAL_CONFLICT', 'The Agent configuration is invalid or native automatic handling conflicts with routed workflow approval. Reopen and save the Agent and workflow settings.', 409)
  }
  if (approval && approval.handler !== 'native') {
    if (configuration.harness === 'codex'
      && !CodexSessionCompatibilitySchema.safeParse({ configuration, requiresResume: true }).success) {
      throw new DomainError('WORKFLOW_HARNESS_APPROVAL_CONFLICT', 'Routed approval requires a resumable Codex session. Reopen and save the Agent with persistent sessions.', 409)
    }
    return
  }
  if (configuration.harness === 'codex'
    && (configuration.advanced?.approvalPolicy === 'never' || configuration.advanced?.approvalsReviewer === 'auto_review')) return
  throw new DomainError(
    'NATIVE_APPROVAL_CONFIGURATION_REQUIRED',
    'This workflow has no accepted approval handler and its Agent may ask for permission. Reopen and save the workflow with a routed handler, or explicitly configure native approval handling on the Agent. No approval authority or automatic approval was inferred.',
    409,
  )
}
