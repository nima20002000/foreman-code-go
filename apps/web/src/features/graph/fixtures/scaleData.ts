import type { Agent, GetRunResponse, RunNodeLiveActivity, WorkflowDefinition } from '@graphql/contracts'

/** Synthetic renderer data only. This module never admits or starts a native Run. */
export function makeScaleGraph(count = 300): { workflow: WorkflowDefinition; agents: Agent[] } {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('Fixture size must be between 1 and 500.')
  const agents: Agent[] = Array.from({ length: count }, (_, index) => ({
    id: `synthetic-agent-${index}`, name: `Worker ${index + 1}`, productRole: 'coder', harness: 'codex',
  }))
  return {
    agents,
    workflow: {
      id: 'synthetic-workflow', workspaceId: 'synthetic-workspace', name: 'Synthetic scale fixture',
      executionCondition: { kind: 'manual' },
      nodes: agents.map((agent, index) => ({ id: `synthetic-node-${index}`, agentId: agent.id,
        name: agent.name, position: { x: (index % 20) * 300, y: Math.floor(index / 20) * 180 } })),
      edges: agents.slice(1).map((_, index) => ({ id: `synthetic-edge-${index}`,
        source: `synthetic-node-${index}`, target: `synthetic-node-${index + 1}` })),
    },
  }
}

/** Only the fields consumed by the canvas are populated; this is not an API admission fixture. */
export function makeSyntheticRun(count = 300, sequence = '1'): GetRunResponse {
  const { workflow } = makeScaleGraph(count)
  const nodes: RunNodeLiveActivity[] = workflow.nodes.map((node) => ({
    workflowNodeId: node.id, agentId: node.agentId, state: 'idle', action: null, event: null,
  }))
  return {
    run: { id: 'synthetic-run', workspaceId: workflow.workspaceId, workflowId: workflow.id,
      workflowVersionId: 'synthetic-version', executionState: 'running' },
    executions: [], activity: [], cleanupPending: false,
    liveActivity: { runId: 'synthetic-run', workspaceId: workflow.workspaceId, workflowId: workflow.id,
      workflowVersionId: 'synthetic-version', active: true, sequence, eventCount: sequence, nodes },
  } as unknown as GetRunResponse
}
