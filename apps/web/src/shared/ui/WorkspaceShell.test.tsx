import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { WorkspaceShell } from './WorkspaceShell'

describe('WorkspaceShell', () => {
  afterEach(() => sessionStorage.clear())

  it('renders selectable navigation with icons and an active workspace destination', () => {
    render(<WorkspaceShell workspaceId="workspace-1" />)

    expect(screen.getByTestId('workspace-shell')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('aria-current', 'page')

    for (const label of ['Agents', 'Tasks', 'Runs', 'Terminal', 'Settings']) {
      const item = screen.getByRole('link', { name: label })
      expect(item).toHaveAttribute('href', expect.stringContaining('/workspaces/workspace-1/'))
      expect(item.querySelector('svg')).toBeInTheDocument()
    }
    expect(screen.queryByRole('link', { name: 'Browsers' })).not.toBeInTheDocument()
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
  })

  it('collapses to an accessible icon rail and expands again', async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell workspaceId="workspace-1" />)

    const collapse = screen.getByRole('button', { name: 'Collapse navigation' })
    await user.click(collapse)

    expect(screen.getByTestId('workspace-shell')).toHaveClass('workspace-shell-navigation-collapsed')
    expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute('data-collapsed', 'true')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('title', 'Workspaces')

    const expand = screen.getByRole('button', { name: 'Expand navigation' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    await user.click(expand)

    expect(screen.getByTestId('workspace-shell')).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('marks the current directory route active', () => {
    render(<WorkspaceShell workspaceId="workspace-1" activeSection="agents" slots={{ main: <div>Directory</div> }} />)

    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Workspaces' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('region', { name: 'Workspace content' })).toHaveTextContent('Directory')
  })

  it('renders only the navigation rail and graph surface with or without a selected agent', () => {
    const { rerender } = render(
      <WorkspaceShell
        workspaceId="workspace-1"
        slots={{
          workspace: <span>Shared workspace</span>,
          runner: <span>Runner one</span>,
          graph: <div>Graph slot</div>,
          context: <div>Context slot</div>,
          terminal: <div>Terminal slot</div>,
        }}
      />,
    )

    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Shared workspace')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('graphql')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Runner one')
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Graph slot')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Context slot')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Terminal slot')
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument()

    rerender(
      <WorkspaceShell
        workspaceId="workspace-1"
        slots={{
          workspace: <span>Shared workspace</span>,
          graph: <div>Selected agent graph</div>,
          context: <div>Selected Researcher context</div>,
        }}
      />,
    )

    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Selected agent graph')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Selected Researcher context')
  })
})
