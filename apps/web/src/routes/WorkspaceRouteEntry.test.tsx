import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { CurrentWorkspaceDetails as WorkspaceDetailsResponse } from '@graphql/contracts/wave25'
import { useGraphDraftStore } from '../features/graph/store'

import { routeTree } from '../app/router'
import { queryKeys } from '../shared/api/query'
import { getMockFixture, setMockScenario } from '../shared/mocks/scenarios'
import { server } from '../mocks/server'
import { bindMockInstallation } from '../shared/mocks/handlers'

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

const clients: QueryClient[] = []
async function researcherButton() {
  // Wait for the current Board before querying its canvas; initial route selection
  // and definition loading are separate asynchronous steps.
  const board = await workflowBoard('Research to review')
  const canvas = within(board).getByLabelText('Editable workflow graph')
  const fixture = getMockFixture('workspace-1')!
  const node = fixture.workflows.find((workflow) => workflow.id === 'workflow-content-pipeline')!
    .nodes.find((node) => node.agentId === 'agent-researcher')!
  const title = node.name ?? node.label ?? fixture.agents.find((agent) => agent.id === node.agentId)!.name
  return within(canvas).findByRole('button', { name: (name) => name.startsWith(`${title},`) })
}
async function workflowBoard(name: string) {
  const board = await screen.findByRole('region', { name: 'Workflow authoring' })
  expect(await within(board).findByRole('heading', { name })).toBeVisible()
  return board
}
async function renderWorkspace(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })
  clients.push(queryClient)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPendingMinMs: 0,
  })

  // Load the memory route before mounting instead of racing the initial render.
  await router.load()
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  return { router, queryClient, ...rendered }
}

describe('WorkspaceRouteEntry integration', () => {
  beforeEach(() => {
    useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); bindMockInstallation(); sessionStorage.clear()
    server.use(http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json(readyWorkspace())))
    // JSDOM measurements only: the real mounted Board and React Flow stay intact.
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly notify: ResizeObserverCallback) {}
      observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
      unobserve() {} disconnect() {}
    })
    if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720, toJSON: () => ({}) }))
  })

  afterEach(() => {
    cleanup(); clients.splice(0).forEach((client) => client.clear())
    useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
    setMockScenario('normal')
    sessionStorage.clear()
    vi.unstubAllEnvs()
  })

  it('renders the saved workflow and keeps a valid agent selection in the URL', async () => {
    const { router } = await renderWorkspace('/workspaces/workspace-1')

    expect(await researcherButton()).toBeVisible()
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize workspace context panel' })).not.toBeInTheDocument()

    const nodeButton = await researcherButton()
    fireEvent.click(nodeButton)

    await waitFor(() => expect(router.state.location.search.agentId).toBe('agent-researcher'))
    await waitFor(() => expect(nodeButton).toHaveAttribute('aria-pressed', 'true'))
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('keeps an URL-selected agent in the graph without mounting a context panel', async () => {
    const { router } = await renderWorkspace('/workspaces/workspace-1?agentId=agent-researcher')

    const node = await researcherButton()
    await waitFor(() => expect(node).toHaveAttribute('aria-pressed', 'true'))
    expect(router.state.location.search.agentId).toBe('agent-researcher')
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-context-panel')).not.toBeInTheDocument()
  })

  it('keeps a stale URL selection in the graph without exposing an operator surface', async () => {
    await renderWorkspace('/workspaces/workspace-1?agentId=agent-old')

    expect(await workflowBoard('Research to review')).toBeVisible()
    expect(screen.queryByTestId('agent-context-stale')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('opens the accepted new workflow while workspace details still serve the old list', async () => {
    const user = userEvent.setup()
    const { router, queryClient } = await renderWorkspace('/workspaces/workspace-1?workflowId=workflow-content-pipeline')
    expect(await workflowBoard('Research to review')).toBeVisible()

    const oldDetails = queryClient.getQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails('workspace-1'))
    if (!oldDetails) throw new Error('Workspace details were not loaded')
    server.use(http.get('/api/workspaces/workspace-1', () => HttpResponse.json(oldDetails)))

    await user.click(within(screen.getByRole('region', { name: 'Workspace workflows' })).getByRole('button', { name: 'New workflow' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Draft workflow')
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    // The sidebar marks a never-published workflow with a "Draft" badge inside its link.
    const newLink = await screen.findByRole('link', { name: /^Draft workflow/ })
    const createdId = new URL(newLink.getAttribute('href')!, 'http://localhost').searchParams.get('workflowId')
    expect(createdId).toBeTruthy()
    await waitFor(() => expect(router.state.location.search.workflowId).toBe(createdId))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.workspaceDetails('workspace-1'), type: 'active' })
    })
    expect(queryClient.getQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails('workspace-1'))?.workflows.some((item) => item.id === createdId)).toBe(false)
    await waitFor(() => expect(router.state.location.search.workflowId).toBe(createdId))
    expect(await workflowBoard('Draft workflow')).toBeVisible()
  })

  it('still replaces a genuinely unknown workflow selection', async () => {
    const { router } = await renderWorkspace('/workspaces/workspace-1?workflowId=workflow-missing&agentId=agent-researcher')

    await waitFor(() => {
      expect(router.state.location.search.workflowId).toBe('workflow-content-pipeline')
      expect(router.state.location.search.agentId).toBeUndefined()
    })
  })

  it('renders error, 404 and empty workspace states', async () => {
    setMockScenario('error')
    const error = await renderWorkspace('/workspaces/workspace-1')
    expect(await screen.findByTestId('workspace-error')).toBeVisible()
    error.unmount()

    setMockScenario('empty')
    const empty = await renderWorkspace('/workspaces/workspace-1')
    expect(await screen.findByTestId('workspace-empty')).toBeVisible()
    empty.unmount()

    const missing = await renderWorkspace('/workspaces/missing')
    expect(await screen.findByTestId('workspace-not-found')).toBeVisible()
    missing.unmount()
  })

  it.each([403, 404])('stops automatic polling after a terminal %s while keeping manual retry', async (status) => {
    let requests = 0
    server.use(http.get('/api/workspaces/stale-workspace', () => {
      requests += 1
      return HttpResponse.json({
        error: {
          code: status === 404 ? 'WORKSPACE_NOT_FOUND' : 'ACCESS_DENIED',
          message: status === 404 ? 'Workspace not found.' : 'Access denied.',
        },
      }, { status })
    }))

    const stale = await renderWorkspace('/workspaces/stale-workspace')
    const retry = await screen.findByRole('button', { name: 'Retry workspace request' })
    expect(requests).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(requests).toBe(1)

    fireEvent.click(retry)
    await waitFor(() => expect(requests).toBe(2))
    stale.unmount()
  })

})
