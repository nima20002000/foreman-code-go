import { render, screen } from '@testing-library/react'

import { WorkspaceRouteView, WorkspaceSelection } from './WorkspaceRoute'

describe('WorkspaceRoute', () => {
  it('uses Operator when no agent is selected', () => {
    render(<WorkspaceSelection workspaceId="workspace-1" />)

    expect(screen.getByTestId('workspace-ready')).toHaveTextContent('Operator is active')
    expect(screen.getByRole('heading', { name: 'No terminal connected' })).toBeVisible()
  })

  it('exposes loading, error, and stale selection states through props', () => {
    const { rerender } = render(
      <WorkspaceRouteView workspaceId="workspace-1" state="loading" />,
    )
    expect(screen.getByTestId('workspace-loading')).toBeVisible()

    rerender(
      <WorkspaceRouteView
        workspaceId="workspace-1"
        state="error"
        stateMessage="Request failed"
      />,
    )
    expect(screen.getByTestId('workspace-error')).toHaveTextContent('Request failed')

    rerender(
      <WorkspaceRouteView
        workspaceId="workspace-1"
        selectedAgentId="agent-old"
        state="stale"
      />,
    )
    expect(screen.getByTestId('workspace-stale')).toHaveTextContent('agent-old')
  })
})
