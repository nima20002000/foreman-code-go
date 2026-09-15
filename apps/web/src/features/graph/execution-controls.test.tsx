import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Agent, WorkflowDefinition, WorkflowRun } from '@graphql/contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { queryKeys } from '../../shared/api/query'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { GraphEditor } from './GraphEditor'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'

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
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})
afterEach(() => {
  client.clear()
  vi.unstubAllGlobals()
  useGraphDraftStore.getState().clearAllDrafts()
  useAgentDirectoryStore.getState().reset()
  sessionStorage.clear()
})

function editor() {
  return render(<QueryClientProvider client={client}>
    <GraphEditor workspaceId={workflow.workspaceId} workflow={workflow} agents={agents} />
  </QueryClientProvider>)
}

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

it('explains the fourth-step safety limit and requires an explicit operator change before Save', async () => {
  editor()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Add agent to graph' }))
  await user.click(await screen.findByRole('button', { name: 'Codex' }))
  expect(screen.getByRole('button', { name: 'Save graph' })).toBeDisabled()
  expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))?.workflow.executionPolicy?.maxNodeExecutions).toBe(3)
  await user.click(screen.getByRole('button', { name: 'Open actions for codex-001' }))
  const limit = screen.getByRole('spinbutton', { name: 'Maximum node executions' })
  expect(limit).toHaveAttribute('aria-invalid', 'true')
  fireEvent.change(limit, { target: { value: '4' } })
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(screen.getByRole('button', { name: 'Save graph' })).toBeEnabled()
  expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))?.workflow.executionPolicy?.maxNodeExecutions).toBe(4)
})

it('does not show board save controls without a meaningful graph or agent change', () => {
  editor()
  expect(screen.queryByRole('button', { name: 'Save agent settings' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  expect(getGraphDraft(workflowDraftKey(workflow.workspaceId, workflow.id))).toBeUndefined()
})
