import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { it, expect, vi } from 'vitest'
import { server } from '../../mocks/server'
import { JobsDirectory } from './JobsDirectory'
import { autoDefinition, autoQueueTicket, definition, execution, queueTicket } from './fixtures'
import { jobKeys } from './query'

const root = '*/api/management/workspaces/:workspaceId/jobs'
function renderDirectory(options: { cache?: QueryClient; onSelectExecution?: (id: string) => void } = {}) {
  const cache = options.cache ?? new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  const open = options.onSelectExecution ?? vi.fn()
  server.use(http.get(`${root}/definitions`, () => HttpResponse.json({ definitions: [] })),
    http.get(`${root}/executions`, () => HttpResponse.json({ executions: [] })))
  render(<QueryClientProvider client={cache}>
    <JobsDirectory workspaceId={definition.workspaceId} onSelectExecution={open} />
  </QueryClientProvider>)
  return cache
}

it('retains a valid long job name and every command argument through keyboard navigation to its result', async () => {
  const name = 'n'.repeat(200)
  const argv = ['node', 'x'.repeat(8192), ...Array.from({ length: 30 }, (_, index) => `--argument-${index}=${'z'.repeat(80)}`)]
  const saved = { ...definition, name, spec: { ...definition.spec, argv } }
  const open = vi.fn()
  server.use(http.get(`${root}/definitions`, () => HttpResponse.json({ definitions: [saved] })),
    http.get(`${root}/executions`, () => HttpResponse.json({ executions: [execution] })),
    http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [], nextHistoryCursor: null })))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <JobsDirectory workspaceId={definition.workspaceId} onSelectExecution={open} />
  </QueryClientProvider>)
  const savedJobs = screen.getByRole('region', { name: 'Saved jobs' })
  expect(await within(savedJobs).findByRole('heading', { name })).toHaveTextContent(name)
  const command = within(savedJobs).getByText(JSON.stringify(argv))
  expect(command.textContent).toBe(JSON.stringify(argv))
  const user = userEvent.setup()
  await user.tab()
  expect(screen.getByRole('button', { name: 'New job' })).toHaveFocus()
  await user.tab()
  expect(command).toHaveFocus()
  await user.tab()
  expect(screen.getByRole('button', { name: 'Review and start' })).toHaveFocus()
  await user.tab()
  expect(screen.getByRole('button', { name: 'Edit definition' })).toHaveFocus()
  await user.tab()
  const result = within(screen.getByRole('region', { name: 'Execution history' })).getByRole('button', { name: `Open result of ${name}, revision 1, build failed` })
  expect(result).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(open).toHaveBeenCalledWith(execution.id)
})

it('shows scoped Auto waiting and the original deadline with an unknown start estimate', async () => {
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [autoQueueTicket], nextHistoryCursor: null })))
  renderDirectory()
  const queue = screen.getByRole('region', { name: 'Job queue' })
  expect(await within(queue).findByText('Waiting for an eligible computer')).toBeInTheDocument()
  expect(within(queue).getByText('Queued · waiting')).toBeInTheDocument()
  expect(within(queue).getByText(autoQueueTicket.deadlineAt)).toBeInTheDocument()
  expect(within(queue).getByText('offline')).toBeInTheDocument()
  expect(within(queue).getByText('Compatible computers')).toBeInTheDocument()
  expect(within(queue).getByText('Workspace queue position')).toBeInTheDocument()
  expect(within(queue).getByText('Unknown')).toBeInTheDocument()
  expect(within(queue).getByText(/Workflow-node queuing, Start placement overrides and start estimates are unavailable/))
    .toBeInTheDocument()
})

it('loads older requests while retaining one visible active request and its cancel action', async () => {
  const recent = { ...queueTicket, id: '22222222-2222-4222-8222-222222222222', state: 'terminal',
    terminalReason: 'cancelled', cancelRequestedAt: queueTicket.enqueuedAt, finishedAt: queueTicket.enqueuedAt,
    definition: { ...queueTicket.definition, name: 'Recent request' }, enqueueSequence: '200' }
  const older = { ...recent, id: '33333333-3333-4333-8333-333333333333',
    definition: { ...queueTicket.definition, name: 'Older request' }, enqueueSequence: '199' }
  server.use(http.get(`${root}/queue`, ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('historyBeforeSequence')
    return HttpResponse.json({ tickets: [autoQueueTicket, cursor ? older : recent],
      nextHistoryCursor: cursor ? null : '200' })
  }))
  renderDirectory()
  const queue = screen.getByRole('region', { name: 'Job queue' })
  await within(queue).findByText('Recent request')
  await userEvent.click(within(queue).getByRole('button', { name: 'Load older requests' }))
  await within(queue).findByText('Older request')
  expect(within(queue).getAllByText('Waiting for an eligible computer')).toHaveLength(1)
  expect(within(queue).getByRole('button', { name: `Cancel queued ${autoDefinition.name}` })).toBeEnabled()
  expect(within(queue).queryByRole('button', { name: 'Load older requests' })).not.toBeInTheDocument()
})

