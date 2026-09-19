import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceWorkflowList } from './WorkspaceWorkflowList'

const endpoint = '/api/management/workspaces/:workspaceId/workflows'

describe('workspace settings workflows', () => {
  it('opens the selected workflow in its workspace', async () => {
    const { router } = renderWithRouter(<WorkspaceWorkflowList workspaceId="workspace-1" />)
    const link = await screen.findByRole('link', { name: 'Research to review' })
    expect(link).toHaveAttribute('href', '/workspaces/workspace-1?workflowId=workflow-content-pipeline')
    await userEvent.setup().click(link)
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1'))
    expect(router.state.location.search).toEqual({ workflowId: 'workflow-content-pipeline' })
  })

  it('requests only the selected workspace and shows a short empty state', async () => {
    const requested: unknown[] = []
    server.use(http.get(endpoint, ({ params }) => {
      requested.push(params.workspaceId)
      return HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })
    }))
    renderWithRouter(<WorkspaceWorkflowList workspaceId="workspace-other" />)
    expect(await screen.findByText('No workflows yet')).toBeVisible()
    expect(requested).toEqual(['workspace-other'])
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('shows failures separately from empty results and retries', async () => {
    server.use(http.get(endpoint, () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 })))
    renderWithRouter(<WorkspaceWorkflowList workspaceId="workspace-1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Workflows unavailable')
    expect(screen.queryByText('No workflows yet')).not.toBeInTheDocument()
    server.use(http.get(endpoint, () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No workflows yet')).toBeVisible()
  })
})
