import type {
  Agent,
  AgentExecutionState,
  WorkflowDefinition,
  WorkflowRunSummary,
} from '@graphql/contracts'

import type { Edge, Node } from '@xyflow/react'

/**
 * Data used by the renderer only. The contracts package intentionally has no
 * dependency on React Flow or any other UI library.
 */
export type GraphNodeData = {
  workflowNodeId: string
  agentId: string
  label: string
  role?: string
  description?: string
  executionState?: AgentExecutionState
  executionStateLabel: string
  stepLabel: string
  waitLabel?: string
  /** Renderer-only marker for a node that is animating out after removal. */
  departing?: boolean
  /** Renderer-only marker for a newly added node entering the canvas. */
  entering?: boolean
  onSelect?: (agentId: string, workflowNodeId: string) => void
  onUnlink?: (workflowNodeId: string) => void
  onDelete?: (agentId: string, agentLabel: string) => void
  onResize?: (workflowNodeId: string, width: number, height: number) => void
}

export type GraphNode = Node<GraphNodeData, 'agent'>

/** A node exposes exactly one handle per side, shared by every connection. */
export type GraphHandleSide = 'top' | 'right' | 'bottom' | 'left'

export type GraphEdgeData = {
  /** This is a visual explanation, not a permission or execution contract. */
  explanation: string
  onRemove?: (edgeId: string) => void
}

export type GraphEdge = Edge<GraphEdgeData>

export type GraphProjection = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type GraphMapperOptions = {
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
  onUnlinkNode?: (workflowNodeId: string) => void
  onDeleteAgent?: (agentId: string, agentLabel: string) => void
  onResizeNode?: (workflowNodeId: string, width: number, height: number) => void
  /** Removes a single connection edge without touching its nodes. */
  onRemoveEdge?: (edgeId: string) => void
  /** Authoritative run projections used to name an agent's active wait. */
  runFacts?: readonly WorkflowRunSummary[]
  /** Renderer-only ids used to play a node entrance animation after insertion. */
  enteringNodeIds?: ReadonlySet<string>
}

export type GraphSource = {
  workflow: WorkflowDefinition
  agents: readonly Agent[]
  runFacts?: readonly WorkflowRunSummary[]
}
