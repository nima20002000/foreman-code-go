import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Agent, WorkflowDefinition } from '@graphql/contracts'

import { setMockScenario } from '../../shared/mocks/scenarios'
import { queryKeys } from '../../shared/api/query'
import { GraphEditor } from './GraphEditor'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'
import { deleteAgentForSession, readDeletedAgentIds } from '../agents/localAgents'

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react')
  type ResizeTestProps = {
    isVisible?: boolean
    minWidth?: number
    maxWidth?: number
    minHeight?: number
    maxHeight?: number
    onResizeEnd?: (event: unknown, size: { width: number; height: number }) => void
  }
  return {
    ...actual,
    NodeResizer: ({ isVisible, minWidth, maxWidth, minHeight, maxHeight, onResizeEnd }: ResizeTestProps) => isVisible ? (
      <button
        type="button"
        className="nodrag"
        aria-label="Resize selected node"
        data-min-width={minWidth}
        data-max-width={maxWidth}
        data-min-height={minHeight}
        data-max-height={maxHeight}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => onResizeEnd?.({}, { width: 10_000, height: 10 })}
      >
        Resize
      </button>
    ) : null,
  }
})

const workflow: WorkflowDefinition = {
  id: 'workflow-editor-test',
  workspaceId: 'workspace-1',
  name: 'Editor test workflow',
  executionCondition: { kind: 'manual' },
  nodes: [
    { id: 'step-one', agentId: 'agent-one', name: 'Researcher', position: { x: 80, y: 100 } },
    { id: 'step-two', agentId: 'agent-two', name: 'Developer', position: { x: 380, y: 100 } },
  ],
  edges: [{ id: 'edge-one', source: 'step-one', target: 'step-two' }],
}

const agents: Agent[] = [
  { id: 'agent-one', name: 'Researcher', executionState: 'available' },
  { id: 'agent-two', name: 'Developer', executionState: 'working' },
]

function renderEditor(overrides: Partial<ComponentProps<typeof GraphEditor>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <GraphEditor workspaceId={workflow.workspaceId} workflow={workflow} agents={agents} {...overrides} />
      </QueryClientProvider>,
    ),
  }
}

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  setMockScenario('normal')
  useGraphDraftStore.getState().clearAllDrafts()
  sessionStorage.clear()
  vi.useRealTimers()
})

