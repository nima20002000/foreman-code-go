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

  it('keeps the temporarily hidden agents directory available by deep link', async () => {
    renderRoute('/workspaces/workspace-1/agents?agentId=agent-researcher')

    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Researcher, researcher, Available/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Researcher' })).not.toBeInTheDocument()

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

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/workflows'))
    expect(await screen.findByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible()
    expect(await screen.findByTestId('workflow-card-workflow-content-pipeline')).toHaveTextContent('Research to review')
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument()
  })

  it('keeps workflow submenu expansion state while workspace routes replace the shell', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/agents')

    await screen.findByRole('heading', { name: 'Agents', level: 1 })
    await user.click(screen.getByRole('button', { name: 'Collapse workflows in Website' }))
    await user.click(screen.getByRole('link', { name: 'Files' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/files'))
    expect(await screen.findByRole('button', { name: 'Expand workflows in Website' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  })

  it('deep-links the Files placeholder under the workspaces menu', async () => {
    renderRoute('/workspaces/workspace-1/files')

    expect(await screen.findByRole('heading', { name: 'Files' })).toBeVisible()
    expect(screen.getByTestId('coming-soon')).toHaveTextContent('Coming soon')
    expect(screen.getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveClass('nav-item-active')
  })

  it('opens each settings card on its own page instead of below the hub', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/settings')

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: /Provider presets/ })).toHaveAttribute('href', '/settings/harnesses')
    expect(screen.getByRole('link', { name: /Orchestrator, Coder and Operator templates/ })).toHaveAttribute('href', '/settings/agents')
    expect(screen.getByRole('link', { name: /Defaults for new workflows/ })).toHaveAttribute('href', '/settings/workflows')
    expect(screen.getByRole('link', { name: /Global review queue and delivery history/ })).toHaveAttribute('href', '/approvals')

    await user.click(screen.getByRole('link', { name: /Orchestrator, Coder and Operator templates/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/agents'))
    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Settings', level: 1 })).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Back to settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  })

  it('opens the profile from Account and redirects the old App access URL', async () => {
    const account = renderRoute('/account')
    expect(await screen.findByRole('heading', { name: 'Profile', level: 1 })).toBeVisible()
    expect(screen.getByText('preview@example.test')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page')
    account.unmount()

    const legacy = renderRoute('/settings/operator-access')
    await waitFor(() => expect(legacy.router.state.location.pathname).toBe('/account'))
    expect(await screen.findByRole('heading', { name: 'Profile', level: 1 })).toBeVisible()
  })

  it('renders the global Approval Inbox as a Settings detail page', async () => {
    const { router } = renderRoute('/approvals')

    expect(await screen.findByRole('heading', { name: 'Approval Inbox', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Back to settings' })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('region', { name: 'Approval Inbox' })).toHaveClass('approval-inbox--embedded')

    await userEvent.setup().click(screen.getByRole('link', { name: 'Back to settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  it('places Browsers under Settings and preserves its deep link', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/browsers')

    expect(await screen.findByRole('heading', { name: 'Browsers', level: 1 })).toBeVisible()
    expect(screen.getByText('Coming soon')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Workspace settings' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current')

    await user.click(screen.getByRole('link', { name: 'Back to settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings'))
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: /Browsers/ })).toBeVisible()
  })

  it('opens workspace execution location on its dedicated Settings page', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await user.click(screen.getByRole('link', { name: /Execution location/ }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings/location'))
    expect(await screen.findByRole('heading', { name: 'Execution location', level: 1 })).toBeVisible()
    expect(await screen.findByRole('textbox', { name: 'Execution folder path' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Back to settings' })).toHaveAttribute('href', '/workspaces/workspace-1/settings')
  })
})
