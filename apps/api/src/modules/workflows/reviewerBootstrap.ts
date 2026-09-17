import type { HarnessConfiguration, WorkflowApprovalConfiguration, WorkflowDefinition } from '@graphql/contracts'
import { DomainError } from '../errors.js'

/** Reject an unavailable reviewer before launch. Never change native permissions to make it work. */
export function validateReviewerBootstrap(
  definition: WorkflowDefinition,
  approval: WorkflowApprovalConfiguration,
  configuration: HarnessConfiguration | undefined,
): void {
  if (approval.handler !== 'orchestrator') return
  const nodes = definition.nodes.filter((node) => node.agentId === approval.designatedOrchestratorAgentId)
  const reviewer = nodes[0]
  if (nodes.length !== 1 || !reviewer || definition.nodes[0]?.id !== reviewer.id
    || definition.edges.some((edge) => edge.target === reviewer.id)) {
    throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_ORDER',
      'The designated Orchestrator must appear once as the entry step, before every Coder. A downstream or repeated reviewer cannot handle bootstrap approvals.', 409)
  }
  // The executable topology boundary additionally requires a reachable DAG with all joins.
  // `never` refuses escalation; it does not broaden the accepted sandbox or writable roots.
  const noninteractive = configuration?.harness === 'codex'
    ? configuration.advanced?.approvalPolicy === 'never'
    : configuration?.harness === 'opencode' && !configuration.autoApprove
      && configuration.advanced?.permissionHandling === 'graphql_routed'
      && configuration.advanced.permissionRules.some((rule) => rule.permission === '*' && rule.pattern === '*' && rule.effect === 'deny')
      && configuration.advanced.permissionRules.every((rule) => rule.effect !== 'ask')
  if (!noninteractive) {
    throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_INTERACTIVE',
      'The initial Orchestrator cannot review its own approval. Explicitly choose Codex approvalPolicy=never or an OpenCode deny-default policy with no ask rules, or select a User/Operator workflow handler. No settings were changed automatically.', 409)
  }
}
