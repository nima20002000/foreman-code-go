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
    vi.unstubAllEnvs()
  })

  it('renders the saved workflow and keeps a valid agent selection in the URL', async () => {
    const { router } = renderWorkspace('/workspaces/workspace-1')

    expect(await screen.findByTestId('agent-node-agent-researcher')).toBeInTheDocument()
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()

    const nodeButton = screen.getByTestId('agent-node-agent-researcher').querySelector('button')
    if (!nodeButton) throw new Error('Researcher node button missing')
    fireEvent.click(nodeButton)

    await waitFor(() => expect(router.state.location.search.agentId).toBe('agent-researcher'))
    expect(nodeButton).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('keeps an URL-selected agent in the graph without restoring removed shell panels', async () => {
    const { router } = renderWorkspace('/workspaces/workspace-1?agentId=agent-researcher')

    const node = await screen.findByTestId('agent-node-agent-researcher')
    expect(node.querySelector('button')).toHaveAttribute('aria-pressed', 'true')
    expect(router.state.location.search.agentId).toBe('agent-researcher')
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('shows a stale selection without exposing unrelated conversation history', async () => {
    renderWorkspace('/workspaces/workspace-1?agentId=agent-old')

    expect(await screen.findByTestId('selection-stale')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument()
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
})
