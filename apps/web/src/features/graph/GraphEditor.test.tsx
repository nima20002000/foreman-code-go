import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Agent, WorkflowDefinition } from '@graphql/contracts'

import { setMockScenario } from '../../shared/mocks/scenarios'
import { queryKeys } from '../../shared/api/query'
import { AgentMinimapDot, GraphEditor, HandoffEdge } from './GraphEditor'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'
import { deleteAgentForSession, readDeletedAgentIds } from '../agents/localAgents'
import { Position } from '@xyflow/react'

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
  it('starts a workflow through the API boundary and reads its result', async () => {
    renderEditor()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Start workflow' }))

    expect(await screen.findByTestId('workflow-run-status')).toHaveTextContent('run-mock-started')
    await waitFor(() => expect(screen.getByTestId('workflow-run-status')).toHaveTextContent('Run completed'))
    expect(screen.getByTestId('workflow-run-status')).toHaveTextContent('Mock test result')
  })

  it('adds a catalog agent through an accessible picker and makes it discardable', async () => {
    const user = userEvent.setup()
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor()

    const add = screen.getByRole('button', { name: 'Add agent to graph' })
    await user.click(add)
    const dialog = screen.getByRole('dialog', { name: 'Add agent to graph' })
    expect(dialog).toBeVisible()
    expect(dialog).toHaveClass('agent-picker-popover')
    expect(document.querySelector('.agent-picker-backdrop')).not.toBeInTheDocument()
    expect(dialog.querySelector('[data-agent-picker-option]')).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Add agent to graph' })).not.toBeInTheDocument()
    expect(add).toHaveFocus()

    await user.click(add)
    await user.click(screen.getByRole('dialog', { name: 'Add agent to graph' }).querySelector('[data-agent-picker-option]') as HTMLElement)
    expect(getGraphDraft(key)?.workflow.nodes).toHaveLength(3)
    expect(screen.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Close agent picker' }))
    expect(screen.queryByRole('dialog', { name: 'Add agent to graph' })).not.toBeInTheDocument()
    expect(add).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(getGraphDraft(key)).toBeUndefined()
  })

  it('keeps the picker open and leaves consecutively added agents disconnected', async () => {
    const user = userEvent.setup()
    const emptyWorkflow = { ...workflow, nodes: [], edges: [] }
    const key = workflowDraftKey(emptyWorkflow.workspaceId, emptyWorkflow.id)
    renderEditor({ workflow: emptyWorkflow })

    await user.click(screen.getByRole('button', { name: 'Add agent to graph' }))
    const dialog = screen.getByRole('dialog', { name: 'Add agent to graph' })
    await user.click(within(dialog).getByRole('button', { name: /Researcher/ }))
    expect(dialog).toBeVisible()
    expect(getGraphDraft(key)?.workflow.nodes).toHaveLength(1)
    expect(getGraphDraft(key)?.workflow.edges).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: /Developer/ }))
    expect(dialog).toBeVisible()
    expect(getGraphDraft(key)?.workflow.nodes).toHaveLength(2)
    expect(getGraphDraft(key)?.workflow.edges).toEqual([])
  })

  it('shows an honest directory link when the agent catalog is empty', async () => {
    renderEditor({ agents: [] })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add agent to graph' }))

    expect(screen.getByText('No agents are available in this workspace.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open Agents directory' })).toHaveAttribute('href', '/workspaces/workspace-1/agents')
  })

  it('offers graph-only actions, keeps inside clicks open, and unlinks one graph reference', async () => {
    const user = userEvent.setup()
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor()

    const trigger = screen.getByRole('button', { name: 'Open actions for Researcher' })
    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Researcher node actions' })
    expect(menu).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'Unlink' })).toHaveFocus()
    expect(screen.getByRole('menuitem', { name: 'Remove from workflow' })).toBeVisible()
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

  it('connects consecutively selected nodes without showing a source toast', async () => {
    const disconnectedWorkflow = { ...workflow, edges: [] }
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    const onSelectAgent = vi.fn()
    renderEditor({ workflow: disconnectedWorkflow, onSelectAgent })

    fireEvent.click(screen.getByRole('button', { name: 'Researcher agent, Step 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Developer agent, Step 2' }))

    expect(getGraphDraft(key)?.workflow.edges).toEqual([
      expect.objectContaining({ source: 'step-one', target: 'step-two' }),
    ])
    expect(screen.queryByText(/is the connection source/)).not.toBeInTheDocument()
    expect(screen.getByTestId('workflow-graph-notifications')).toBeEmptyDOMElement()
    expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()
    expect(onSelectAgent).toHaveBeenNthCalledWith(1, 'agent-one')
    expect(onSelectAgent).toHaveBeenNthCalledWith(2, 'agent-two')
  })

  it('cancels a pending click connection when the empty canvas is selected', () => {
    const disconnectedWorkflow = { ...workflow, edges: [] }
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor({ workflow: disconnectedWorkflow })

    fireEvent.click(screen.getByRole('button', { name: 'Researcher agent, Step 1' }))
    fireEvent.click(document.querySelector('.react-flow__pane') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Developer agent, Step 2' }))

    expect(getGraphDraft(key)).toBeUndefined()
  })

  it('uses exactly one shared handle per node side for every connection', () => {
    renderEditor()

    for (const agentId of ['agent-one', 'agent-two']) {
      const handles = screen.getByTestId(`agent-node-${agentId}`).querySelectorAll('.workflow-agent-node-handle')
      expect(handles).toHaveLength(4)
      expect([...handles].map((handle) => handle.getAttribute('data-handleid'))).toEqual(['top', 'right', 'bottom', 'left'])
    }
  })

  it('does not duplicate an existing click connection and keeps explicit handles available', async () => {
    const onClearAgent = vi.fn()
    renderEditor({ onClearAgent })
    const researcher = screen.getByRole('button', { name: 'Researcher agent, Step 1' })
    const developer = screen.getByRole('button', { name: 'Developer agent, Step 2' })

    fireEvent.click(researcher)
    fireEvent.click(researcher)
    expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))).toBeUndefined()
    expect(screen.queryByText(/is the connection source/)).not.toBeInTheDocument()

    fireEvent.click(document.querySelector('.react-flow__pane') as HTMLElement)
    expect(screen.queryByText(/is the connection source/)).not.toBeInTheDocument()
    expect(onClearAgent).toHaveBeenCalledOnce()

    fireEvent.click(researcher)
    fireEvent.click(developer)
    expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))).toBeUndefined()
    expect(screen.queryByText(/is the connection source/)).not.toBeInTheDocument()
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

    await user.click(trigger)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Start workflow' }))
    expect(screen.queryByRole('menu', { name: 'Researcher node actions' })).not.toBeInTheDocument()
  })

  it('keeps a single node menu open and moves focus into the menu opened last', async () => {
    const user = userEvent.setup()
    renderEditor()
    const researcherTrigger = screen.getByRole('button', { name: 'Open actions for Researcher' })
    const developerTrigger = screen.getByRole('button', { name: 'Open actions for Developer' })

    await user.click(researcherTrigger)
    expect(screen.getByRole('menu', { name: 'Researcher node actions' })).toBeVisible()

    await user.click(developerTrigger)
    expect(screen.queryByRole('menu', { name: 'Researcher node actions' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    const developerMenu = screen.getByRole('menu', { name: 'Developer node actions' })
    const developerUnlink = within(developerMenu).getByRole('menuitem', { name: 'Unlink' })
    await waitFor(() => expect(developerUnlink).toHaveFocus())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(developerUnlink).toHaveFocus()
  })

  it('closes an open node menu when the agent picker opens from the keyboard', async () => {
    const user = userEvent.setup()
    renderEditor()
    const trigger = screen.getByRole('button', { name: 'Open actions for Researcher' })
    trigger.focus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu', { name: 'Researcher node actions' })).toBeVisible()

    const add = screen.getByRole('button', { name: 'Add agent to graph' })
    add.focus()
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()
  })

  it('dismisses the agent picker outside, ignores Escape, and supports its close control', async () => {
    const user = userEvent.setup()
    renderEditor()
    const add = screen.getByRole('button', { name: 'Add agent to graph' })
    await user.click(add)
    expect(screen.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Add agent to graph' })).not.toBeInTheDocument()
    expect(add).toHaveFocus()

    await user.click(add)
    await user.click(screen.getByRole('button', { name: 'Close agent picker' }))
    expect(screen.queryByRole('dialog', { name: 'Add agent to graph' })).not.toBeInTheDocument()
    expect(add).toHaveFocus()
  })

  it('keeps an exiting dialog backdrop inert until its exit animation finishes', () => {
    const animate = vi.fn()
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: animate,
    })
    vi.useFakeTimers()

    try {
      renderEditor()
      fireEvent.click(screen.getByRole('button', { name: 'Add agent to graph' }))
      const dialog = screen.getByRole('dialog', { name: 'Add agent to graph' })
      fireEvent.click(screen.getByRole('button', { name: 'Close agent picker' }))

      const popover = dialog.closest('.agent-picker-popover')
      expect(popover).toHaveAttribute('data-presence', 'exiting')
      expect(popover).toHaveAttribute('inert')

      act(() => vi.advanceTimersByTime(300))
      expect(screen.queryByRole('dialog', { name: 'Add agent to graph' })).not.toBeInTheDocument()
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate
      vi.useRealTimers()
    }
  })

  it('removes only the selected workflow node without deleting its agent', async () => {
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
    renderEditor({ workflow: repeatedWorkflow })

    await user.click(screen.getAllByRole('button', { name: 'Open actions for Researcher' })[0] as HTMLElement)
    await user.click(screen.getByRole('menuitem', { name: 'Remove from workflow' }))

    expect(getGraphDraft(key)?.workflow.nodes.map((node) => node.id)).toEqual(['step-two', 'step-three'])
    expect(getGraphDraft(key)?.workflow.edges.map((edge) => edge.id)).toEqual(['edge-two'])
    expect(readDeletedAgentIds(workflow.workspaceId)).toEqual([])
    expect(screen.getByRole('button', { name: 'Researcher again agent, Step 2' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(getGraphDraft(key)).toBeUndefined()
    expect(screen.getAllByRole('button', { name: /Researcher.*agent/ })).toHaveLength(2)
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

  it('keeps actions over the canvas without routine discard feedback', () => {
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
    expect(screen.queryByText('Local graph changes discarded.')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('workflow-graph-notifications')).toHaveLength(1)
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

describe('GraphEditor motion', () => {
  function enableMotion() {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
  }

  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate
  })

  it('keeps a picker closed by X mounted until its exit motion completes', () => {
    vi.useFakeTimers()
    enableMotion()
    renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Add agent to graph' }))
    expect(screen.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Close agent picker' }))
    expect(document.querySelector('.agent-picker-popover')).toHaveAttribute('data-presence', 'exiting')

    act(() => vi.advanceTimersByTime(200))
    expect(document.querySelector('.agent-picker-popover')).not.toBeInTheDocument()
  })

  it('animates a removed agent out before dropping the departing copy', () => {
    vi.useFakeTimers()
    enableMotion()
    renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Open actions for Researcher' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from workflow' }))

    expect(screen.queryByRole('button', { name: /Researcher agent/ })).not.toBeInTheDocument()
    expect(document.querySelector('.workflow-agent-node-departing')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(250))
    expect(document.querySelector('.workflow-agent-node-departing')).not.toBeInTheDocument()
  })
})

describe('Graph edge and minimap controls', () => {
  it('renders an accessible remove control on the handoff edge and reports its edge id', () => {
    const onRemove = vi.fn()
    render(
      <svg>
        <HandoffEdge
          id="edge-one"
          source="step-one"
          target="step-two"
          sourceX={0}
          sourceY={0}
          targetX={120}
          targetY={80}
          sourcePosition={Position.Right}
          targetPosition={Position.Left}
          data={{ explanation: 'test edge', onRemove }}
        />
      </svg>,
    )

    const remove = screen.getByRole('button', { name: 'Remove connection from step-one to step-two' })
    expect(remove).toHaveAttribute('title', 'Remove connection')
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledWith('edge-one')
  })

  it('renders minimap agents as blue circles while keeping the minimap node classes', () => {
    const { container } = render(
      <svg>
        <AgentMinimapDot
          id="step-one"
          x={0}
          y={0}
          width={238}
          height={92}
          className="workflow-graph-minimap-node-selected"
          selected
          color="#1d4ed8"
          strokeColor="#f2f2ef"
          strokeWidth={2}
          shapeRendering="geometricPrecision"
          borderRadius={5}
        />
      </svg>,
    )

    const dot = container.querySelector('circle.react-flow__minimap-node')
    expect(dot).toBeInTheDocument()
    expect(dot).toHaveClass('selected')
    expect(dot).toHaveClass('workflow-graph-minimap-node-selected')
    expect(dot).toHaveAttribute('fill', '#1d4ed8')
    expect(dot).toHaveStyle({ fill: '#1d4ed8' })
    expect(dot).toHaveAttribute('r', '31')
  })
})

describe('GraphEditor dirty-state gating', () => {
  it('keeps Save graph and Discard absent through selection, menus, and pickers', async () => {
    const user = userEvent.setup()
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor()
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Researcher agent, Step 1' }))
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()

    fireEvent.click(document.querySelector('.react-flow__pane') as HTMLElement)
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open actions for Researcher' }))
    expect(screen.getByRole('menu', { name: 'Researcher node actions' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add agent to graph' }))
    expect(screen.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Add agent to graph' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close agent picker' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
    expect(getGraphDraft(key)).toBeUndefined()
  })

  it('drops a resize that returns the node to the saved size', async () => {
    const sizedWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: workflow.nodes.map((node) => (node.id === 'step-one' ? { ...node, width: 520, height: 92 } : node)),
    }
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor({ workflow: sizedWorkflow, selectedAgentId: 'agent-one' })

    await userEvent.setup().click(screen.getByRole('button', { name: 'Resize selected node' }))

    expect(getGraphDraft(key)).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  })

  it('returns to clean when every draft edit is reverted to the saved definition', () => {
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor()
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()

    act(() => {
      useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({ ...current, name: 'Edited locally' }))
    })
    expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()

    act(() => {
      useGraphDraftStore.getState().updateDraft(key, workflow, (current) => ({ ...current, name: workflow.name }))
    })
    expect(getGraphDraft(key)).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  })
})
