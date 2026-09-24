import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactFlowProps } from '@xyflow/react'
import { AgentSchema, DEFAULT_HARNESS_DEFAULTS, type WorkflowDefinition, type WorkflowRunSummary } from '@graphql/contracts'
import type { GraphDraft } from '@graphql/contracts/management'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { identityEpochKey } from '../../shared/api/protectedChatStorage'
import { queryKeys } from '../../shared/api/query'
import { GraphEditor } from './GraphEditor'
import { captureManagedBase } from './managedGraphState'
import { managedLayoutQueueKey, managedSaveQueue } from './managedSave'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'
import type { GraphEdge, GraphNode } from './types'

const mocks = vi.hoisted(() => ({
  flow: null as ReactFlowProps<GraphNode, GraphEdge> | null,
  layout: vi.fn(), readback: vi.fn(), apply: vi.fn(), save: vi.fn(), revert: vi.fn(),
}))
vi.mock('@xyflow/react', async () => ({
  ...await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react'),
  ReactFlow: (props: ReactFlowProps<GraphNode, GraphEdge>) => { mocks.flow = props; return <div /> },
  Background: () => null, MiniMap: () => null,
}))
vi.mock('./GraphElements', () => ({ AgentNode: () => null, AgentMinimapDot: () => null, HandoffEdge: () => null }))
vi.mock('../../shared/api/client', async () => ({
  ...await vi.importActual<typeof import('../../shared/api/client')>('../../shared/api/client'),
  putManagedGraphLayout: mocks.layout, getManagedGraphContext: mocks.readback,
  applyManagedGraphDraft: mocks.apply,
  saveManagedGraphDraft: mocks.save, revertManagedGraphApply: mocks.revert,
}))

const agent = AgentSchema.parse({
  id: 'agent-one', name: 'Coder', harness: 'codex', model: 'gpt-5.6-luna', effort: 'medium',
  configurationVersionId: 'config-v1', harnessConfiguration: {
    ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'gpt-5.6-luna', sandbox: 'read-only',
  },
})
const workflow: WorkflowDefinition = {
  id: 'workflow-live', workspaceId: 'workspace-live', name: 'Live workflow',
  executionCondition: { kind: 'manual' },
  nodes: [{ id: 'node-one', agentId: agent.id, name: agent.name, position: { x: 80, y: 100 }, initialPrompt: 'Saved prompt' }],
  edges: [],
}
const draft: GraphDraft = {
  id: 'draft-live', workspaceId: workflow.workspaceId, workflowId: workflow.id,
  revision: 3, publishedRevision: 3, layoutRevision: 0, baseWorkflowVersionId: 'workflow-v1',
  graph: workflow, stagedAgents: [], updatedByPrincipalId: 'principal-one', updatedAt: '2026-09-24T00:00:00.000Z',
}
const key = workflowDraftKey(workflow.workspaceId, workflow.id)
let client: QueryClient

function contextDraft(): GraphDraft {
  return client.getQueryData<{ draft: GraphDraft }>(queryKeys.managedGraphContext(workflow.workspaceId, workflow.id))!.draft
}
const running: WorkflowRunSummary = {
  id: 'run-live', workspaceId: workflow.workspaceId, workflowId: workflow.id,
  executionCondition: { kind: 'manual' }, executionState: 'running', outcome: 'pending',
  authRequired: false, browserWait: null, runnerHealth: { status: 'unknown' },
}
function mount(value = draft, runFacts?: WorkflowRunSummary[]) {
  client.setQueryData(queryKeys.managedGraphContext(workflow.workspaceId, workflow.id), {
    draft: value, agents: { items: [{ agent, metadataRevision: 1 }], pageInfo: { nextCursor: null } },
  })
  return render(<QueryClientProvider client={client}>
    <GraphEditor workspaceId={workflow.workspaceId} workflow={value.graph} agents={[agent]} runFacts={runFacts}
      managedDraft={value} managedAgentRevisions={{ [agent.id]: 1 }} />
  </QueryClientProvider>)
}
function move(x: number, y: number) {
  act(() => {
    const node = mocks.flow!.nodes![0]!
    mocks.flow!.onNodeDragStart?.({} as never, node, [node])
    mocks.flow!.onNodesChange?.([{ type: 'position', id: node.id, position: { x, y }, dragging: true }])
    mocks.flow!.onNodesChange?.([{ type: 'position', id: node.id, dragging: false }])
  })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  mocks.flow = null
  mocks.layout.mockReset().mockImplementation(async (input: { expectedLayoutRevision: number; nodeId: string; position: { x: number; y: number } }) => ({
    value: { draftId: draft.id, layoutRevision: input.expectedLayoutRevision + 1,
      nodeId: input.nodeId, position: input.position }, replayed: false,
  }))
  mocks.readback.mockReset(); mocks.apply.mockReset(); mocks.save.mockReset(); mocks.revert.mockReset()
})
afterEach(() => {
  cleanup(); client.clear(); managedSaveQueue.reset(); useGraphDraftStore.getState().clearAllDrafts()
  vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear()
})

