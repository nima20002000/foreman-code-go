import { MarkerType, type Node, type Edge } from '@xyflow/react'
import type { RunGraphTopology } from '@graphql/contracts/wave25'

export type RunViewNode = Node<{
  workflowNodeId: string; agentId: string; configurationId: string; isEntry: boolean; productRole: RunGraphTopology['nodes'][number]['productRole']
}, 'run-fact'>
export type RunViewEdge = Edge<{ kind: 'execution' | 'approval'; relationshipId: string }, 'run-relationship'>
export type RunViewTopology = { nodes: RunViewNode[]; edges: RunViewEdge[] }

/** No runtime or draft parameter exists. Missing positions get presentation-only grid geometry. */
export function createRunViewTopologyProjector() {
  const projections = new WeakMap<RunGraphTopology, RunViewTopology>()
  return (topology: RunGraphTopology): RunViewTopology => {
    const cached = projections.get(topology)
    if (cached) return cached
    const projection: RunViewTopology = {
      nodes: topology.nodes.map((node, index) => ({
        id: node.workflowNodeId, type: 'run-fact',
        position: node.position ?? { x: index % 4 * 310, y: Math.floor(index / 4) * 190 },
        style: { width: node.width ?? 260, ...(node.height ? { minHeight: node.height } : {}) },
        draggable: false, connectable: false, deletable: false,
        data: { workflowNodeId: node.workflowNodeId, agentId: node.agentId,
          configurationId: node.agentConfigurationVersionId, isEntry: node.workflowNodeId === topology.entryNodeId, productRole: node.productRole },
      })),
      edges: topology.relationships.map((edge) => ({
        id: edge.relationshipId, type: 'run-relationship', source: edge.source, target: edge.target,
        sourceHandle: 'out', targetHandle: 'in', animated: false, deletable: false,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { kind: edge.kind, relationshipId: edge.relationshipId },
      })),
    }
    projections.set(topology, projection)
    return projection
  }
}
