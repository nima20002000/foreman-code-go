import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'

import { renderWithRouter } from '../test/renderWithRouter'
import { server } from '../mocks/server'
import { getMockFixture } from '../shared/mocks/scenarios'
import { WorkspaceRouteView, WorkspaceSelection } from './WorkspaceRoute'

describe('WorkspaceRoute', () => {
  beforeEach(() => {
    const fixture = getMockFixture('workspace-1')
    if (!fixture) throw new Error('Workspace fixture missing')
    server.use(http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json({
      workspace: fixture.workspace, revision: 1, archivedAt: null,
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
      locationRevision: 1,
      locationValidation: { status: 'ready', checkedAt: '2026-09-19T00:00:00.000Z' },
    })))
  })

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

  it('shows a missing workspace error before checking its execution folder', async () => {
    renderWithRouter(<WorkspaceRouteView workspaceId="missing" state="not-found" />)

    expect(await screen.findByTestId('workspace-not-found')).toBeVisible()
    expect(screen.queryByText('Execution folder could not be checked')).not.toBeInTheDocument()
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
    // Workflows is the workspace's workflow directory link; the graph route itself does not mark it current.
    expect(await screen.findByTitle('Workflows')).toHaveAttribute('href', '/workspaces/workspace-1/workflows')
    expect(screen.getByTitle('Workflows')).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveClass('nav-item-active')
  })

  it('offers creation on an empty board without an extra button above an open graph', async () => {
    const empty = renderWithRouter(<WorkspaceRouteView workspaceId="workspace-1" state="empty" />)
    expect(within(await screen.findByTestId('workspace-empty')).getByRole('button', { name: 'New workflow' })).toBeVisible()
    empty.unmount()

    renderWithRouter(<WorkspaceRouteView workspaceId="workspace-1" state="ready" />)
    expect(await screen.findByTestId('workspace-ready')).toBeVisible()
    expect(screen.queryByTestId('workspace-board-actions')).not.toBeInTheDocument()
  })
})
