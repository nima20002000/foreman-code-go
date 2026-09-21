import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Agent, WorkflowDefinition, WorkflowRun, WorkflowRunSummary } from '@graphql/contracts'
import type { GraphDraft } from '@graphql/contracts/management'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { queryKeys } from '../../shared/api/query'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { GraphEditor } from './GraphEditor'
import { captureManagedBase } from './managedGraphState'
import { managedSaveQueue } from './managedSave'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'

// These existing tests isolate editor behavior; pr12-navigation.test.tsx covers the real router Link.
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  const React = await vi.importActual<typeof import('react')>('react')
  return { ...actual, Link: ({ children, className, ...props }: {
    children?: import('react').ReactNode; className?: string; 'aria-label'?: string; title?: string
  }) => React.createElement('a', { href: '#', className, 'aria-label': props['aria-label'], title: props.title }, children) }
})

const agents: Agent[] = [{ id: 'agent-one', name: 'Researcher', configurationVersionId: 'config-one' }]
const workflow: WorkflowDefinition = {
  id: 'workflow-controls', workspaceId: 'workspace-1', name: 'Execution controls',
  executionCondition: { kind: 'manual' },
  executionPolicy: { maxNodeExecutions: 3, maxParallelism: 1 },
  nodes: ['a', 'b', 'c'].map((id, index) => ({ id, agentId: 'agent-one', name: id, position: { x: 100 + index * 300, y: 100 } })),
  edges: [{ id: 'a-b', source: 'a', target: 'b' }, { id: 'b-c', source: 'b', target: 'c' }],
}
const run: WorkflowRun = {
  id: 'run-controls', workspaceId: workflow.workspaceId, workflowId: workflow.id,
  workflowVersionId: 'workflow-controls-v1', agentConfigurationVersionIds: { 'agent-one': 'config-one' },
  executionCondition: { kind: 'manual' }, executionState: 'queued', outcome: 'pending', input: {},
  createdAt: '2026-09-14T00:00:00.000Z',
}
let client: QueryClient

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
})
afterEach(() => {
  managedSaveQueue.reset()
  client.clear()
  vi.unstubAllGlobals()
  useGraphDraftStore.getState().clearAllDrafts()
  useAgentDirectoryStore.getState().reset()
  sessionStorage.clear()
})

function editor(managedDraft?: GraphDraft) {
  return render(<QueryClientProvider client={client}>
    <GraphEditor workspaceId={workflow.workspaceId} workflow={workflow} agents={agents} managedDraft={managedDraft} />
  </QueryClientProvider>)
}

const savedDraft: GraphDraft = {
  id: 'draft-controls', workspaceId: workflow.workspaceId, workflowId: workflow.id,
  revision: 1, publishedRevision: 1, baseWorkflowVersionId: 'workflow-controls-v1', graph: workflow,
  stagedAgents: [], updatedByPrincipalId: 'principal-1', updatedAt: '2026-09-15T00:00:00.000Z',
}

it('does not offer Save for a clean published graph', () => {
  editor(savedDraft)
  expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Discard local edits' })).not.toBeInTheDocument()
})

it('does not nag or show local-edit controls for an untouched shared draft', () => {
  const emptyWorkflow = { ...workflow, nodes: [], edges: [] }
  const emptyDraft: GraphDraft = { ...savedDraft, revision: 0, publishedRevision: undefined,
    baseWorkflowVersionId: null, graph: emptyWorkflow }
  const view = render(<QueryClientProvider client={client}>
    <GraphEditor workspaceId={workflow.workspaceId} workflow={emptyWorkflow} agents={agents} managedDraft={emptyDraft} />
  </QueryClientProvider>)

  expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Discard local edits' })).not.toBeInTheDocument()
  expect(screen.queryByText('Add an Agent before saving this workflow.')).not.toBeInTheDocument()

  view.rerender(<QueryClientProvider client={client}>
    <GraphEditor workspaceId={workflow.workspaceId} workflow={workflow} agents={agents}
      managedDraft={{ ...emptyDraft, revision: 1, graph: workflow }} />
  </QueryClientProvider>)
  expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Discard local edits' })).not.toBeInTheDocument()
  expect(screen.queryByText('The shared draft has unpublished changes. Save graph before starting it.')).not.toBeInTheDocument()
})

it('explains an empty graph only after Save is attempted and keeps the edit', async () => {
  const key = workflowDraftKey(workflow.workspaceId, workflow.id)
  const emptyWorkflow = { ...workflow, nodes: [], edges: [] }
  act(() => useGraphDraftStore.getState().updateDraft(key, workflow, () => emptyWorkflow, [], captureManagedBase(savedDraft, agents, {})))
  editor(savedDraft)

  expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Discard local edits' })).toBeEnabled()
  expect(screen.queryByText('Add an Agent before saving this workflow.')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save graph' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Add an Agent before saving this workflow.')
  expect(getGraphDraft(key)?.workflow.nodes).toEqual([])
})

