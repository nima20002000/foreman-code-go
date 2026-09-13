import type {
  Agent,
  AgentExecutionState,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRunSummary,
} from '@graphql/contracts'

import type { XYPosition } from '@xyflow/react'

import type {
  GraphEdge,
  GraphMapperOptions,
  GraphNode,
  GraphProjection,
} from './types'

export const GRAPH_NODE_MIN_WIDTH = 214
export const GRAPH_NODE_MAX_WIDTH = 520
export const GRAPH_NODE_MIN_HEIGHT = 92
export const GRAPH_NODE_MAX_HEIGHT = 320
const DEFAULT_NODE_WIDTH = 238
const DEFAULT_NODE_HEIGHT = GRAPH_NODE_MIN_HEIGHT
const DEFAULT_NODE_GAP = 92
const DEFAULT_NODE_Y = 120

const executionStateLabels: Record<AgentExecutionState, string> = {
  available: 'Available',
  working: 'Working',
  waiting_browser: 'Waiting for browser',
  auth_required: 'Auth required',
  interrupted: 'Interrupted',
  disconnected: 'Disconnected',
}

export function executionStateLabel(state?: AgentExecutionState): string {
  return state ? executionStateLabels[state] : 'State unavailable'
}

function fallbackPosition(index: number): XYPosition {
  return {
    x: index * (DEFAULT_NODE_WIDTH + DEFAULT_NODE_GAP) + 64,
    y: DEFAULT_NODE_Y,
  }
}

function workflowNodePosition(node: WorkflowNode, index: number): XYPosition {
  return node.position ? { x: node.position.x, y: node.position.y } : fallbackPosition(index)
}

function clampNodeSize(width: number, height: number) {
  return {
    width: Math.min(GRAPH_NODE_MAX_WIDTH, Math.max(GRAPH_NODE_MIN_WIDTH, width)),
    height: Math.min(GRAPH_NODE_MAX_HEIGHT, Math.max(GRAPH_NODE_MIN_HEIGHT, height)),
  }
}

function agentState(agent: Agent | undefined): AgentExecutionState | undefined {
  return agent?.executionState ?? agent?.status
}

function activeRunId(agent: Agent | undefined): string | undefined {
  if (!agent || !('activeRunId' in agent)) return undefined
  const value = agent.activeRunId
  return typeof value === 'string' ? value : undefined
}

function waitLabel(
  agent: Agent | undefined,
  state: AgentExecutionState | undefined,
  runFacts: readonly WorkflowRunSummary[] = [],
): string | undefined {
  if (state !== 'waiting_browser' && state !== 'auth_required') return undefined

  const runId = activeRunId(agent)
  if (!runId) return undefined

  const browserWait = runFacts.find((run) => run.id === runId)?.browserWait
  if (!browserWait) return undefined

  const resourceName = browserWait.resourceName?.trim()
  const holderLabel = browserWait.holderLabel?.trim()
  if (resourceName && holderLabel) return `${resourceName} · held by ${holderLabel}`
  if (resourceName) return resourceName
  if (holderLabel) return `held by ${holderLabel}`
  return undefined
}

function nodeLabel(workflowNode: WorkflowNode, agent: Agent | undefined): string {
  return workflowNode.name ?? workflowNode.label ?? agent?.name ?? workflowNode.agentId
}

function edgeExplanation(): string {
  return 'Proposed sequential output handoff'
}

