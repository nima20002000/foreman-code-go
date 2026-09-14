import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { routeTree } from '../app/router'
import { setMockScenario } from '../shared/mocks/scenarios'

function renderRoute(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  }
}

afterEach(() => {
  setMockScenario('normal')
  sessionStorage.clear()
})

describe('workspace section routes', () => {
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

  it('opens the workspace card directory as the default view with child menus closed', async () => {
    const { router } = renderRoute('/')

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces'))
    expect(await screen.findByRole('heading', { name: 'Workspaces', level: 1 })).toBeVisible()
    expect(await screen.findByTestId('workspace-card-workspace-1')).toHaveTextContent('Website')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('workspace-entry-workspace-1')).not.toHaveClass('nav-item-active')
    expect(screen.getByRole('button', { name: 'Expand Website' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument()
  })

  it('deep-links to the agents directory and marks its navigation active', async () => {
    const { router } = renderRoute('/workspaces/workspace-1/agents?agentId=agent-researcher')

    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: /Researcher, researcher, Available/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Researcher' })).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('link', { name: 'Developer' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ agentId: 'agent-developer' }))
    expect(screen.queryByRole('dialog', { name: 'Developer' })).not.toBeInTheDocument()
  })

  it('does not open a centered modal for an unknown agent deep link', async () => {
    renderRoute('/workspaces/workspace-1/agents?agentId=agent-missing')

    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Agent unavailable' })).not.toBeInTheDocument()
  })

  it('shows an honest error state when the agents request fails', async () => {
    setMockScenario('error')
    renderRoute('/workspaces/workspace-1/agents')

    expect(await screen.findByTestId('agents-error')).toHaveTextContent('selected mock scenario fails read requests')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('deep-links unimplemented destinations to conventional coming-soon pages', async () => {
    renderRoute('/workspaces/workspace-1/terminal')

    expect(await screen.findByRole('heading', { name: 'Terminal' })).toBeVisible()
    expect(screen.getByTestId('coming-soon')).toHaveTextContent('Coming soon')
    expect(screen.getByRole('link', { name: 'Terminal' })).toHaveAttribute('aria-current', 'page')
  })

  it('navigates between nested workspace destinations through router links', async () => {
    const { router } = renderRoute('/workspaces/workspace-1/agents')

    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    await userEvent.setup().click(screen.getByRole('link', { name: 'Workflows' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1'))
    expect(await screen.findByTestId('workflow-graph')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Agents' })).not.toHaveAttribute('aria-current')
  })

  it('keeps submenu expansion state while workspace routes replace the shell', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/agents')

    await screen.findByRole('heading', { name: 'Agents', level: 1 })
    await user.click(screen.getByRole('button', { name: 'Collapse agents in Website' }))
    await user.click(screen.getByRole('link', { name: 'Files' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/files'))
    expect(await screen.findByRole('button', { name: 'Expand agents in Website' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByTestId('agent-navigation')).not.toBeInTheDocument()
  })

  it('deep-links the Files placeholder under the workspaces menu', async () => {
    renderRoute('/workspaces/workspace-1/files')

    expect(await screen.findByRole('heading', { name: 'Files', level: 1 })).toBeVisible()
    expect(screen.getByTestId('coming-soon')).toHaveTextContent('Coming soon')
    expect(screen.getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveClass('nav-item-active')
  })

  it('places Browsers under Settings and preserves its deep link', async () => {
    renderRoute('/workspaces/workspace-1/browsers')

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('link', { name: /Browsers/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Browsers' })).toBeVisible()
    expect(screen.getAllByText('Coming soon')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })
})
