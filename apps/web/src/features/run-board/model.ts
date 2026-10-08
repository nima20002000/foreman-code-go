import type { Edge, Node, ReactFlowProps } from '@xyflow/react'
import type { RunBoardSnapshot, RunBoardNodeSnapshot, RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'

export type AvailableRunBoardSnapshot = Extract<RunBoardSnapshot, { kind: 'available' }>
export type SavedBoardNode = Node<{ snapshot: RunBoardNodeSnapshot; inspect?: () => void }, 'savedBoardNode'>
export type SavedBoardEdge = Edge<{ snapshot: RunBoardEdgeSnapshot; lane: number }, 'savedBoardEdge'>

/** No caller-provided canvas props may override these locks. Viewport movement is harmless. */
export const READ_ONLY_FLOW_PROPS = {
  nodesDraggable: false, nodesConnectable: false, edgesReconnectable: false,
  elementsSelectable: false, selectNodesOnDrag: false, selectionOnDrag: false,
  connectOnClick: false, deleteKeyCode: null, selectionKeyCode: null, multiSelectionKeyCode: null,
  disableKeyboardA11y: true, nodesFocusable: true, edgesFocusable: true,
} as const satisfies Partial<ReactFlowProps<SavedBoardNode, SavedBoardEdge>>

/** A presentation projection, never a draft installation or current-Agent lookup.
 * Copy mutable geometry for React Flow; retain the contract's readonly facts in data.
 * Keep every edge (including an approval parallel to a handoff), in snapshot order.
 */
export function projectRunBoard(snapshot: AvailableRunBoardSnapshot): { nodes: SavedBoardNode[]; edges: SavedBoardEdge[] } {
  const names = new Map(snapshot.nodes.map((node) => [node.id, node.name]))
  const nodes: SavedBoardNode[] = snapshot.nodes.map((node) => ({
    id: node.id, type: 'savedBoardNode', position: { ...node.position }, origin: [0, 0],
    initialWidth: node.size.width, initialHeight: node.size.height,
    style: { width: node.size.width, height: node.size.height }, data: { snapshot: node },
    draggable: false, connectable: false, selectable: false, deletable: false, focusable: true,
    ariaRole: 'group', ariaLabel: `${node.name}, saved ${node.kind==='job'?'job':'agent'}, read only`,
    domAttributes: { title: node.kind==='job'?`${node.name}\nJob: ${node.jobDefinitionId}\nRevision: ${node.jobDefinitionRevision}`:`${node.name}\nAgent: ${node.agentId}\nConfiguration: ${node.agentConfigurationVersionId}` },
  }))
  const lanes = new Map<string, number>()
  const edges: SavedBoardEdge[] = snapshot.edges.map((edge) => {
    const pair = JSON.stringify([edge.source, edge.target].sort())
    const index = lanes.get(pair) ?? 0
    lanes.set(pair, index + 1)
    // Canonical orientation keeps reverse-direction edges on different curves too.
    const lane = (index % 2 ? Math.ceil(index / 2) : -index / 2) * (edge.source < edge.target ? 1 : -1)
    return {
      id: edge.id, type: 'savedBoardEdge', source: edge.source, target: edge.target,
      sourceHandle: edge.sourceHandle ?? 'right', targetHandle: edge.targetHandle ?? 'left',
      data: { snapshot: edge, lane },
      selectable: false, deletable: false, reconnectable: false, focusable: true,
      ariaRole: 'img',
      ariaLabel: `${edge.kind === 'approval' ? 'Approval' : 'Handoff'} from ${names.get(edge.source)} to ${names.get(edge.target)}${edge.label ? `: ${edge.label}` : ''}, read only`,
    }
  })
  return { nodes, edges }
}