it('keeps Save available to retry an uncertain managed publication', async () => {
  const key = workflowDraftKey(workflow.workspaceId, workflow.id)
  const base = captureManagedBase(savedDraft, agents, {})
  await expect(managedSaveQueue.run(key, () => ({
    submitted: { workflow, agentOverrides: {}, managedBase: base }, base, operations: [],
  }), {
    apply: async () => { throw new Error('Unexpected apply') },
    save: async () => { throw new Error('Network lost') },
    onApplied: () => undefined,
    onSaved: () => undefined,
    setSaving: () => undefined,
    assertSession: () => undefined,
  })).rejects.toThrow('Network lost')

  editor(savedDraft)
  expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()
  expect(screen.getByText('The previous save is unresolved. Retry Save graph before discarding local edits or starting.')).toBeVisible()
})

it('disables managed Start until the backend reports a ready execution location', async () => {
  const managedDraft: GraphDraft = {
    id: 'draft-controls', workspaceId: workflow.workspaceId, workflowId: workflow.id,
    revision: 1, publishedRevision: 1, baseWorkflowVersionId: 'workflow-controls-v1', graph: workflow,
    stagedAgents: [], updatedByPrincipalId: 'principal-1', updatedAt: '2026-09-15T00:00:00.000Z',
  }
  client.setQueryData(queryKeys.managedWorkspace(workflow.workspaceId), {
    workspace: { id: workflow.workspaceId, name: 'Workspace' }, revision: 1, archivedAt: null,
    executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' },
  })
  editor(managedDraft)
  const start = screen.getByRole('button', { name: 'Start workflow' })
  expect(start).toBeDisabled()
  expect(start).toHaveAttribute('title', 'Set a valid workspace execution location first')

  act(() => client.setQueryData(queryKeys.managedWorkspace(workflow.workspaceId), {
    workspace: { id: workflow.workspaceId, name: 'Workspace' }, revision: 1, archivedAt: null,
    executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' }, locationRevision: 1,
    locationValidation: { status: 'ready', checkedAt: '2026-09-15T00:00:00.000Z' },
  }))
  await waitFor(() => expect(start).toBeEnabled())
})

it('locks Start after 202 while details are delayed or queued; unlocks only at completion', async () => {
  let resolveDetails!: (response: Response) => void
  const details = new Promise<Response>((resolve) => { resolveDetails = resolve })
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ run }, { status: 202 })
    return details
  })
  vi.stubGlobal('fetch', fetch)
  editor()
  const start = screen.getByRole('button', { name: 'Start workflow' })
  await userEvent.setup().click(start)
  expect(await screen.findByRole('button', { name: 'Cancel workflow' })).toBeVisible()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  await act(async () => { resolveDetails(Response.json({ run, executions: [], activity: [] })) })
  expect(screen.getByRole('button', { name: 'Cancel workflow' })).toBeVisible()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  act(() => {
    client.setQueryData(queryKeys.run(workflow.workspaceId, run.id), {
      run: { ...run, executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: '2026-09-14T00:01:00.000Z' },
      executions: [], activity: [],
    })
  })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start workflow' })).toBeEnabled())
})

it('keeps a canceled historical execution out of live node state after remount', async () => {
  const canceledRun: WorkflowRun = {
    ...run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' },
    finishedAt: '2026-09-14T00:01:00.000Z',
  }
  const runFacts: WorkflowRunSummary[] = [{
    id: run.id, workspaceId: workflow.workspaceId, workflowId: workflow.id,
    executionCondition: run.executionCondition, executionState: 'completed', outcome: 'canceled',
    authRequired: false, browserWait: null, runnerHealth: { status: 'healthy' },
    finishedAt: '2026-09-14T00:01:00.000Z',
  }]
  client.setQueryData(queryKeys.run(workflow.workspaceId, run.id), {
    run: canceledRun,
    executions: [{ workflowNodeId: 'a', state: 'completed', result: { outcome: 'canceled' } }],
    activity: [],
  })
  const renderCanceled = () => render(<QueryClientProvider client={client}>
    <GraphEditor workspaceId={workflow.workspaceId} workflow={workflow} agents={agents} runFacts={runFacts} />
  </QueryClientProvider>)

  const first = renderCanceled()
  expect(screen.getAllByText('Idle').every((badge) => badge.closest('[data-tone]')?.getAttribute('data-tone') === 'neutral')).toBe(true)
  expect(screen.queryByText('Canceled')).not.toBeInTheDocument()
  first.unmount()
  renderCanceled()

  expect(screen.getAllByText('Idle').every((badge) => badge.closest('[data-tone]')?.getAttribute('data-tone') === 'neutral')).toBe(true)
  expect(screen.getByRole('button', { name: 'Start workflow' })).toBeEnabled()
})

it('explains the fourth-step safety limit when Save is attempted', async () => {
  editor()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Add agent to graph' }))
  await user.click(await screen.findByRole('button', { name: 'Orchestrator' }))
  expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Save graph' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Review the execution limit before saving this graph.')
  expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))?.workflow.executionPolicy?.maxNodeExecutions).toBe(3)
  await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
  const limit = screen.getByRole('spinbutton', { name: 'Maximum node executions' })
  expect(limit).toHaveAttribute('aria-invalid', 'true')
  fireEvent.change(limit, { target: { value: '4' } })
  await user.click(screen.getByRole('button', { name: 'Apply workflow limits to draft' }))
  expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()
  expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))?.workflow.executionPolicy?.maxNodeExecutions).toBe(4)
})

it('does not show board save controls without a meaningful graph or agent change', () => {
  editor()
  expect(screen.queryByRole('button', { name: 'Apply to draft' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))).toBeUndefined()
})
