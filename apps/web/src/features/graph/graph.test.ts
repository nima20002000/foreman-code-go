import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Agent, WorkflowDefinition, WorkflowRunSummary } from '@graphql/contracts'

import {
  AGENT_HANDOFF_EDGE_TYPE,
  closestHandleSides,
  findOpenNodePosition,
  GRAPH_NODE_MAX_HEIGHT,
  GRAPH_NODE_MAX_WIDTH,
  GRAPH_NODE_MIN_HEIGHT,
  GRAPH_NODE_MIN_WIDTH,
  graphToWorkflow,
  makeSequentialHandoffEdge,
  resizeWorkflowNode,
  sameWorkflow,
  withoutAgentReferences,
  workflowToGraph,
} from './mapper'
import {
  getGraphDraft,
  useGraphDraftStore,
  workflowDraftKey,
} from './store'

const workflow: WorkflowDefinition = {
  id: 'workflow-1',
  workspaceId: 'workspace-1',
  name: 'Research to review',
  description: 'Keep this description while editing the canvas.',
  executionCondition: { kind: 'manual', description: 'Started by the operator.' },
  nodes: [
    { id: 'step-research', agentId: 'agent-research', name: 'Researcher', position: { x: 20, y: 40 } },
    { id: 'step-build', agentId: 'agent-build', label: 'Developer', position: { x: 320, y: 40 } },
  ],
  edges: [{ id: 'edge-existing', source: 'step-research', target: 'step-build', label: 'Keep this label' }],
  version: 7,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const agents: (Agent & { activeRunId?: string })[] = [
  {
    id: 'agent-research',
    name: 'Researcher',
    role: 'researcher',
    executionState: 'available',
    description: 'Finds sources.',
  },
  {
    id: 'agent-build',
    name: 'Developer',
    role: 'developer',
    executionState: 'waiting_browser',
    activeRunId: 'run-build',
    harnessSummary: { status: 'running', detail: 'GitHub', label: 'Local runner' },
  },
]

const runFacts: WorkflowRunSummary[] = [
  {
    id: 'run-build',
    workspaceId: 'workspace-1',
    workflowId: workflow.id,
    executionCondition: workflow.executionCondition,
    executionState: 'waiting',
    outcome: 'pending',
    authRequired: false,
    browserWait: {
      reason: 'browser_profile',
      resourceHolder: 'operator',
      resourceName: 'GitHub',
      holderId: 'agent-operator',
      holderLabel: 'Operator',
    },
    runnerHealth: { status: 'healthy' },
  },
]

afterEach(() => useGraphDraftStore.getState().clearAllDrafts())

describe('workflow graph mapper', () => {
  it('preserves node ids, edge configuration, and workflow metadata', () => {
    const projection = workflowToGraph({ workflow, agents }, { runFacts })
    const movedNodes = projection.nodes.map((node) =>
      node.id === 'step-research' ? { ...node, position: { x: 88, y: 144 } } : node,
    )
    const roundTrip = graphToWorkflow(workflow, movedNodes, projection.edges)

    expect(roundTrip).toMatchObject({
      id: workflow.id,
      description: workflow.description,
      version: workflow.version,
      nodes: [
        { id: 'step-research', agentId: 'agent-research', position: { x: 88, y: 144 } },
        { id: 'step-build', agentId: 'agent-build', label: 'Developer' },
      ],
      edges: [{ id: 'edge-existing', source: 'step-research', target: 'step-build', label: 'Keep this label' }],
    })
    expect(projection.nodes[1]?.data.executionState).toBe('waiting_browser')
    expect(projection.nodes[1]?.data.waitLabel).toBe('GitHub · held by Operator')
    expect(projection.nodes[1]?.data.executionStateLabel).toBe('Waiting for browser')
  })

  it('does not infer a wait name from harness detail without an active run fact', () => {
    const projection = workflowToGraph({ workflow, agents: agents.map((agent) => ({ ...agent, activeRunId: undefined })) })

    expect(projection.nodes[1]?.data.waitLabel).toBeUndefined()
  })

  it('marks the URL-controlled agent as selected without owning selection state', () => {
    const onSelectAgent = vi.fn()
    const projection = workflowToGraph(
      { workflow, agents },
      { selectedAgentId: 'agent-build', onSelectAgent },
    )

    expect(projection.nodes.find((node) => node.data.agentId === 'agent-build')?.selected).toBe(true)
    expect(projection.nodes.find((node) => node.data.agentId === 'agent-build')?.data.onSelect).toBe(onSelectAgent)
  })

  it('projects live harness execution state onto its workflow node', () => {
    const projection = workflowToGraph(
      { workflow, agents },
      { runStatesByNodeId: new Map([['step-build', 'running']]) },
    )

    expect(projection.nodes.find((node) => node.id === 'step-build')?.data.runState).toBe('running')
  })

  it('creates a sequential handoff edge and keeps it domain-shaped', () => {
    const projection = workflowToGraph({ workflow, agents })
    const edge = makeSequentialHandoffEdge('step-build', 'step-research')
    const roundTrip = graphToWorkflow(workflow, projection.nodes, [...projection.edges, edge])

    expect(roundTrip.edges.at(-1)).toEqual({
      id: 'edge-step-build-step-research',
      source: 'step-build',
      target: 'step-research',
    })
    expect(roundTrip.edges.at(-1)).not.toHaveProperty('data')
  })

  it('round-trips node dimensions and clamps resize requests to usable bounds', () => {
    const resized = resizeWorkflowNode(workflow, 'step-research', 10_000, 10)
    expect(resized.nodes[0]).toMatchObject({
      width: GRAPH_NODE_MAX_WIDTH,
      height: GRAPH_NODE_MIN_HEIGHT,
    })

    const projection = workflowToGraph({ workflow: resized, agents })
    const roundTrip = graphToWorkflow(workflow, projection.nodes, projection.edges)
    expect(roundTrip.nodes[0]).toMatchObject({
      width: GRAPH_NODE_MAX_WIDTH,
      height: GRAPH_NODE_MIN_HEIGHT,
    })

    const oppositeBounds = resizeWorkflowNode(workflow, 'step-build', 1, 10_000)
    expect(oppositeBounds.nodes[1]).toMatchObject({
      width: GRAPH_NODE_MIN_WIDTH,
      height: GRAPH_NODE_MAX_HEIGHT,
    })
  })

  it('removes every node for a deleted agent and only their connected edges', () => {
    const repeatedAgentWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        { id: 'step-research-again', agentId: 'agent-research', name: 'Researcher again' },
      ],
      edges: [
        ...workflow.edges,
        { id: 'edge-repeat', source: 'step-research-again', target: 'step-build' },
      ],
    }

    const cleaned = withoutAgentReferences(repeatedAgentWorkflow, new Set(['agent-research']))
    expect(cleaned.nodes.map((node) => node.id)).toEqual(['step-build'])
    expect(cleaned.edges).toEqual([])
  })
})

