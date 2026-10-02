import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { routeTree } from '../app/router'
import { server } from '../mocks/server'
import { setMockScenario } from '../shared/mocks/scenarios'
import { mainRoot } from '../features/settings/workspaceBoundLocation.fixtures'

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
  beforeEach(() => {
    server.use(
      http.get('*/api/workspaces/:workspaceId/reference-files', () => HttpResponse.json({
        items: [], pageInfo: { nextCursor: null },
      })),
      http.get('*/api/management/file-retention', () => HttpResponse.json({
        preference: { ownerPrincipalId: 'retention-owner', durationSeconds: 604_800, revision: 0 },
      })),
    )
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

  it('opens the workflow directory from the Workflows sidebar link', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')
    await user.click(await screen.findByTitle('Workflows'))
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/workflows')
    expect(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByTestId('workflow-card-workflow-content-pipeline')).toBeVisible()
  })

  it('keeps workflow submenu expansion state while workspace routes replace the shell', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/agents')

    await screen.findByRole('heading', { name: 'Agents', level: 1 })
    await user.click(screen.getByRole('button', { name: 'Collapse workflows in Website' }))
    await router.navigate({ to: '/workspaces/$workspaceId/files', params: { workspaceId: 'workspace-1' } })

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/files'))
    expect(await screen.findByRole('button', { name: 'Expand workflows in Website' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  })

  it('deep-links the supported Project files section under the workspaces menu', async () => {
    renderRoute('/workspaces/workspace-1/files')

    expect(await screen.findByRole('heading', { name: 'Project files', level: 1 })).toBeVisible()
    expect(screen.queryByTestId('coming-soon')).not.toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('link', { name: 'Project files' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('link', { name: 'Files' })).not.toBeInTheDocument()
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

  it('mounts chat retention on the authenticated account page', async () => {
    renderRoute('/account')
    expect(await screen.findByRole('heading', { name: 'Profile', level: 1 })).toBeVisible()
    const retention = await screen.findByRole('region', { name: 'Chat retention' })
    expect(within(retention).getByRole('spinbutton', { name: 'Duration' })).toHaveValue(7)
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
    expect(screen.queryByTestId('workflow-card-workflow-content-pipeline')).not.toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: /Approvals Review requests in this workspace/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'App connections' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Harness availability' })).toBeVisible()
  })

  it('opens project files through the selected workspace section navigation', async () => {
    const requestedWorkspaces: string[] = []
    server.use(http.get('*/api/workspaces/:workspaceId/reference-files', ({ params }) => {
      requestedWorkspaces.push(String(params.workspaceId))
      return HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })
    }))
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')
    await user.click(await within(await screen.findByRole('navigation', { name: 'Workspace sections' })).findByRole('link', { name: 'Project files' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/files'))
    const files = await screen.findByRole('region', { name: 'Project files' })
    expect(await within(files).findByText('No files.')).toBeVisible()
    expect(requestedWorkspaces).toEqual(['workspace-1'])
  })

  it('confirms workspace removal in settings and returns to the workspace list', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')
    await user.click((await screen.findAllByRole('button', { name: 'Remove workspace' }))[0]!)
    let dialog = screen.getByRole('dialog', { name: 'Remove Website?' })
    expect(dialog).toHaveTextContent('App-created project folders and their contents will be deleted. Existing folders you selected are kept. Workflow and run history is retained.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings')
    expect(screen.queryByRole('dialog', { name: 'Remove Website?' })).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Remove workspace' })[0]!)
    dialog = screen.getByRole('dialog', { name: 'Remove Website?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove workspace' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces'))
    expect(await screen.findByTestId('workspace-directory-empty')).toBeVisible()
    expect(screen.queryByTestId('workspace-entry-workspace-1')).not.toBeInTheDocument()
  })

  it('offers workflow management within the selected workspace settings', async () => {
    const user = userEvent.setup()
    renderRoute('/workspaces/workspace-1/settings')
    await user.click(await within(await screen.findByRole('navigation', { name: 'Workspace sections' })).findByRole('link', { name: 'Workflows' }))
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

  it('hides the Browsers entry point and preserves its deep link', async () => {
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
    expect(screen.queryByRole('link', { name: /Browsers/ })).not.toBeInTheDocument()
  })

  it('opens the approved execution folder picker without navigating away from Settings', async () => {
    server.use(
      http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({ evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 0, executionLocation: { runnerId: 'original-runner', rootPath: '/previous' } })),
      http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [mainRoot] })),
    )
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    const executionLocation = await screen.findByLabelText('Execution location', { selector: 'button' })
    expect(executionLocation).toBe(screen.getByRole('button', { name: 'Execution location' }))
    await user.click(executionLocation)

    expect(await screen.findByRole('dialog', { name: 'Execution folder' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Computer and approved base folder' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings')
  })

  it('uses the same inline rename from the workspace name and settings, with a nearby removal control', async () => {
    const user = userEvent.setup()
    renderRoute('/workspaces/workspace-1/settings')
    await user.click(await screen.findByRole('button', { name: 'Rename workspace Website' }))
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Rename workspace' }))
    await user.clear(screen.getByRole('textbox', { name: 'Workspace name' }))
    await user.type(screen.getByRole('textbox', { name: 'Workspace name' }), 'Workspace header rename')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByRole('button', { name: 'Rename workspace Workspace header rename' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Rename workspace' }))
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toHaveValue('Workspace header rename')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getAllByRole('button', { name: 'Remove workspace' })[0]!)
    expect(screen.getByRole('dialog', { name: 'Remove Workspace header rename?' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Rename workspace Workspace header rename' })).toBeVisible()
  })

  it('retains the original rename command and revision when acknowledgement is lost', async () => {
    const writes: unknown[] = []
    server.use(http.patch('/api/management/workspaces/workspace-1', async ({ request }) => {
      writes.push(await request.json())
      if (writes.length === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Rename acknowledgement lost.' } }, { status: 503 })
      return undefined
    }))
    const user = userEvent.setup()
    renderRoute('/workspaces/workspace-1/settings')
    await user.click(await screen.findByRole('button', { name: 'Rename workspace Website' }))
    const input = screen.getByRole('textbox', { name: 'Workspace name' })
    await user.clear(input)
    await user.type(input, 'Confirmed retry rename')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('Rename acknowledgement lost.')).toBeVisible()
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry rename' }))
    expect(await screen.findByRole('button', { name: 'Rename workspace Confirmed retry rename' })).toBeVisible()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[0]).toMatchObject({ workspaceId: 'workspace-1', name: 'Confirmed retry rename', expectedRevision: 1 })
  })
})
