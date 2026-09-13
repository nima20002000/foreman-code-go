import { render, screen } from '@testing-library/react'

import { WorkspaceShell } from './WorkspaceShell'

describe('WorkspaceShell', () => {
  it('renders the navigation and marks unimplemented destinations unavailable', () => {
    render(<WorkspaceShell workspaceId="workspace-1" />)

    expect(screen.getByTestId('workspace-shell')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('aria-current', 'page')

    for (const label of ['Agents', 'Browsers', 'Tasks', 'Runs']) {
      const item = screen.getByRole('button', { name: new RegExp(label) })
      expect(item).toBeDisabled()
      expect(item).toHaveAttribute('aria-disabled', 'true')
      expect(item).toHaveTextContent('Unavailable')
    }
  })

  it('keeps graph and context integration behind named slots', () => {
    render(
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

    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Shared workspace')
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Runner one')
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Graph slot')
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Context slot')
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Terminal slot')
  })
})
