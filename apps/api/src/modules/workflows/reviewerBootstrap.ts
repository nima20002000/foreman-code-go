import type { HarnessConfiguration, WorkflowApprovalConfiguration } from '@graphql/contracts'
import type { WorkflowDefinitionV3 } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'

/** Reject an unavailable reviewer before launch. Never change native permissions to make it work. */
export function validateReviewerBootstrap(
  definition: WorkflowDefinitionV3,
  approval: WorkflowApprovalConfiguration,
  configuration: HarnessConfiguration | undefined,
  acceptedEntryNodeId?: string,
): void {
  if (approval.handler !== 'orchestrator') return
  const nodes = definition.nodes.filter((node) => node.agentId === approval.designatedOrchestratorAgentId)
  const reviewer = nodes[0]
  const entryNodeId = definition.entryNodeId
  if (acceptedEntryNodeId !== undefined && acceptedEntryNodeId !== entryNodeId) {
    throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_ORDER',
      'The authored entry must match the accepted immutable entry.', 409)
  }
  if (nodes.length !== 1 || !reviewer || entryNodeId !== reviewer.id
    || definition.approval?.handler !== 'orchestrator'
    || definition.approval.designatedOrchestratorAgentId !== approval.designatedOrchestratorAgentId
    || definition.edges.some((edge) => edge.target === reviewer.id && edge.kind === 'execution')) {
    throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_ORDER',
      'The designated Orchestrator must appear once as the accepted entry, with no incoming execution dependency. Independent or recursive reviewer startup is unsupported.', 409)
  }
  if (configuration?.harness === 'codex') {
    if (configuration.advanced?.approvalPolicy !== 'on-request'
      || configuration.advanced.approvalsReviewer !== 'auto_review') {
      throw new DomainError('APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED',
        'A Codex Orchestrator needs Ask when needed and Codex automatic review to respond to App MCP approval requests without a person.', 409)
    }
    return
  }
  const rules = configuration?.harness === 'opencode' ? configuration.advanced?.permissionRules : undefined
  const noninteractive = configuration?.harness === 'opencode' && !configuration.autoApprove
    && configuration.advanced?.permissionHandling === 'graphql_routed'
    && rules?.[0]?.permission === '*' && rules[0].pattern === '*' && rules[0].effect === 'deny'
    && (rules ?? []).every((rule, index) => rule.effect !== 'ask' && (index === 0 || rule.permission !== '*'))
  if (!noninteractive) {
    throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_INTERACTIVE',
      'The initial Orchestrator cannot review its own approval. Choose an OpenCode deny-default policy with no ask rules, or select the User workflow handler. No settings were changed automatically.', 409)
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
