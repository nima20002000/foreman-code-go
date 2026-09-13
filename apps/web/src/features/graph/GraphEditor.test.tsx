import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
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

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <GraphEditor workspaceId={workflow.workspaceId} workflow={workflow} agents={agents} />
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
})

describe('GraphEditor persistence boundary', () => {
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