it('T2 persists movement during a Run without executable controls or draft revision changes', async () => {
  client.setQueryData(queryKeys.run(workflow.workspaceId, running.id), {
    run: { ...running, workflowVersionId: 'workflow-v1', agentConfigurationVersionIds: { [agent.id]: 'config-v1' },
      input: {}, createdAt: '2026-09-24T00:00:00.000Z' }, executions: [], activity: [],
  })
  mount(draft, [running])
  move(220, 240)
  await waitFor(() => expect(mocks.layout).toHaveBeenCalledOnce())
  await waitFor(() => expect(contextDraft().graph.nodes[0]?.position).toEqual({ x: 220, y: 240 }))
  expect(contextDraft().revision).toBe(3)
  expect(contextDraft().layoutRevision).toBe(1)
  expect(getGraphDraft(key)).toBeUndefined()
  expect(mocks.apply).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Cancel workflow' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Discard local edits' })).not.toBeInTheDocument()
})

it('T2 replays an uncertain layout command with the same ID after remount', async () => {
  mocks.layout.mockRejectedValueOnce(new Error('Connection lost'))
  const view = mount()
  move(260, 280)
  await waitFor(() => expect(screen.getByText(/Node layout could not be saved/)).toBeVisible())
  const first = mocks.layout.mock.calls[0]![0]
  view.unmount()
  mount()
  await waitFor(() => expect(mocks.layout).toHaveBeenCalledTimes(2))
  expect(mocks.layout.mock.calls[1]![0]).toEqual(first)
  await waitFor(() => expect(contextDraft().graph.nodes[0]?.position).toEqual({ x: 260, y: 280 }))
})

it('T2 refuses an uncertain layout command after a cross-tab identity rotation and reload', async () => {
  localStorage.setItem(identityEpochKey, 'identity-a')
  mocks.layout.mockRejectedValueOnce(new Error('Connection lost'))
  const view = mount()
  move(260, 280)
  await waitFor(() => expect(screen.getByText(/Node layout could not be saved/)).toBeVisible())
  const oldQueueKey = managedLayoutQueueKey(key, draft.id)
  expect(sessionStorage.getItem(oldQueueKey)).not.toBeNull()

  view.unmount()
  localStorage.setItem(identityEpochKey, 'identity-b')
  mount()
  await act(async () => { await Promise.resolve(); await Promise.resolve() })

  expect(mocks.layout).toHaveBeenCalledOnce()
  expect(sessionStorage.getItem(oldQueueKey)).not.toBeNull()
  expect(sessionStorage.getItem(managedLayoutQueueKey(key, draft.id))).toBeNull()
})

it('T2 keeps a conflicted move visible and uses a fresh command after a later explicit move', async () => {
  const remote = { ...draft, layoutRevision: 1, graph: {
    ...workflow, nodes: [{ ...workflow.nodes[0]!, position: { x: 440, y: 460 } }],
  } }
  mocks.layout.mockRejectedValueOnce(new ApiError({ code: 'LAYOUT_REVISION_CONFLICT', message: 'Concurrent layout writer' }, 409))
  mocks.readback.mockResolvedValue({ draft: remote,
    agents: { items: [{ agent, metadataRevision: 1 }], pageInfo: { nextCursor: null } } })
  mount()
  move(260, 280)
  await waitFor(() => expect(screen.getByText(/Node layout changed elsewhere/)).toBeVisible())
  const rejected = mocks.layout.mock.calls[0]![0]
  expect(mocks.flow!.nodes![0]?.position).toEqual({ x: 260, y: 280 })
  expect(contextDraft().graph.nodes[0]?.position).toEqual({ x: 80, y: 100 })
  expect(mocks.readback).not.toHaveBeenCalled()

  move(300, 320)
  await waitFor(() => expect(mocks.layout).toHaveBeenCalledTimes(2))
  expect(mocks.readback).toHaveBeenCalledOnce()
  const retried = mocks.layout.mock.calls[1]![0]
  expect(retried.commandId).not.toBe(rejected.commandId)
  expect(retried.expectedLayoutRevision).toBe(1)
  expect(retried.position).toEqual({ x: 300, y: 320 })
  await waitFor(() => expect(contextDraft().graph.nodes[0]?.position).toEqual({ x: 300, y: 320 }))
  expect(contextDraft().revision).toBe(3)
})