describe('directional connection routing', () => {
  const source = { position: { x: 0, y: 0 }, width: 200, height: 80 }

  it('routes from and into the sides that face each other', () => {
    expect(closestHandleSides(source, { position: { x: 400, y: 0 }, width: 200, height: 80 }))
      .toEqual({ sourceHandle: 'right', targetHandle: 'left' })
    expect(closestHandleSides(source, { position: { x: -400, y: 0 }, width: 200, height: 80 }))
      .toEqual({ sourceHandle: 'left', targetHandle: 'right' })
    expect(closestHandleSides(source, { position: { x: 0, y: 400 }, width: 200, height: 80 }))
      .toEqual({ sourceHandle: 'bottom', targetHandle: 'top' })
    expect(closestHandleSides(source, { position: { x: 0, y: -400 }, width: 200, height: 80 }))
      .toEqual({ sourceHandle: 'top', targetHandle: 'bottom' })
  })

  it('prefers the horizontal axis on diagonal ties for stable left/right handoffs', () => {
    expect(closestHandleSides(source, { position: { x: 400, y: 400 }, width: 200, height: 80 }))
      .toEqual({ sourceHandle: 'right', targetHandle: 'left' })
  })

  it('projects every saved edge with directional handles, the handoff type, and its remove callback', () => {
    const onRemoveEdge = vi.fn()
    const projection = workflowToGraph({ workflow, agents }, { onRemoveEdge })

    expect(projection.edges[0]).toMatchObject({
      id: 'edge-existing',
      type: AGENT_HANDOFF_EDGE_TYPE,
      sourceHandle: 'right',
      targetHandle: 'left',
    })
    projection.edges[0]?.data?.onRemove?.('edge-existing')
    expect(onRemoveEdge).toHaveBeenCalledWith('edge-existing')
  })

  it('keeps edge routing out of the domain round trip', () => {
    const projection = workflowToGraph({ workflow, agents })
    const roundTrip = graphToWorkflow(workflow, projection.nodes, projection.edges)
    expect(roundTrip.edges[0]).toEqual({ id: 'edge-existing', source: 'step-research', target: 'step-build', label: 'Keep this label' })
  })
})

