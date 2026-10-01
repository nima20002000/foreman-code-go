import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { it, expect, vi } from 'vitest'
import { server } from '../../mocks/server'
import { JobLaunch } from './JobLaunch'
import { definition, execution } from './fixtures'
const root = '*/api/management/workspaces/:workspaceId/jobs'

it('retries unknown acknowledgment with exactly the reviewed identity and revision', async () => {
  const bodies: unknown[] = [], accepted = vi.fn()
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })), http.post(`${root}/executions`, async ({ request }) => { bodies.push(await request.json()); return bodies.length === 1 ? HttpResponse.error() : HttpResponse.json({ execution }) }))
  render(<QueryClientProvider client={new QueryClient()}><JobLaunch workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} onAccepted={accepted} /></QueryClientProvider>)
  const user = userEvent.setup()
  await screen.findByText(/validation passed/)
  await user.click(screen.getByRole('button', { name: 'Start job' }))
  await screen.findByText(/Start acknowledgment is unknown/)
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Retry same start request' }))
  expect(await screen.findByRole('button', { name: 'Retry same start request' })).toBeInTheDocument()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(accepted).toHaveBeenCalledWith(execution)
})
it('explicit rerun discloses changed revision without changing the old accepted source', async () => {
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ valid: false, reasons: ['Resource offline'], sideEffects: false })))
  render(<QueryClientProvider client={new QueryClient()}><JobLaunch workspaceId={definition.workspaceId} definition={{ ...definition, revision: 2, versionId: 'version-b' }} rerun={execution} onClose={vi.fn()} onAccepted={vi.fn()} /></QueryClientProvider>)
  expect(await screen.findByText(/Resource offline/)).toBeInTheDocument()
  expect(screen.getByText(/old result stays pinned to revision 1/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Rerun as new execution' })).toBeDisabled()
  expect(execution.acceptedSpec.definitionRevision).toBe(1)
})
