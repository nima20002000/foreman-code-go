import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { routeTree } from '../app/router'
import { setMockScenario } from '../shared/mocks/scenarios'
import { useSessionWorkflowStore } from '../features/workflows'
import { useWorkspaceSessionStore } from '../features/workspaces'

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
    useWorkspaceSessionStore.getState().reset()
    useSessionWorkflowStore.getState().clearSessionWorkflows()
    sessionStorage.clear()
    vi.unstubAllEnvs()
  })

  it('renders the saved workflow and keeps a valid agent selection in the URL', async () => {
    const { router } = renderWorkspace('/workspaces/workspace-1')

    expect(await screen.findByTestId('agent-node-agent-researcher')).toBeInTheDocument()
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

    const node = await screen.findByTestId('agent-node-agent-researcher')
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

  it('renders loading, error, 404 and empty workspace states', async () => {
    const loading = renderWorkspace('/workspaces/workspace-1')
    expect(await screen.findByTestId('workspace-loading')).toBeInTheDocument()
    loading.unmount()

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

  it('refreshes workspace query projections after selecting a mock scenario', async () => {
    vi.stubEnv('VITE_ENABLE_MSW', 'true')
    const user = userEvent.setup()
    renderWorkspace('/workspaces/workspace-1')

    expect(await screen.findByTestId('mock-mode')).toHaveTextContent('normal')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Mock data scenario' }), 'empty')

    expect(await screen.findByTestId('workspace-empty')).toBeVisible()
    expect(screen.queryByTestId('workflow-graph')).not.toBeInTheDocument()
  })

  it('enables mock data controls by default in development and honors an explicit opt-out', async () => {
    const enabled = renderWorkspace('/workspaces/workspace-1')
    expect(await screen.findByTestId('mock-data-control')).toBeInTheDocument()
    enabled.unmount()

    vi.stubEnv('VITE_ENABLE_MSW', 'false')
    renderWorkspace('/workspaces/workspace-1')

    expect(await screen.findByTestId('workflow-graph')).toBeVisible()
    expect(screen.queryByTestId('mock-data-control')).not.toBeInTheDocument()
  })

  it('keeps independently created workspace names isolated across rapid URL switches', async () => {
    const user = userEvent.setup()
    const { router } = renderWorkspace('/workspaces/workspace-1')

    await screen.findByTestId('workspace-entry-workspace-1')
    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Scratch')
    await user.click(screen.getByRole('button', { name: 'Create workspace' }))

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/workspaces\/session-/))
    const scratchId = router.state.location.pathname.split('/').at(-1)
    expect(scratchId).toMatch(/^session-/)
    expect(await screen.findByTestId(`workspace-entry-${scratchId}`)).toHaveTextContent('Scratch')
    expect(screen.getByTestId('workspace-entry-workspace-1')).toHaveTextContent('Website')

    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Beta')
    await user.click(screen.getByRole('button', { name: 'Create workspace' }))
    await waitFor(() => expect(router.state.location.pathname).not.toContain(scratchId as string))
    expect(screen.getByTestId('workspace-entry-workspace-1')).toHaveTextContent('Website')
    expect(screen.getByTestId(`workspace-entry-${scratchId}`)).toHaveTextContent('Scratch')
    const beta = screen.getByRole('link', { name: 'Beta' })
    expect(beta).toBeVisible()
    expect(beta).toHaveClass('nav-item-active')
    expect(
      screen.getAllByTestId(/^workspace-entry-/)
        .filter((entry) => entry.classList.contains('nav-item-active')),
    ).toEqual([beta])
    expect(screen.getByRole('button', { name: 'Expand Website' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Expand Scratch' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Collapse Beta' })).toHaveAttribute('aria-expanded', 'true')

    await router.navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: 'workspace-1' } })
    const website = await screen.findByTestId('workspace-entry-workspace-1')
    expect(website).toHaveTextContent('Website')
    expect(website).toHaveClass('nav-item-active')
    expect(
      screen.getAllByTestId(/^workspace-entry-/)
        .filter((entry) => entry.classList.contains('nav-item-active')),
    ).toEqual([website])
    expect(screen.getByRole('button', { name: 'Collapse Website' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Expand Beta' })).toHaveAttribute('aria-expanded', 'false')

    await router.navigate({
      to: '/workspaces/$workspaceId',
      params: { workspaceId: scratchId as string },
    })
    expect(await screen.findByTestId(`workspace-entry-${scratchId}`)).toHaveTextContent('Scratch')
    expect(screen.getByTestId('workspace-entry-workspace-1')).toHaveTextContent('Website')
    expect(screen.getByRole('link', { name: 'Beta' })).toBeVisible()
  })

  it('canonically selects a session workflow when its workspace URL has no workflow id', async () => {
    const sessionWorkspace = useWorkspaceSessionStore.getState().createWorkspace('Scratch')
    const workflow = useSessionWorkflowStore.getState().createSessionWorkflow({
      workspaceId: sessionWorkspace.id,
      name: 'Scratch flow',
    })

    const { router } = renderWorkspace(`/workspaces/${sessionWorkspace.id}`)

    expect(await screen.findByRole('link', { name: /Scratch flow/ })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByTestId('workflow-graph')).toBeVisible()
    await waitFor(() => expect(router.state.location.search.workflowId).toBe(workflow.id))
  })

  it('keeps the last workspace available through global navigation and switches from its name', async () => {
    const sessionWorkspace = useWorkspaceSessionStore.getState().createWorkspace('Scratch')
    const user = userEvent.setup()
    const { router } = renderWorkspace(`/workspaces/${sessionWorkspace.id}`)

    expect(await screen.findByTestId('workspace-empty')).toBeVisible()
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))

    const workspaceLink = await screen.findByRole('link', { name: 'Scratch' })
    expect(workspaceLink).toBeVisible()
    await user.click(workspaceLink)
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workspaces/${sessionWorkspace.id}`)
      expect(router.state.location.search).toEqual({})
    })
  })
})