it('shows claimed, blocked fixed and cancelled requests while accepted requests open their original execution', async () => {
  const claimed = { ...autoQueueTicket, state: 'claimed', reservationId: queueTicket.id }
  const blocked = { ...queueTicket, id: '22222222-2222-4222-8222-222222222222', state: 'blocked',
    waitingReasons: ['disabled'] }
  const cancelled = { ...queueTicket, id: '33333333-3333-4333-8333-333333333333', state: 'terminal',
    terminalReason: 'cancelled', cancelRequestedAt: queueTicket.enqueuedAt, finishedAt: queueTicket.enqueuedAt }
  const admitted = { ...queueTicket, id: '44444444-4444-4444-8444-444444444444', state: 'accepted',
    reservationId: queueTicket.id }
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [claimed, blocked, cancelled, admitted], nextHistoryCursor: null })))
  const open = vi.fn()
  renderDirectory({ onSelectExecution: open })
  const queue = screen.getByRole('region', { name: 'Job queue' })
  await within(queue).findByText('Claimed · preparing')
  expect(within(queue).getByText('Queued · blocked')).toBeInTheDocument()
  expect(within(queue).getByText('disabled')).toBeInTheDocument()
  expect(within(queue).getByText('cancelled')).toBeInTheDocument()
  expect(within(queue).getByText('Accepted')).toBeInTheDocument()
  await userEvent.click(within(queue).getByRole('button', { name: `Open accepted execution of ${definition.name}` }))
  expect(open).toHaveBeenCalledWith(queueTicket.executionId)
})

it('submits queued cancellation with its current revision and renders the returned terminal request', async () => {
  let current = queueTicket
  let received: unknown
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [current], nextHistoryCursor: null })),
    http.post(`${root}/queue/:ticketId/cancel`, async ({ request, params }) => {
      expect(params.ticketId).toBe(queueTicket.id)
      received = await request.json()
      current = { ...current, state: 'terminal', terminalReason: 'cancelled', revision: 2,
        cancelRequestedAt: current.enqueuedAt, finishedAt: current.enqueuedAt }
      return HttpResponse.json({ ticket: current })
    }))
  renderDirectory()
  await userEvent.click(await screen.findByRole('button', { name: `Cancel queued ${definition.name}` }))
  await screen.findByText('cancelled')
  expect(received).toEqual({ commandId: expect.any(String), expectedRevision: queueTicket.revision })
  expect(screen.queryByRole('button', { name: `Cancel queued ${definition.name}` })).not.toBeInTheDocument()
})

it('retries an uncertain cancellation with the same command and revision even after a denied retry', async () => {
  let current = queueTicket
  const bodies: unknown[] = []
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [current], nextHistoryCursor: null })),
    http.post(`${root}/queue/:ticketId/cancel`, async ({ request }) => {
      bodies.push(await request.json())
      if (bodies.length === 1) return HttpResponse.error()
      if (bodies.length === 2) return HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Denied' } }, { status: 403 })
      current = { ...current, state: 'terminal', terminalReason: 'cancelled', revision: 2,
        cancelRequestedAt: current.enqueuedAt, finishedAt: current.enqueuedAt }
      return HttpResponse.json({ ticket: current })
    }))
  renderDirectory()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: `Cancel queued ${definition.name}` }))
  await user.click(await screen.findByRole('button', { name: `Retry cancellation of ${definition.name}` }))
  await waitFor(() => expect(bodies).toHaveLength(2))
  await waitFor(() => expect(screen.getByRole('button', { name: `Retry cancellation of ${definition.name}` })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: `Retry cancellation of ${definition.name}` }))
  await screen.findByText('cancelled')
  expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]])
})

it('hides cached queue tickets after read permission is lost', async () => {
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [autoQueueTicket], nextHistoryCursor: null })))
  const cache = renderDirectory()
  const queue = screen.getByRole('region', { name: 'Job queue' })
  await within(queue).findByText('Waiting for an eligible computer')
  server.use(http.get(`${root}/queue`, () =>
    HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Denied' } }, { status: 403 })))
  await act(async () => { await cache.refetchQueries({ queryKey: jobKeys.queue(definition.workspaceId) }) })
  await within(queue).findByText(/permission lost/)
  expect(within(queue).queryByText('Waiting for an eligible computer')).not.toBeInTheDocument()
  expect(within(queue).queryByRole('button', { name: `Cancel queued ${autoDefinition.name}` })).not.toBeInTheDocument()
})
