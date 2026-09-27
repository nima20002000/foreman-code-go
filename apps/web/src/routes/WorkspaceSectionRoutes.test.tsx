import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
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
    expect(screen.queryByRole('link', { name: 'Terminal' })).not.toBeInTheDocument()
  })

  it('keeps the Workflows sidebar label on the current workspace settings page', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')
    await user.click(await screen.findByTitle('Workflows'))
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings')
    expect(screen.queryByRole('link', { name: 'Workflows' })).not.toBeInTheDocument()
    expect(await screen.findByTestId('workflow-card-workflow-content-pipeline')).toBeVisible()
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
    expect(await screen.findByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveClass('nav-item-active')
  })

  it('opens each settings card on its own page instead of below the hub', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/settings')

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: /Provider presets/ })).toHaveAttribute('href', '/settings/harnesses')
    expect(screen.getByRole('link', { name: /Orchestrator, Coder and Operator templates/ })).toHaveAttribute('href', '/settings/agents')
    expect(screen.getByRole('link', { name: /Defaults for new workflows/ })).toHaveAttribute('href', '/settings/workflows')
    expect(screen.queryByRole('link', { name: /Approval/i })).not.toBeInTheDocument()

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

  it('asks for workspace choice at the old global approval URL instead of opening a wider queue', async () => {
    renderRoute('/approvals?interactionId=unscoped-request')
    expect(await screen.findByRole('heading', { name: 'Workspaces', level: 1 })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Approval Inbox' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current')
  })

  it('omits the approvals shortcut from workspace settings', async () => {
    renderRoute('/workspaces/workspace-1/settings')
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(await screen.findByTestId('workflow-card-workflow-content-pipeline')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Approvals Review requests in this workspace/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'App connections' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Harness availability' })).toBeVisible()
  })

  it('confirms workspace removal in settings and returns to the workspace list', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')
    await user.click(await screen.findByRole('button', { name: 'Remove workspace' }))
    let dialog = screen.getByRole('dialog', { name: 'Remove Website?' })
    expect(dialog).toHaveTextContent('App-created project folders and their contents will be deleted. Existing folders you selected are kept. Workflow and run history is retained.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings')
    expect(screen.queryByRole('dialog', { name: 'Remove Website?' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove workspace' }))
    dialog = screen.getByRole('dialog', { name: 'Remove Website?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove workspace' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces'))
    expect(await screen.findByTestId('workspace-directory-empty')).toBeVisible()
    expect(screen.queryByTestId('workspace-entry-workspace-1')).not.toBeInTheDocument()
  })

  it('offers workflow management within the selected workspace settings', async () => {
    const user = userEvent.setup()
    renderRoute('/workspaces/workspace-1/settings')
    expect(await screen.findByRole('heading', { name: 'Workflows', level: 2 })).toBeVisible()
    const section = within(screen.getByRole('region', { name: 'Workflows' }))
    expect(await section.findByTestId('workflow-card-workflow-content-pipeline')).toBeVisible()
    await user.click(section.getByRole('button', { name: 'Open actions for Research to review' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Settings workflow')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(section.getByTestId('workflow-card-workflow-content-pipeline')).toHaveTextContent('Settings workflow'))
    await user.click(section.getByRole('button', { name: 'Select workflows' }))
    expect(section.getByRole('checkbox', { name: 'Select Settings workflow' })).toBeVisible()
    await user.click(section.getByRole('button', { name: 'Cancel selection' }))
    await user.click(section.getByRole('button', { name: 'New workflow' }))
    expect(screen.getByRole('dialog', { name: 'New workflow' })).toBeVisible()
  })

  it('redirects an old approval deep link back to its workflow board and opens the panel', async () => {
    const { router } = renderRoute('/workspaces/workspace-1/approvals?workflowId=workflow-content-pipeline&approvalView=history')
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1'))
    expect(router.state.location.search).toMatchObject({ workflowId: 'workflow-content-pipeline' })
    expect(await screen.findByRole('dialog', { name: 'Human approval inbox' })).toBeVisible()
  })

  it('places Browsers under Settings and preserves its deep link', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/browsers')

    expect(await screen.findByRole('heading', { name: 'Browsers', level: 1 })).toBeVisible()
    expect(screen.getByText('Coming soon')).toBeVisible()
    expect(await screen.findByTestId('workspace-entry-workspace-1')).toHaveAttribute('aria-current', 'location')
    expect(screen.queryByRole('link', { name: 'Workspace settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current')

    await user.click(screen.getByRole('link', { name: 'Back to settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings'))
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: /Browsers/ })).toBeVisible()
  })

  it('opens the workspace folder picker without navigating away from Settings', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await user.click(await screen.findByRole('button', { name: /Execution location|Choose workspace folder/ }))

    expect(await screen.findByRole('dialog', { name: 'Choose folder' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings')
  })
})
