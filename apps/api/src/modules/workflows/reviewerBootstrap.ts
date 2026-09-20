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
  // A Codex reviewer with approvalPolicy=never cannot call the destructive
  // interaction_respond App MCP tool; on-request would need another reviewer.
  if (configuration?.harness === 'codex') {
    throw new DomainError('APPROVAL_CODEX_REVIEW_UNSUPPORTED',
      'Codex cannot automatically respond to its assigned App MCP approval under the required noninteractive bootstrap policy. Choose an OpenCode Orchestrator with explicit App MCP tool grants, or another approval handler.', 409)
  }
  const rules = configuration?.harness === 'opencode' ? configuration.advanced?.permissionRules : undefined
  const noninteractive = configuration?.harness === 'opencode' && !configuration.autoApprove
    && configuration.advanced?.permissionHandling === 'graphql_routed'
    && rules?.[0]?.permission === '*' && rules[0].pattern === '*' && rules[0].effect === 'deny'
    && (rules ?? []).every((rule, index) => rule.effect !== 'ask' && (index === 0 || rule.permission !== '*'))
  if (!noninteractive) {
    throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_INTERACTIVE',
      'The initial Orchestrator cannot review its own approval. Choose an OpenCode deny-default policy with no ask rules, or select a User/Operator workflow handler. No settings were changed automatically.', 409)
  }
  // OpenCode V1 exposes the hyphenated server name in its permission action.
  // These final rules cannot be shadowed by a later wildcard deny.
  const tail = (rules ?? []).slice(-2)
  const allowed = new Set(tail.filter((rule) => rule.pattern === '*' && rule.effect === 'allow').map((rule) => rule.permission))
  if (tail.length !== 2 || !allowed.has('graphql-app_interaction_get') || !allowed.has('graphql-app_interaction_respond')) {
    throw new DomainError('APPROVAL_REVIEWER_APP_MCP_REQUIRED',
      'The OpenCode Orchestrator must end its deny-default policy with explicit allow rules for graphql-app_interaction_get and graphql-app_interaction_respond so it can decide through App MCP without a human.', 409)
  }
}
