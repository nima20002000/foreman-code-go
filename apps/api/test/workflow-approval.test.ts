import { describe, expect, it } from 'vitest'

import { validateWorkflowApproval } from '../src/modules/workflows/approval.js'

const definition = {
  id: 'workflow-1', workspaceId: 'workspace-1', name: 'Approval workflow', executionCondition: { kind: 'manual' as const },
  nodes: [
    { id: 'node-orchestrator', agentId: 'agent-orchestrator', name: 'Orchestrator' },
    { id: 'node-coder', agentId: 'agent-coder', name: 'Coder' },
  ], edges: [],
}
const agents = [
  { id: 'agent-orchestrator', name: 'O', role: 'anything', productRole: 'orchestrator' as const },
  { id: 'agent-coder', name: 'C', role: 'orchestrator', productRole: 'coder' as const },
]

describe('workflow approval authority', () => {
  it('uses durable product roles and requires a distinct Coder', () => {
    expect(() => validateWorkflowApproval(definition, { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-orchestrator' }, agents)).not.toThrow()
    expect(() => validateWorkflowApproval({ ...definition, nodes: [definition.nodes[0]!] }, { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-orchestrator' }, agents)).toThrowError(expect.objectContaining({ code: 'APPROVAL_DISTINCT_CODER_REQUIRED' }))
  })

  it('rejects a model-supplied display role and wrong-workflow designation', () => {
    expect(() => validateWorkflowApproval(definition, { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-coder' }, agents)).toThrowError(expect.objectContaining({ code: 'APPROVAL_ORCHESTRATOR_ROLE_REQUIRED' }))
    expect(() => validateWorkflowApproval(definition, { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-other' }, agents)).toThrowError(expect.objectContaining({ code: 'APPROVAL_ORCHESTRATOR_WRONG_WORKFLOW' }))
  })
})
