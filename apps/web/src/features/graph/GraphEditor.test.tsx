import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Agent, WorkflowDefinition } from '@graphql/contracts'

import { setMockScenario } from '../../shared/mocks/scenarios'
import { queryKeys } from '../../shared/api/query'
import { GraphEditor } from './GraphEditor'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'

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

  it('copies and unlinks graph references without exposing global deletion', async () => {
    const user = userEvent.setup()
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    renderEditor()

    await user.click(screen.getByRole('button', { name: 'Open actions for Researcher' }))
    expect(screen.getByRole('menu', { name: 'Researcher node actions' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toHaveFocus()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDisabled()
    await user.click(screen.getByRole('menuitem', { name: 'Copy' }))

    const copied = getGraphDraft(key)?.workflow.nodes.at(-1)
    expect(copied?.agentId).toBe('agent-one')
    expect(copied?.position).toEqual({ x: 120, y: 140 })
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Open actions for Researcher' }))
    await user.click(screen.getByRole('menuitem', { name: 'Unlink' }))

    expect(getGraphDraft(key)?.workflow.nodes).toHaveLength(1)
    expect(getGraphDraft(key)?.workflow.edges).toHaveLength(0)
    expect(agents).toHaveLength(2)
  })

  it('dismisses the anchored node menu from Escape or an outside click', async () => {
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