it('T6 Discard removes local meaning and keeps the surviving moved node immediately and after remount', async () => {
  const view = mount()
  act(() => useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({
    ...current,
    nodes: [
      { ...current.nodes[0]!, initialPrompt: 'Staged prompt' },
      { id: 'node-two', agentId: agent.id, name: 'New Coder', position: { x: 400, y: 100 } },
    ],
    edges: [{ id: 'edge-new', source: 'node-one', target: 'node-two' }],
  }), [], captureManagedBase(draft, [agent], { [agent.id]: 1 })))
  move(320, 340)
  await waitFor(() => expect(contextDraft().graph.nodes[0]?.position).toEqual({ x: 320, y: 340 }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard local edits' }))
  await waitFor(() => expect(getGraphDraft(key)).toBeUndefined())
  expect(mocks.flow!.nodes![0]?.position).toEqual({ x: 320, y: 340 })
  expect(mocks.flow!.nodes).toHaveLength(1)
  expect(mocks.revert).not.toHaveBeenCalled()
  view.unmount()
  mount(contextDraft())
  expect(mocks.flow!.nodes![0]?.position).toEqual({ x: 320, y: 340 })
  expect(mocks.flow!.nodes![0]?.data.initialPrompt).toBe('Saved prompt')
})

it('T3 reverts the exact acknowledged Apply after publication 409 before clearing local settings', async () => {
  mount()
  const changed = AgentSchema.parse({ ...agent, harness: 'opencode', model: 'opencode-go/qwen3.8-flash',
    harnessConfiguration: { ...DEFAULT_HARNESS_DEFAULTS.opencode, model: 'opencode-go/qwen3.8-flash' } })
  act(() => mocks.flow!.nodes![0]!.data.onSaveSettings?.('node-one', changed, 'Saved prompt',
    { maxNodeExecutions: 1, maxParallelism: 1 }))
  mocks.apply.mockImplementation(async () => ({
    value: { draft: { ...draft, revision: 4, stagedAgents: [{ agent: changed, baseRevision: 1 }] }, effects: [] },
    replayed: false,
  }))
  mocks.save.mockRejectedValue(new ApiError({ code: 'WORKFLOW_RUNS_UNSETTLED', message: 'Active Run' }, 409))
  fireEvent.click(screen.getByRole('button', { name: 'Save graph' }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
  await waitFor(() => expect(managedSaveQueue.hasAppliedEdits(key)).toBe(true))
  let finishRevert!: (value: unknown) => void
  mocks.revert.mockImplementation(() => new Promise((resolve) => { finishRevert = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard local edits' }))
  await waitFor(() => expect(mocks.revert).toHaveBeenCalledOnce())
  expect(mocks.revert.mock.calls[0]![0].applyCommandId).toBe(mocks.apply.mock.calls[0]![0].commandId)
  expect(getGraphDraft(key)).toBeDefined()
  await act(async () => finishRevert({ value: { draft: { ...draft, revision: 5, publishedRevision: 5 } }, replayed: false }))
  await waitFor(() => expect(getGraphDraft(key)).toBeUndefined())
  expect(contextDraft().stagedAgents).toEqual([])
  expect(contextDraft().publishedRevision).toBe(contextDraft().revision)
  expect(client.getQueryData<{ agents: { items: Array<{ agent: typeof agent }> } }>(
    queryKeys.managedGraphContext(workflow.workspaceId, workflow.id))?.agents.items[0]?.agent.model).toBe('gpt-5.6-luna')
})

it('T3 keeps local settings when a concurrent edit conflicts with the fenced revert', async () => {
  mount()
  const changed = AgentSchema.parse({ ...agent, model: 'gpt-5.6-terra',
    harnessConfiguration: { ...agent.harnessConfiguration!, model: 'gpt-5.6-terra' } })
  act(() => mocks.flow!.nodes![0]!.data.onSaveSettings?.('node-one', changed, 'Saved prompt',
    { maxNodeExecutions: 1, maxParallelism: 1 }))
  mocks.apply.mockImplementation(async () => ({
    value: { draft: { ...draft, revision: 4, stagedAgents: [{ agent: changed, baseRevision: 1 }] }, effects: [] },
    replayed: false,
  }))
  mocks.save.mockRejectedValue(new ApiError({ code: 'WORKFLOW_RUNS_UNSETTLED', message: 'Active Run' }, 409))
  fireEvent.click(screen.getByRole('button', { name: 'Save graph' }))
  await waitFor(() => expect(managedSaveQueue.hasAppliedEdits(key)).toBe(true))
  mocks.revert.mockRejectedValue(new ApiError({ code: 'REVISION_CONFLICT', message: 'Shared draft changed' }, 409))
  fireEvent.click(screen.getByRole('button', { name: 'Discard local edits' }))
  await waitFor(() => expect(screen.getByText(/Local edits were retained: Shared draft changed/)).toBeVisible())
  expect(getGraphDraft(key)?.agentOverrides[agent.id]?.model).toBe('gpt-5.6-terra')
  expect(managedSaveQueue.hasAppliedEdits(key)).toBe(true)
})
