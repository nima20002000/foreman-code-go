import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { WorkspaceDetailsResponse } from '@graphql/contracts'

import { routeTree } from '../app/router'
import { queryKeys } from '../shared/api/query'
import { getMockFixture, setMockScenario } from '../shared/mocks/scenarios'
import { server } from '../mocks/server'

function readyWorkspace() {
  const fixture = getMockFixture('workspace-1')
  if (!fixture) throw new Error('Workspace fixture missing')
  return {
    workspace: fixture.workspace, revision: 1, archivedAt: null,
    executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
    locationRevision: 1,
    locationValidation: { status: 'ready', checkedAt: '2026-09-19T00:00:00.000Z' },
  }
}

function renderWorkspace(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  return { router, queryClient, ...rendered }
}

describe('WorkspaceRouteEntry integration', () => {
  beforeEach(() => {
    server.use(http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json(readyWorkspace())))
  })

  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    setMockScenario('normal')
    sessionStorage.clear()
    vi.unstubAllEnvs()
  })

  it('renders the saved workflow and keeps a valid agent selection in the URL', async () => {
    const { router } = renderWorkspace('/workspaces/workspace-1')

    expect(await screen.findByTestId('agent-node-agent-researcher', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize workspace context panel' })).not.toBeInTheDocument()

    const nodeButton = screen.getByTestId('agent-node-agent-researcher').querySelector('button')
    if (!nodeButton) throw new Error('Researcher node button missing')
    fireEvent.click(nodeButton)

    await waitFor(() => expect(router.state.location.search.agentId).toBe('agent-researcher'))
    expect(nodeButton).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('keeps an URL-selected agent in the graph without mounting a context panel', async () => {
    const { router } = renderWorkspace('/workspaces/workspace-1?agentId=agent-researcher')

    const node = await screen.findByTestId('agent-node-agent-researcher', {}, { timeout: 5000 })
    expect(node.querySelector('button')).toHaveAttribute('aria-pressed', 'true')
    expect(router.state.location.search.agentId).toBe('agent-researcher')
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-context-panel')).not.toBeInTheDocument()
  })

  it('keeps a stale URL selection in the graph without exposing an operator surface', async () => {
    renderWorkspace('/workspaces/workspace-1?agentId=agent-old')

    expect(await screen.findByTestId('workflow-graph')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-context-stale')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('opens the accepted new workflow while workspace details still serve the old list', async () => {
    const user = userEvent.setup()
    const { router, queryClient } = renderWorkspace('/workspaces/workspace-1?workflowId=workflow-content-pipeline')
    expect(await screen.findByRole('region', { name: 'Research to review workflow graph' })).toBeVisible()

    const oldDetails = queryClient.getQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails('workspace-1'))
    if (!oldDetails) throw new Error('Workspace details were not loaded')
    server.use(http.get('/api/workspaces/workspace-1', () => HttpResponse.json(oldDetails)))

    await user.click(screen.getByRole('button', { name: 'New workflow' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Draft workflow')
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    const newLink = await screen.findByRole('link', { name: 'Draft workflow' })
    const createdId = new URL(newLink.getAttribute('href')!, 'http://localhost').searchParams.get('workflowId')
    expect(createdId).toBeTruthy()
    await waitFor(() => expect(router.state.location.search.workflowId).toBe(createdId))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.workspaceDetails('workspace-1'), type: 'active' })
    })
    expect(queryClient.getQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails('workspace-1'))?.workflows.some((item) => item.id === createdId)).toBe(false)
    await waitFor(() => expect(router.state.location.search.workflowId).toBe(createdId))
    expect(await screen.findByRole('region', { name: 'Draft workflow workflow graph' })).toBeVisible()
  })

  it('still replaces a genuinely unknown workflow selection', async () => {
    const { router } = renderWorkspace('/workspaces/workspace-1?workflowId=workflow-missing&agentId=agent-researcher')

    await waitFor(() => {
      expect(router.state.location.search.workflowId).toBe('workflow-content-pipeline')
      expect(router.state.location.search.agentId).toBeUndefined()
    })
  })

  it('renders error, 404 and empty workspace states', async () => {
    setMockScenario('error')
    const error = renderWorkspace('/workspaces/workspace-1')
    expect(await screen.findByTestId('workspace-error')).toBeVisible()
    error.unmount()

    setMockScenario('empty')
    const empty = renderWorkspace('/workspaces/workspace-1')
    expect(await screen.findByTestId('workspace-empty')).toBeVisible()
    empty.unmount()

    const missing = renderWorkspace('/workspaces/missing')
    expect(await screen.findByTestId('workspace-not-found')).toBeVisible()
    missing.unmount()
  })

})