describe('nearby node placement', () => {
  it('places the first node at the anchor and later nodes in nearby non-overlapping slots', () => {
    const anchor = { x: 420, y: 180 }
    const first = findOpenNodePosition([], anchor)
    const second = findOpenNodePosition([
      { id: 'step-one', agentId: 'agent-one', name: 'One', position: first },
    ], anchor)
    const third = findOpenNodePosition([
      { id: 'step-one', agentId: 'agent-one', name: 'One', position: first },
      { id: 'step-two', agentId: 'agent-two', name: 'Two', position: second },
    ], anchor)

    expect(first).toEqual(anchor)
    expect(second).not.toEqual(first)
    expect(third).not.toEqual(first)
    expect(third).not.toEqual(second)
    expect(Math.abs(second.x - anchor.x) + Math.abs(second.y - anchor.y)).toBeLessThan(400)
  })

  it('accounts for saved dimensions and missing positions when avoiding collisions', () => {
    const anchor = { x: 64, y: 120 }
    const position = findOpenNodePosition([
      { id: 'step-one', agentId: 'agent-one', name: 'One', width: 520, height: 320 },
    ], anchor)

    expect(position).not.toEqual(anchor)
    expect(Math.abs(position.x - anchor.x) + Math.abs(position.y - anchor.y)).toBeGreaterThan(200)
  })
})

describe('normalized workflow comparison', () => {
  it('treats derived positions and default sizes as equal to materialized values', () => {
    const derived: WorkflowDefinition = {
      ...workflow,
      nodes: [{ id: 'step-derived', agentId: 'agent-research', name: 'Derived' }],
      edges: [],
    }
    const materialized: WorkflowDefinition = {
      ...derived,
      nodes: [{
        id: 'step-derived',
        agentId: 'agent-research',
        name: 'Derived',
        position: { x: 64, y: 120 },
        width: 238,
        height: 92,
      }],
    }

    expect(sameWorkflow(derived, materialized)).toBe(true)
    expect(sameWorkflow(materialized, derived)).toBe(true)
  })

  it('ignores key order while detecting moves, resizes, and connection changes', () => {
    const reordered: WorkflowDefinition = {
      ...workflow,
      nodes: workflow.nodes.map((node) => ({
        name: node.name,
        label: node.label,
        position: node.position,
        agentId: node.agentId,
        id: node.id,
      })),
    }
    const moved: WorkflowDefinition = {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === 'step-research' ? { ...node, position: { x: 21, y: 40 } } : node),
    }
    const resized = resizeWorkflowNode(workflow, 'step-research', 300, 100)
    const connected: WorkflowDefinition = {
      ...workflow,
      edges: [...workflow.edges, { id: 'edge-new', source: 'step-build', target: 'step-research' }],
    }

    expect(sameWorkflow(workflow, reordered)).toBe(true)
    expect(sameWorkflow(workflow, moved)).toBe(false)
    expect(sameWorkflow(workflow, resized)).toBe(false)
    expect(sameWorkflow(workflow, connected)).toBe(false)
    expect(sameWorkflow(workflow, resizeWorkflowNode(workflow, 'step-research', 238, 92))).toBe(true)
  })
})

describe('workflow graph draft store', () => {
  it('keeps dirty edits keyed by workflow and discards only explicitly', () => {
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({ ...current, name: 'Local edit' }))
    expect(getGraphDraft(key)?.workflow.name).toBe('Local edit')
    expect(getGraphDraft(key)?.dirty).toBe(true)

    useGraphDraftStore.getState().discardDraft(key)
    expect(getGraphDraft(key)).toBeUndefined()
  })

  it('drops no-op edits and clears a draft that reverts to the saved definition', () => {
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    const moveResearchNode = (current: WorkflowDefinition, x: number, y: number) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === 'step-research' ? { ...node, position: { x, y } } : node),
    })

    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => current)
    expect(getGraphDraft(key)).toBeUndefined()

    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => moveResearchNode(current, 96, 120))
    expect(getGraphDraft(key)?.dirty).toBe(true)

    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => moveResearchNode(current, 20, 40))
    expect(getGraphDraft(key)).toBeUndefined()

    useGraphDraftStore.getState().updateDraft(
      key,
      workflow,
      (current) => resizeWorkflowNode(current, 'step-research', GRAPH_NODE_MAX_WIDTH, GRAPH_NODE_MIN_HEIGHT),
    )
    expect(getGraphDraft(key)?.dirty).toBe(true)

    useGraphDraftStore.getState().updateDraft(
      key,
      workflow,
      (current) => resizeWorkflowNode(current, 'step-research', 238, 92),
    )
    expect(getGraphDraft(key)).toBeUndefined()
  })

  it('does not replace a dirty draft when saved data is refetched', () => {
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({ ...current, name: 'Unsaved' }))
    // A query refetch is not routed through this store; the dirty draft keeps
    // its identity and is rendered until the operator discards or saves it.
    useGraphDraftStore.getState().updateDraft(key, { ...workflow, name: 'Refetched server copy' }, (current) => current)

    expect(getGraphDraft(key)?.workflow.name).toBe('Unsaved')
  })
})
