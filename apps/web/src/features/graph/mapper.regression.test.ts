import { WorkflowDefinitionSchema } from '@graphql/contracts'
import { describe, expect, it } from 'vitest'

import { graphToWorkflow, workflowToGraph } from './mapper'

function fixture() {
  return WorkflowDefinitionSchema.parse({
    id: 'workflow-1', workspaceId: 'workspace-1', name: 'Approval',
    executionCondition: { kind: 'manual' },
    nodes: [
      { id: 'node-1', agentId: 'agent-1', name: 'Research', position: { x: 10, y: 20 } },
      { id: 'node-2', agentId: 'agent-2', name: 'Review', position: { x: 400, y: 20 } },
    ],
    edges: [
      {
        id: 'edge-1', source: 'node-1', target: 'node-2', label: 'Approved',
        route: {
          outcomes: ['succeeded'],
          result: { path: ['approved'], operator: 'equals', value: true },
          maxTraversals: 2,
        },
      },
      {
        id: 'edge-2', source: 'node-2', target: 'node-1',
        route: { outcomes: ['failed', 'canceled'], maxTraversals: 3 },
      },
    ],
  })
}

describe('graph edits preserve execution routing', () => {
  it.each([false, true])('retains every full route after a round-trip (drag=%s)', (drag) => {
    const workflow = fixture()
    const original = structuredClone(workflow)
    const graph = workflowToGraph({ workflow, agents: [] })
    const nodes = graph.nodes.map((node, index) => drag && index === 0
      ? { ...node, position: { x: 150, y: 250 } }
      : node)
    const saved = graphToWorkflow(workflow, nodes, graph.edges)
    expect(saved.edges).toEqual(workflow.edges)
    expect(saved.nodes[0]?.position).toEqual(drag ? { x: 150, y: 250 } : { x: 10, y: 20 })
    expect(workflow).toEqual(original)
  })

  it('overrides renderer-owned endpoints and labels without dropping routing', () => {
    const workflow = fixture()
    const graph = workflowToGraph({ workflow, agents: [] })
    const saved = graphToWorkflow(workflow, graph.nodes, [{
      id: 'edge-1', source: 'node-2', target: 'node-1', label: 'Changed',
    }])
    expect(saved.edges).toEqual([{
      ...workflow.edges[0], source: 'node-2', target: 'node-1', label: 'Changed',
    }])
  })

  it('does not copy old routing onto a newly created edge or resurrect removed edges', () => {
    const workflow = fixture()
    const graph = workflowToGraph({ workflow, agents: [] })
    const saved = graphToWorkflow(workflow, graph.nodes, [{
      id: 'new-edge', source: 'node-1', target: 'node-2',
    }])
    expect(saved.edges).toEqual([{ id: 'new-edge', source: 'node-1', target: 'node-2' }])
  })
})
