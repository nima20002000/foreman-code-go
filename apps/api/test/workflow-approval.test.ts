import { describe, expect, it } from 'vitest'

import { validateWorkflowApproval } from '../src/modules/workflows/approval.js'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, NATIVE_INTERACTION_FIXTURES } from '@graphql/contracts'
import { assertOrchestratorInteractionAuthority } from '../src/modules/interactions/authorization.js'

const definition = {
  id: 'workflow-1', workspaceId: 'workspace-1', name: 'Approval workflow', executionCondition: { kind: 'manual' as const },
  nodes: [
    { id: 'node-orchestrator', agentId: 'agent-orchestrator', name: 'Orchestrator' },
    { id: 'node-coder', agentId: 'agent-coder', name: 'Coder' },
  ], edges: [],
}
const agents = [
  { id: 'agent-orchestrator', name: 'O', role: 'anything', productRole: 'orchestrator' as const,
    harnessConfiguration: { harness: 'opencode' as const, model: 'test-model', variant: 'high',
      nativeAgent: 'build' as const, thinking: false, autoApprove: false,
      advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionRules: [
        { permission: '*', pattern: '*', effect: 'deny' as const },
        { permission: 'graphql-app_interaction_get', pattern: '*', effect: 'allow' as const },
        { permission: 'graphql-app_interaction_respond', pattern: '*', effect: 'allow' as const },
      ] } } },
  { id: 'agent-coder', name: 'C', role: 'orchestrator', productRole: 'coder' as const },
]

describe('workflow approval authority', () => {
  it('rejects an incomplete Orchestrator selection at executable validation', () => {
    expect(() => validateWorkflowApproval(definition, { handler: 'orchestrator' }, agents))
      .toThrowError(expect.objectContaining({ code: 'WORKFLOW_APPROVAL_INCOMPLETE' }))
  })

  it('uses durable product roles and requires a distinct Coder', () => {
    expect(() => validateWorkflowApproval(definition, { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-orchestrator' }, agents)).not.toThrow()
    expect(() => validateWorkflowApproval({ ...definition, nodes: [definition.nodes[0]!] }, { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-orchestrator' }, agents)).toThrowError(expect.objectContaining({ code: 'APPROVAL_DISTINCT_CODER_REQUIRED' }))
  })

  it('rejects a model-supplied display role and wrong-workflow designation', () => {
    expect(() => validateWorkflowApproval(definition, { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-coder' }, agents)).toThrowError(expect.objectContaining({ code: 'APPROVAL_ORCHESTRATOR_ROLE_REQUIRED' }))
    expect(() => validateWorkflowApproval(definition, { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-other' }, agents)).toThrowError(expect.objectContaining({ code: 'APPROVAL_ORCHESTRATOR_WRONG_WORKFLOW' }))
  })

  it('rejects a downstream reviewer and an interactive reviewer bootstrap', () => {
    const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'agent-orchestrator' }
    expect(() => validateWorkflowApproval({ ...definition, nodes: [...definition.nodes].reverse() }, approval, agents))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_REVIEWER_BOOTSTRAP_ORDER' }))
    const interactive = agents.map((agent) => agent.id !== 'agent-orchestrator' ? agent : { ...agent,
      harnessConfiguration: { ...agent.harnessConfiguration!,
        advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionRules: [{ permission: '*', pattern: '*', effect: 'ask' as const }] } } })
    expect(() => validateWorkflowApproval(definition, approval, interactive))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_REVIEWER_BOOTSTRAP_INTERACTIVE' }))
  })

  it('requires Codex automatic review or explicit OpenCode App MCP grants before a Run starts', () => {
    const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'agent-orchestrator' }
    const codex = agents.map((agent) => agent.id !== 'agent-orchestrator' ? agent : { ...agent,
      harnessConfiguration: { harness: 'codex' as const, model: 'test-model', reasoningEffort: 'medium' as const,
        sandbox: 'read-only' as const, serviceTier: 'standard' as const,
        advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' as const } } })
    expect(() => validateWorkflowApproval(definition, approval, codex))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED' }))
    const codexAuto = agents.map((agent) => agent.id !== 'agent-orchestrator' ? agent : { ...agent,
      harnessConfiguration: { harness: 'codex' as const, model: 'gpt-5.6-luna', reasoningEffort: 'high' as const,
        sandbox: 'read-only' as const, serviceTier: 'standard' as const,
        advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request' as const,
          approvalsReviewer: 'auto_review' as const } } })
    expect(() => validateWorkflowApproval(definition, approval, codexAuto)).not.toThrow()
    const missing = agents.map((agent) => agent.id !== 'agent-orchestrator' ? agent : { ...agent,
      harnessConfiguration: { ...agent.harnessConfiguration!, advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
        permissionRules: [{ permission: '*', pattern: '*', effect: 'deny' as const }] } } })
    expect(() => validateWorkflowApproval(definition, approval, missing))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_REVIEWER_APP_MCP_REQUIRED' }))
    const overridden = agents.map((agent) => agent.id !== 'agent-orchestrator' ? agent : { ...agent,
      harnessConfiguration: { ...agent.harnessConfiguration!, advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
        permissionRules: [...agents[0]!.harnessConfiguration.advanced.permissionRules,
          { permission: 'graphql-app_*', pattern: '*', effect: 'deny' as const }] } } })
    expect(() => validateWorkflowApproval(definition, approval, overridden))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_REVIEWER_APP_MCP_REQUIRED' }))
  })

  it('denies cross-workflow and self approval from worker identity', () => {
    const interaction = NATIVE_INTERACTION_FIXTURES.codex
    expect(() => assertOrchestratorInteractionAuthority(interaction, {
      agentId: 'agent-orchestrator', workspaceId: 'workspace-fixture', workflowId: 'workflow-fixture',
    })).not.toThrow()
    expect(() => assertOrchestratorInteractionAuthority(interaction, {
      agentId: 'agent-orchestrator', workspaceId: 'workspace-fixture', workflowId: 'workflow-other',
    })).toThrowError(expect.objectContaining({ code: 'INTERACTION_ACCESS_DENIED' }))
    expect(() => assertOrchestratorInteractionAuthority({ ...interaction, requestingAgentId: 'agent-orchestrator' }, {
      agentId: 'agent-orchestrator', workspaceId: 'workspace-fixture', workflowId: 'workflow-fixture',
    })).toThrowError(expect.objectContaining({ code: 'INTERACTION_ACCESS_DENIED' }))
  })
})