describe('GraphEditor persistence boundary', () => {
  it('adds a catalog agent through an accessible picker and makes it discardable', async () => {
    const user = userEvent.setup()
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor()

    const add = screen.getByRole('button', { name: 'Add agent to graph' })
    await user.click(add)
    const dialog = screen.getByRole('dialog', { name: 'Add agent to graph' })
    expect(dialog).toBeVisible()
    expect(dialog.querySelector('[data-agent-picker-option]')).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Add agent to graph' })).not.toBeInTheDocument()
    expect(add).toHaveFocus()

    await user.click(add)
    await user.click(screen.getByRole('dialog', { name: 'Add agent to graph' }).querySelector('[data-agent-picker-option]') as HTMLElement)
    expect(getGraphDraft(key)?.workflow.nodes).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(getGraphDraft(key)).toBeUndefined()
  })

  it('shows an honest directory link when the agent catalog is empty', async () => {
    renderEditor({ agents: [] })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add agent to graph' }))

    expect(screen.getByText('No agents are available in this workspace.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open Agents directory' })).toHaveAttribute('href', '/workspaces/workspace-1/agents')
  })

  it('offers only Unlink and Delete, keeps inside clicks open, and unlinks one graph reference', async () => {
    const user = userEvent.setup()
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor()

    const trigger = screen.getByRole('button', { name: 'Open actions for Researcher' })
    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Researcher node actions' })
    expect(menu).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'Unlink' })).toHaveFocus()
    expect(screen.queryByRole('menuitem', { name: 'Copy' })).not.toBeInTheDocument()
    fireEvent.mouseDown(menu)
    expect(menu).toBeVisible()
    await user.click(screen.getByRole('menuitem', { name: 'Unlink' }))

    expect(screen.queryByRole('menu', { name: 'Researcher node actions' })).not.toBeInTheDocument()
    expect(getGraphDraft(key)?.workflow.nodes).toHaveLength(2)
    expect(getGraphDraft(key)?.workflow.edges).toHaveLength(0)
    expect(readDeletedAgentIds(workflow.workspaceId)).toEqual([])
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Researcher agent, Step 1' })).toBeVisible()
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Add agent to graph' }))
    expect(within(screen.getByRole('dialog', { name: 'Add agent to graph' })).getByRole('button', { name: /Researcher/ })).toBeVisible()
  })

  it('connects node one to node two by sequential clicks and round-trips through discard and save', async () => {
    const disconnectedWorkflow = { ...workflow, edges: [] }
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    const onSelectAgent = vi.fn()
    const user = userEvent.setup()
    const { queryClient } = renderEditor({ workflow: disconnectedWorkflow, onSelectAgent })

    fireEvent.click(screen.getByRole('button', { name: 'Researcher agent, Step 1' }))
    expect(screen.getByTestId('agent-node-agent-one')).toHaveAttribute('data-connection-armed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Researcher is the connection source')
    fireEvent.click(screen.getByRole('button', { name: 'Developer agent, Step 2' }))

    expect(getGraphDraft(key)?.workflow.edges).toEqual([expect.objectContaining({
      source: 'step-one',
      target: 'step-two',
      label: 'Sequential output handoff',
    })])
    expect(screen.queryByText(/is the connection source/)).not.toBeInTheDocument()
    expect(screen.getByText(/Agent steps connected/)).toBeVisible()
    expect(onSelectAgent).toHaveBeenNthCalledWith(1, 'agent-one')
    expect(onSelectAgent).toHaveBeenNthCalledWith(2, 'agent-two')

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(getGraphDraft(key)).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: 'Researcher agent, Step 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Developer agent, Step 2' }))
    await user.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.workflow(workflow.workspaceId, workflow.id))).toEqual({
      workflow: expect.objectContaining({
        edges: [expect.objectContaining({ source: 'step-one', target: 'step-two' })],
      }),
    }))
  })

  it('prevents self-links and duplicate links and cancels arming from Escape or the blank canvas', async () => {
    const user = userEvent.setup()
    const onClearAgent = vi.fn()
    renderEditor({ onClearAgent })
    const researcher = screen.getByRole('button', { name: 'Researcher agent, Step 1' })
    const developer = screen.getByRole('button', { name: 'Developer agent, Step 2' })

    fireEvent.click(researcher)
    fireEvent.click(researcher)
    expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))).toBeUndefined()
    expect(screen.getByText(/Connection canceled/)).toBeVisible()

    fireEvent.click(researcher)
    await user.keyboard('{Escape}')
    expect(screen.queryByText(/is the connection source/)).not.toBeInTheDocument()
    expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))).toBeUndefined()

    fireEvent.click(researcher)
    fireEvent.click(document.querySelector('.react-flow__pane') as HTMLElement)
    expect(screen.queryByText(/is the connection source/)).not.toBeInTheDocument()
    expect(onClearAgent).toHaveBeenCalledOnce()

    fireEvent.click(researcher)
    fireEvent.click(developer)
    expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))).toBeUndefined()
    expect(screen.getByText('Those agent steps are already connected.')).toBeVisible()
  })

  it('dismisses the anchored node menu from Escape or an outside click and restores trigger focus', async () => {
    const user = userEvent.setup()
    renderEditor()
    const trigger = screen.getByRole('button', { name: 'Open actions for Researcher' })

    await user.click(trigger)
    expect(screen.getByRole('menu', { name: 'Researcher node actions' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'Researcher node actions' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu', { name: 'Researcher node actions' })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('cancels deletion from Escape or Cancel without changing the catalog or graph', async () => {
    const user = userEvent.setup()
    renderEditor()
    const trigger = screen.getByRole('button', { name: 'Open actions for Researcher' })

    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.queryByRole('menu', { name: 'Researcher node actions' })).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog', { name: 'Delete Researcher from this session?' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(readDeletedAgentIds(workflow.workspaceId)).toEqual([])
    expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Researcher agent, Step 1' })).toBeVisible()
  })

  it('deletes an agent for the browser session, cleans every reference, and keeps cleanup after discard', async () => {
    const repeatedWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        { id: 'step-three', agentId: 'agent-one', name: 'Researcher again', position: { x: 680, y: 100 } },
      ],
      edges: [
        ...workflow.edges,
        { id: 'edge-two', source: 'step-three', target: 'step-two' },
      ],
    }
    const key = workflowDraftKey(repeatedWorkflow.workspaceId, repeatedWorkflow.id)
    const user = userEvent.setup()
    const { queryClient } = renderEditor({ workflow: repeatedWorkflow })

    await user.click(screen.getAllByRole('button', { name: 'Open actions for Researcher' })[0] as HTMLElement)
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('It does not delete backend data')
    await user.click(screen.getByRole('button', { name: 'Delete for this session' }))

    expect(getGraphDraft(key)?.workflow.nodes.map((node) => node.agentId)).toEqual(['agent-two'])
    expect(getGraphDraft(key)?.workflow.edges).toEqual([])
    expect(readDeletedAgentIds(workflow.workspaceId)).toEqual(['agent-one'])
    expect(screen.queryByRole('button', { name: /Researcher agent/ })).not.toBeInTheDocument()
    expect(screen.getByText(/removed for this browser session/)).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add agent to graph' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(getGraphDraft(key)).toBeUndefined()
    expect(screen.queryByRole('button', { name: /Researcher agent/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()
    expect(screen.getByText(/Session-deleted agents and their references stay removed/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Add agent to graph' }))
    expect(within(screen.getByRole('dialog', { name: 'Add agent to graph' })).queryByRole('button', { name: /Researcher/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close agent picker' }))
    await user.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.workflow(repeatedWorkflow.workspaceId, repeatedWorkflow.id))).toEqual({
      workflow: expect.objectContaining({
        nodes: [expect.objectContaining({ agentId: 'agent-two' })],
        edges: [],
      }),
    }))
  })

  it('restores session deletion cleanup after a reload-like remount', async () => {
    deleteAgentForSession(workflow.workspaceId, 'agent-one')
    const first = renderEditor()
    expect(screen.queryByRole('button', { name: /Researcher agent/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()

    first.unmount()
    useGraphDraftStore.getState().clearAllDrafts()
    renderEditor()
    expect(screen.queryByRole('button', { name: /Researcher agent/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Developer agent, Step 1' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()
  })

  it('resizes a selected node within bounds and supports discard and save', async () => {
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    const user = userEvent.setup()
    const first = renderEditor({ selectedAgentId: 'agent-one' })
    const resize = screen.getByRole('button', { name: 'Resize selected node' })
    expect(resize).toHaveAttribute('data-min-width', '214')
    expect(resize).toHaveAttribute('data-max-width', '520')
    expect(resize).toHaveAttribute('data-min-height', '92')
    expect(resize).toHaveAttribute('data-max-height', '320')

    await user.click(resize)
    expect(getGraphDraft(key)?.workflow.nodes[0]).toMatchObject({ width: 520, height: 92 })
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(getGraphDraft(key)).toBeUndefined()
    first.unmount()

    const second = renderEditor({ selectedAgentId: 'agent-one' })
    await user.click(screen.getByRole('button', { name: 'Resize selected node' }))
    await user.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(second.queryClient.getQueryData(queryKeys.workflow(workflow.workspaceId, workflow.id))).toEqual({
      workflow: expect.objectContaining({
        nodes: expect.arrayContaining([expect.objectContaining({ id: 'step-one', width: 520, height: 92 })]),
      }),
    }))
  })

  it('keeps actions over the canvas and dismisses discard feedback as a toast', () => {
    vi.useFakeTimers()
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({ ...current, name: 'Edited locally' }))
    renderEditor()

    const canvas = screen.getByTestId('workflow-graph-canvas')
    const actions = screen.getByLabelText('Graph actions')
    expect(canvas).toContainElement(actions)
    expect(document.querySelector('.workflow-graph-toolbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Saved definition')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const toast = screen.getByText('Local graph changes discarded.')
    expect(toast).toHaveClass('workflow-graph-toast')
    expect(toast).toHaveAttribute('role', 'status')
    expect(toast).toHaveAttribute('aria-live', 'polite')

    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.queryByText('Local graph changes discarded.')).not.toBeInTheDocument()
  })

  it('saves a dirty draft and updates the workflow query cache', async () => {
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({ ...current, name: 'Edited locally' }))
    const { queryClient } = renderEditor()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Save graph' }))

    await waitFor(() => expect(screen.getByText('Graph saved.')).toBeVisible())
    expect(getGraphDraft(key)).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.workflow(workflow.workspaceId, workflow.id))).toEqual({ workflow: expect.objectContaining({ name: 'Edited locally' }) })
  })

  it('shows save errors and retains the dirty draft', async () => {
    setMockScenario('normal', 'graph-save')
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({ ...current, name: 'Keep this local edit' }))
    renderEditor()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Save graph' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Graph could not be saved'))
    expect(getGraphDraft(key)?.workflow.name).toBe('Keep this local edit')
  })
})
