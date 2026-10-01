import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { it, expect } from 'vitest'
import { server } from '../../mocks/server'
import { JobNodePanel } from './JobNodePanel'
import { definition } from './fixtures'
it('does not substitute another revision when the exact saved version disagrees with the node pin', async () => {
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/definitions/:id/versions/:versionId', () => HttpResponse.json({ definition: { ...definition, revision: 2 } })))
  render(<QueryClientProvider client={new QueryClient()}><JobNodePanel workspaceId={definition.workspaceId} definitionId={definition.id} definitionRevision={1} definitionVersionId={definition.versionId} /></QueryClientProvider>)
  expect(await screen.findByText(/No substitute command is shown/)).toBeInTheDocument()
  expect(screen.queryByText('Exact command')).toBeNull()
})
