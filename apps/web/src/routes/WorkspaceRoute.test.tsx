import { screen } from '@testing-library/react'

import { renderWithRouter } from '../test/renderWithRouter'
import { WorkspaceRouteView, WorkspaceSelection } from './WorkspaceRoute'

describe('WorkspaceRoute', () => {
  it('keeps the graph neutral when no agent is selected', async () => {
    renderWithRouter(<WorkspaceSelection workspaceId="workspace-1" />)

    expect(await screen.findByTestId('workspace-ready')).toHaveTextContent('No agent is selected')
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('exposes loading, error, and stale selection states through props', async () => {
    const loading = renderWithRouter(<WorkspaceRouteView workspaceId="workspace-1" state="loading" />)
    expect(await screen.findByTestId('workspace-loading')).toBeVisible()
    loading.unmount()

    renderWithRouter(
      <WorkspaceRouteView
        workspaceId="workspace-1"
        state="error"
        stateMessage="Request failed"
      />,
    )
    expect(await screen.findByTestId('workspace-error')).toHaveTextContent('Request failed')
  })

  it('marks the workflows destination active for the graph route', async () => {
    renderWithRouter(
      <WorkspaceRouteView
        workspaceId="workspace-1"
        selectedAgentId="agent-old"
        state="stale"
      />,
    )

    expect(await screen.findByTestId('workspace-stale')).toHaveTextContent('agent-old')
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Workspaces' })).toHaveClass('nav-item-active')
  })
})
