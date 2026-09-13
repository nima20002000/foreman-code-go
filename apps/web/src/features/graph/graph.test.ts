import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Agent, WorkflowDefinition, WorkflowRunSummary } from '@graphql/contracts'

import {
  graphToWorkflow,
  makeSequentialHandoffEdge,
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

  it('creates a sequential handoff edge and keeps it domain-shaped', () => {
    const projection = workflowToGraph({ workflow, agents })
    const edge = makeSequentialHandoffEdge('step-build', 'step-research')
    const roundTrip = graphToWorkflow(workflow, projection.nodes, [...projection.edges, edge])

    expect(roundTrip.edges.at(-1)).toEqual({
      id: 'edge-step-build-step-research',
      source: 'step-build',
      target: 'step-research',
      label: 'Sequential output handoff',
    })
    expect(roundTrip.edges.at(-1)).not.toHaveProperty('data')
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

  it('does not replace a dirty draft when saved data is refetched', () => {
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({ ...current, name: 'Unsaved' }))
    // A query refetch is not routed through this store; the dirty draft keeps
    // its identity and is rendered until the operator discards or saves it.
    useGraphDraftStore.getState().updateDraft(key, { ...workflow, name: 'Refetched server copy' }, (current) => current)

    expect(getGraphDraft(key)?.workflow.name).toBe('Unsaved')
  })
})