export function workflowToGraph(
  { workflow, agents }: { workflow: WorkflowDefinition; agents: readonly Agent[] },
  options: GraphMapperOptions = {},
): GraphProjection {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))

  const nodes: GraphNode[] = workflow.nodes.map((workflowNode, index) => {
    const agent = agentsById.get(workflowNode.agentId)
    const state = agentState(agent)
    const size = clampNodeSize(
      workflowNode.width ?? DEFAULT_NODE_WIDTH,
      workflowNode.height ?? DEFAULT_NODE_HEIGHT,
    )
    return {
      id: workflowNode.id,
      type: 'agent',
      position: workflowNodePosition(workflowNode, index),
      initialWidth: size.width,
      initialHeight: size.height,
      width: size.width,
      height: size.height,
      style: size,
      selected: options.selectedAgentId === workflowNode.agentId,
      data: {
        workflowNodeId: workflowNode.id,
        agentId: workflowNode.agentId,
        label: nodeLabel(workflowNode, agent),
        role: agent?.role,
        description: workflowNode.description ?? agent?.description,
        executionState: state,
        executionStateLabel: executionStateLabel(state),
        stepLabel: `Step ${index + 1}`,
        waitLabel: waitLabel(agent, state, options.runFacts),
        connectionArmed: options.armedNodeId === workflowNode.id,
        onSelect: options.onSelectAgent,
        onUnlink: options.onUnlinkNode,
        onDelete: options.onDeleteAgent,
        onResize: options.onResizeNode,
      },
    }
  })

  const edges: GraphEdge[] = workflow.edges.map((workflowEdge) => ({
    id: workflowEdge.id,
    source: workflowEdge.source,
    target: workflowEdge.target,
    label: workflowEdge.label,
    type: 'smoothstep',
    data: { explanation: edgeExplanation() },
  }))

  return { nodes, edges }
}

function asDomainEdge(edge: GraphEdge, existing?: WorkflowEdge): WorkflowEdge {
  const label = typeof edge.label === 'string' ? edge.label : existing?.label
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(label === undefined ? {} : { label }),
  }
}

/**
 * Convert only renderer-owned position and connection fields back to domain
 * data. All workflow metadata and node configuration are copied from the
 * saved definition, so a drag/connect cannot silently drop unrelated fields.
 */
export function graphToWorkflow(
  workflow: WorkflowDefinition,
  nodes: readonly Pick<GraphNode, 'id' | 'position' | 'width' | 'height' | 'measured'>[],
  edges: readonly Pick<GraphEdge, 'id' | 'source' | 'target' | 'label'>[],
): WorkflowDefinition {
  const positions = new Map(nodes.map((node) => [node.id, node.position]))
  const sizes = new Map(nodes.map((node) => [
    node.id,
    clampNodeSize(
      node.width ?? node.measured?.width ?? DEFAULT_NODE_WIDTH,
      node.height ?? node.measured?.height ?? DEFAULT_NODE_HEIGHT,
    ),
  ]))
  const workflowNodes = workflow.nodes.map((node) => {
    const position = positions.get(node.id)
    const size = sizes.get(node.id)
    return {
      ...node,
      ...(position ? { position: { x: position.x, y: position.y } } : {}),
      ...(size ? size : {}),
    }
  })
  const existingEdges = new Map(workflow.edges.map((edge) => [edge.id, edge]))
  const workflowEdges = edges.map((edge) => asDomainEdge(edge as GraphEdge, existingEdges.get(edge.id)))

  return {
    ...workflow,
    nodes: workflowNodes,
    edges: workflowEdges,
  }
}

export function makeSequentialHandoffEdge(source: string, target: string): GraphEdge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
    type: 'smoothstep',
    label: 'Sequential output handoff',
    data: { explanation: edgeExplanation() },
  }
}

export function hasConnection(
  edges: readonly Pick<GraphEdge, 'source' | 'target'>[],
  source: string,
  target: string,
): boolean {
  return edges.some((edge) => edge.source === source && edge.target === target)
}

export function sameWorkflow(left: WorkflowDefinition, right: WorkflowDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function withoutAgentReferences(
  workflow: WorkflowDefinition,
  agentIds: ReadonlySet<string>,
): WorkflowDefinition {
  if (agentIds.size === 0) return workflow
  const removedNodeIds = new Set(
    workflow.nodes.filter((node) => agentIds.has(node.agentId)).map((node) => node.id),
  )
  if (removedNodeIds.size === 0) return workflow
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => !removedNodeIds.has(node.id)),
    edges: workflow.edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target)),
  }
}

export function resizeWorkflowNode(
  workflow: WorkflowDefinition,
  workflowNodeId: string,
  width: number,
  height: number,
): WorkflowDefinition {
  const size = clampNodeSize(width, height)
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => node.id === workflowNodeId ? { ...node, ...size } : node),
  }
}
