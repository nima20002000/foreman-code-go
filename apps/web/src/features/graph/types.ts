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
  onSelect?: (agentId: string) => void
  onCopy?: (workflowNodeId: string) => void
  onUnlink?: (workflowNodeId: string) => void
}

export type GraphNode = Node<GraphNodeData, 'agent'>

export type GraphEdgeData = {
  /** This is a visual explanation, not a permission or execution contract. */
  explanation: string
}

export type GraphEdge = Edge<GraphEdgeData>

export type GraphProjection = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type GraphMapperOptions = {
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
  onCopyNode?: (workflowNodeId: string) => void
  onUnlinkNode?: (workflowNodeId: string) => void
  /** Authoritative run projections used to name an agent's active wait. */
  runFacts?: readonly WorkflowRunSummary[]
}

export type GraphSource = {
  workflow: WorkflowDefinition
  agents: readonly Agent[]
  runFacts?: readonly WorkflowRunSummary[]
}
