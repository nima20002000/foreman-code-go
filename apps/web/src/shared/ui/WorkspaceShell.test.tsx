import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithRouter } from '../../test/renderWithRouter'
import {
  DEFAULT_NAVIGATION_WIDTH,
  MAX_NAVIGATION_WIDTH,
  useWorkspaceSessionStore,
} from '../../features/workspaces'
import { WorkspaceShell } from './WorkspaceShell'

describe('WorkspaceShell', () => {
  afterEach(() => {
    sessionStorage.clear()
    useWorkspaceSessionStore.getState().reset()
  })

  it('nests the workspace destinations under an active Workspaces menu', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    expect(await screen.findByTestId('workspace-shell')).toBeVisible()

    const workspaces = screen.getByRole('button', { name: 'Workspaces' })
    expect(workspaces).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveClass('nav-item-active')

    const workflows = screen.getByRole('link', { name: 'Workflows' })
    expect(workflows).toHaveAttribute('href', '/workspaces/workspace-1/workflows')
    expect(workflows).toHaveAttribute('aria-current', 'page')

    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument()

    const files = screen.getByRole('link', { name: 'Files' })
    expect(files).toHaveAttribute('href', '/workspaces/workspace-1/files')
    expect(files.querySelector('svg')).toBeInTheDocument()

    for (const label of ['Tasks', 'Runs']) {
      const item = screen.getByRole('link', { name: label })
      expect(item).toHaveAttribute('href', expect.stringContaining('/workspaces/workspace-1/'))
      expect(item.querySelector('svg')).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: 'Terminal' })).toHaveAttribute('href', '/terminal')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    const account = screen.getByRole('link', { name: 'Account' })
    expect(account).toHaveAttribute('href', '/account')
    expect(account.parentElement).toContainElement(screen.getByRole('button', { name: /Switch to .* theme/ }))
    expect(screen.queryByRole('link', { name: 'Browsers' })).not.toBeInTheDocument()
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
  })

  it('marks Account as the selected footer destination', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" activeGlobalSection="account" />)
    await screen.findByTestId('workspace-shell')
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current')
  })

  it('expands and collapses the nested submenu from the parent control', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const workspaces = await screen.findByRole('button', { name: 'Workspaces' })
    await user.click(workspaces)

    expect(workspaces).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Files' })).not.toBeInTheDocument()

    await user.click(workspaces)

    expect(workspaces).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Workflows' })).toBeVisible()
  })

  it('collapses to an accessible icon rail and expands again', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const collapse = await screen.findByRole('button', { name: 'Collapse navigation' })
    await user.click(collapse)

    expect(screen.getByTestId('workspace-shell')).toHaveClass('workspace-shell-navigation-collapsed')
    expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute('data-collapsed', 'true')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('title', 'Workspaces')
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('title', 'Workflows')
    expect(screen.queryByRole('button', { name: 'New workspace' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()

    const expand = screen.getByRole('button', { name: 'Expand navigation' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    await user.click(expand)

    expect(screen.getByTestId('workspace-shell')).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'New workspace' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('renders the product brand above the workspace tree and keeps its name readable when collapsed', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const brand = await screen.findByTestId('sidebar-brand')
    const mark = brand.querySelector('.sidebar-brand-mark')
    expect(brand).toHaveTextContent('GraphQL')
    expect(mark).toHaveTextContent('G')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(brand.querySelector('.sidebar-brand-name')).toHaveTextContent('GraphQL')

    await user.click(screen.getByRole('button', { name: 'Collapse navigation' }))

    expect(screen.getByTestId('sidebar-brand')).toHaveTextContent('GraphQL')
    expect(screen.getByTestId('sidebar-brand').querySelector('.sidebar-brand-name')).toHaveTextContent('GraphQL')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('title', 'Workspaces')
  })

  it('keeps the temporarily hidden Agents route content available by deep link', async () => {
    renderWithRouter(
      <WorkspaceShell workspaceId="workspace-1" activeSection="agents" slots={{ main: <div>Directory</div> }} />,
    )

    expect(await screen.findByRole('region', { name: 'Workspace content' })).toHaveTextContent('Directory')
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Workspaces' })).not.toHaveClass('nav-item-active')
    expect(screen.getByRole('link', { name: 'Workflows' })).not.toHaveAttribute('aria-current')
  })

  it('keeps Terminal top-level and active outside the workspace tree', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" activeGlobalSection="terminal" />)

    expect(await screen.findByRole('link', { name: 'Terminal' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Workspaces' })).not.toHaveClass('nav-item-active')
    expect(screen.getByTestId('workspace-entry-workspace-1')).not.toHaveClass('nav-item-active')
  })

  it('expands and collapses each workspace entry independently', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const entry = await screen.findByRole('link', { name: 'Website' })
    const toggle = screen.getByRole('button', { name: 'Collapse Website' })
    expect(entry).toHaveAttribute('data-testid', 'workspace-entry-workspace-1')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Files' })).toBeVisible()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'Files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /agents in Website/ })).not.toBeInTheDocument()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('link', { name: 'Files' })).toBeVisible()
  })

  it('collapses and expands the nested Workflows submenu while Agents stays hidden', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const workflowsToggle = await screen.findByRole('button', { name: 'Collapse workflows in Website' })
    expect(workflowsToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByTestId('agent-navigation')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'New workflow' })).toBeVisible()

    await user.click(workflowsToggle)

    expect(workflowsToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  })

  it('starts section reordering only from the direct workflow row, not submenu links', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const workflowsRow = (await screen.findByRole('link', { name: 'Workflows' })).closest('.nav-item-row')
    expect(workflowsRow).toHaveAttribute('data-reorder-id', 'workflows')

    const nestedWorkflow = await screen.findByRole('link', { name: 'Research to review' })
    expect(nestedWorkflow.closest('[data-reorder-id="workflows"]')).toBeNull()
  })

  it('renders multiple query-shaped workspace entries under the Workspaces parent', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        workspaces={[
          { id: 'workspace-1', name: 'Website' },
          { id: 'workspace-2', name: 'Docs' },
        ]}
      />,
    )

    const docs = await screen.findByTestId('workspace-entry-workspace-2')
    const docsToggle = screen.getByRole('button', { name: 'Expand Docs' })
    expect(docs).toHaveAccessibleName('Docs')
    expect(docsToggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(docsToggle)

    expect(docsToggle).toHaveAttribute('aria-expanded', 'true')
    const filesLinks = screen.getAllByRole('link', { name: 'Files' })
    expect(filesLinks.some((link) => link.getAttribute('href') === '/workspaces/workspace-2/files')).toBe(true)
    const workflowsLinks = screen.getAllByRole('link', { name: 'Workflows' })
    expect(workflowsLinks.some((link) => link.getAttribute('href') === '/workspaces/workspace-2/workflows')).toBe(true)
  })

  it('creates a session workspace from the modal', async () => {
    const user = userEvent.setup()
    const { router } = renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const trigger = await screen.findByRole('button', { name: 'New workspace' })
    expect(trigger).toBeVisible()

    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'New workspace' })
    expect(dialog).toHaveTextContent('Create a workspace for its own agents')
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Scratch')
    await user.click(screen.getByRole('button', { name: 'Create workspace' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/workspaces\/session-/))
    expect(useWorkspaceSessionStore.getState().workspaces[0]?.name).toBe('Scratch')
  })

  it('resizes the navigation by pointer and keyboard within safe bounds', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    expect(resize).toHaveAttribute('aria-valuenow', String(DEFAULT_NAVIGATION_WIDTH))

    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: DEFAULT_NAVIGATION_WIDTH })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 300 })
    expect(resize).toHaveAttribute('aria-valuenow', '300')
    expect(screen.getByTestId('workspace-shell')).toHaveStyle('--navigation-width: 300px')

    resize.focus()
    await user.keyboard('{End}{ArrowRight}')
    expect(resize).toHaveAttribute('aria-valuenow', String(MAX_NAVIGATION_WIDTH))

    await user.dblClick(resize)
    expect(resize).toHaveAttribute('aria-valuenow', String(DEFAULT_NAVIGATION_WIDTH))
  })

  it('keeps workflow submenu state across shell remounts', async () => {
    const user = userEvent.setup()
    const first = renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    await user.click(await screen.findByRole('button', { name: 'Collapse workflows in Website' }))
    first.unmount()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    expect(await screen.findByRole('button', { name: 'Expand workflows in Website' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  })

  it('renders the graph surface without mounted operator or context surfaces', async () => {
    const rendered = renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        slots={{
          workspace: <span>Shared workspace</span>,
          runner: <span>Runner one</span>,
          graph: <div>Graph slot</div>,
          terminal: <div>Terminal slot</div>,
        }}
      />,
    )

    expect(await screen.findByTestId('workspace-shell')).toBeInTheDocument()
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize workspace context panel' })).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Shared workspace')
    expect(screen.getByTestId('sidebar-brand')).toHaveTextContent('GraphQL')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Runner one')
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Graph slot')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Terminal slot')
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument()

    rendered.unmount()

    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        slots={{
          workspace: <span>Shared workspace</span>,
          graph: <div>Selected agent graph</div>,
        }}
      />,
    )

    expect(await screen.findByTestId('workspace-shell')).toBeInTheDocument()
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize workspace context panel' })).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Selected agent graph')
  })
})
