import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, it, expect, vi } from 'vitest'
import type { JobStart } from '@foreman-code/contracts/jobs'
import type { JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { server } from '../../mocks/server'
import { JobLaunch } from './JobLaunch'
import { definition, execution, queueTicket, autoDefinition, autoQueueTicket, verificationDefinition, verificationExecution,
  verificationTemplate, verificationQueueTicket } from './fixtures'
import { jobKeys } from './query'
const root = '*/api/management/workspaces/:workspaceId/jobs'
beforeEach(() => {
  server.use(http.get(`${root}/choices`, () => HttpResponse.json({ sources: [], policies: [], targets: [] })))
})

it('launches a saved ordinary-suite revision and reads its accepted verification execution', async () => {
  const accepted = vi.fn()
  const requests: unknown[] = []
  let ticket = verificationQueueTicket
  server.use(
    http.get(`${root}/choices`, () => HttpResponse.json({ sources: [], policies: [], targets: [],
      autoPolicies: [{ policy: verificationTemplate.policy, limits: verificationTemplate.resources.limits }],
      verificationTemplates: [verificationTemplate] })),
    http.post(`${root}/validate`, async ({ request }) => {
      requests.push(await request.json())
      return HttpResponse.json({ valid: true, reasons: [], sideEffects: false })
    }),
    http.post(`${root}/executions`, async ({ request }) => {
      const command = await request.json() as { commandId: string }
      requests.push(command)
      ticket = { ...verificationQueueTicket, commandId: command.commandId }
      return HttpResponse.json({ admission: { kind: 'pending-admission', ticket } })
    }),
    http.get(`${root}/queue/:id`, () => HttpResponse.json({ ticket: { ...ticket,
      state: 'accepted', reservationId: verificationExecution.acceptedSpec.reservationId } })),
    http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution: verificationExecution })),
  )
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <JobLaunch workspaceId={definition.workspaceId} definition={verificationDefinition}
      onClose={vi.fn()} onAccepted={accepted} />
  </QueryClientProvider>)
  await screen.findByText('Configuration valid')
  await userEvent.click(screen.getByRole('button', { name: 'Start job' }))
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(verificationExecution))
  expect(requests[0]).toEqual({ spec: verificationDefinition.spec })
  expect(requests[1]).toMatchObject({ definitionId: verificationDefinition.id, expectedRevision: 1 })
})

it('sends a Start placement override and retains it across an uncertain retry without editing the definition', async () => {
  const bodies: Array<Parameters<typeof import('./client').jobsClient.start>[1]> = []
  server.use(
    http.get(`${root}/choices`, () => HttpResponse.json({ sources: [], policies: [], targets: [
      { id: 'selected-root', label: 'Build computer', target: definition.spec.target, ready: true, reasons: [] },
    ] })),
    http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
    http.post(`${root}/executions`, async ({ request }) => {
      bodies.push(await request.json() as typeof bodies[number])
      return HttpResponse.error()
    }),
  )
  const original = structuredClone(definition)
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <JobLaunch workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} onAccepted={vi.fn()} />
  </QueryClientProvider>)
  await screen.findByRole('option', { name: 'Build computer' })
  await screen.findByText('Ready to start')
  const placement = screen.getByRole('combobox', { name: 'Start placement' })
  await userEvent.selectOptions(placement, 'selected-root')
  await userEvent.click(screen.getByRole('button', { name: 'Start job' }))
  await screen.findByText('Start not confirmed')
  expect(placement).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Retry same start request' }))
  await waitFor(() => expect(bodies).toHaveLength(2))
  expect(bodies[0]).toMatchObject({ definitionId: definition.id, expectedRevision: definition.revision,
    placementOverride: { kind: 'explicit', target: definition.spec.target } })
  expect(bodies[1]).toEqual(bodies[0])
  expect(definition).toEqual(original)
})

it('shows the owner-review requirement and permits closing when no queue request was admitted', async () => {
  const close = vi.fn()
  server.use(
    http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
    http.post(`${root}/executions`, () => HttpResponse.json({ error: {
      code: 'JOB_QUEUE_UNAVAILABLE', message: 'Starting build Jobs requires owner-reviewed queue configuration on Main.',
    } }, { status: 503 })),
  )
  render(<QueryClientProvider client={new QueryClient()}><JobLaunch workspaceId={definition.workspaceId}
    definition={definition} onClose={close} onAccepted={vi.fn()} /></QueryClientProvider>)
  await screen.findByText('Ready to start')
  await userEvent.click(screen.getByRole('button', { name: 'Start job' }))
  await screen.findByText('Start failed')
  expect(screen.getByText(/Starting build Jobs requires owner-reviewed queue configuration on Main\./))
    .toBeInTheDocument()
  expect(screen.queryByText('Start not confirmed')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(close).toHaveBeenCalledOnce()
})

it('opens a retained pre-queue execution after an authenticated same-command retry without inventing a ticket', async () => {
  const accepted = vi.fn()
  const queueReads = vi.fn()
  server.use(
    http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
    http.post(`${root}/executions`, () => HttpResponse.json({ admission: { kind: 'retained-execution', execution } })),
    http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution })),
    http.get(`${root}/queue/:id`, () => { queueReads(); return HttpResponse.json({ ticket: queueTicket }) }),
  )
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <JobLaunch workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} onAccepted={accepted} />
  </QueryClientProvider>)
  await screen.findByText('Ready to start')
  await userEvent.click(screen.getByRole('button', { name: 'Start job' }))
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(execution))
  expect(queueReads).not.toHaveBeenCalled()
})

it('keeps a long reviewed Job name in the dialog description and permits closing before launch', async () => {
  const longDefinition = { ...definition, name: '長い名前'.repeat(50) }
  const close = vi.fn()
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ valid: false, reasons: ['Resource offline'], sideEffects: false })))
  render(<QueryClientProvider client={new QueryClient()}><JobLaunch workspaceId={definition.workspaceId} definition={longDefinition} onClose={close} onAccepted={vi.fn()} /></QueryClientProvider>)
  expect(screen.getByRole('dialog', { name: 'Review job launch' })).toHaveAccessibleDescription(`Launch saved revision 1 of ${longDefinition.name}.`)
  await screen.findByText('Resource offline')
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
  expect(close).toHaveBeenCalledOnce()
})

it('requires fresh readiness after a cached successful check fails to refresh', async () => {
  let readinessAvailable = true
  const cache = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  server.use(http.post(`${root}/validate`, () => readinessAvailable
    ? HttpResponse.json({ valid: true, reasons: [], sideEffects: false })
    : HttpResponse.json({ error: { code: 'READINESS_UNAVAILABLE', message: 'Computer readiness unavailable' } }, { status: 503 })))
  render(<QueryClientProvider client={cache}><JobLaunch workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} onAccepted={vi.fn()} /></QueryClientProvider>)
  const user = userEvent.setup()
  await screen.findByText('Ready to start')
  expect(screen.getByRole('button', { name: 'Start job' })).toBeEnabled()

  readinessAvailable = false
  await act(async () => { await cache.refetchQueries({ queryKey: ['jobs', definition.workspaceId, 'validation'] }) })
  await screen.findByText('Readiness check failed')
  expect(cache.getQueryData(['jobs', definition.workspaceId, 'validation', definition.id, definition.revision])).toMatchObject({ valid: true })
  expect(screen.queryByText('Ready to start')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start job' })).toBeDisabled()

  let finishCheck!: () => void
  const freshCheck = new Promise<void>(resolve => { finishCheck = resolve })
  server.use(http.post(`${root}/validate`, async () => {
    await freshCheck
    return HttpResponse.json({ valid: true, reasons: [], sideEffects: false })
  }))
  await user.click(screen.getByRole('button', { name: 'Retry readiness check' }))
  await screen.findByText(/Checking computer, source and isolation readiness/)
  expect(screen.queryByText('Ready to start')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start job' })).toBeDisabled()
  await act(async () => { finishCheck() })
  await screen.findByText('Ready to start')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start job' })).toBeEnabled())
  expect(screen.queryByText('Readiness check failed')).not.toBeInTheDocument()
})

it('retries unknown acknowledgment with exactly the reviewed identity and revision', async () => {
  const bodies: JobStart[] = []
  const accepted = vi.fn()
  const cache = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
    http.post(`${root}/executions`, async ({ request }) => {
      bodies.push(await request.json() as JobStart)
      return bodies.length === 1 ? HttpResponse.error() : HttpResponse.json({
        admission: { kind: 'accepted', ticketId: queueTicket.id, executionId: execution.id },
      })
    }), http.get(`${root}/queue/:ticketId`, () => HttpResponse.json({ ticket: {
      ...queueTicket, commandId: bodies[0]!.commandId, state: 'accepted', reservationId: queueTicket.id,
    } })), http.get(`${root}/executions/:executionId`, () => HttpResponse.json({ execution })))
  render(<QueryClientProvider client={cache}><JobLaunch workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} onAccepted={accepted} /></QueryClientProvider>)
  const user = userEvent.setup()
  await screen.findByText(/validation passed/)
  await user.click(screen.getByRole('button', { name: 'Start job' }))
  await screen.findByText(/Start acknowledgment is unknown/)
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ error: { code: 'READINESS_UNAVAILABLE', message: 'Computer readiness unavailable' } }, { status: 503 })))
  await act(async () => { await cache.refetchQueries({ queryKey: ['jobs', definition.workspaceId, 'validation'] }) })
  await screen.findByText('Readiness check failed')
  expect(screen.getByRole('button', { name: 'Retry same start request' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Retry same start request' }))
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(execution))
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(accepted).toHaveBeenCalledWith(execution)
})
it('keeps an unknown acknowledgment unresolved when a retry is denied', async () => {
  const bodies: JobStart[] = []
  const accepted = vi.fn()
  const close = vi.fn()
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })), http.post(`${root}/executions`, async ({ request }) => {
    bodies.push(await request.json() as JobStart)
    if (bodies.length === 1) return HttpResponse.error()
    if (bodies.length === 2) return HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, { status: 403 })
    return HttpResponse.json({ admission: { kind: 'accepted', ticketId: queueTicket.id, executionId: execution.id } })
  }), http.get(`${root}/queue/:ticketId`, () => HttpResponse.json({ ticket: {
    ...queueTicket, commandId: bodies[0]!.commandId, state: 'accepted', reservationId: queueTicket.id,
  } })), http.get(`${root}/executions/:executionId`, () => HttpResponse.json({ execution })))
  render(<QueryClientProvider client={new QueryClient()}><JobLaunch workspaceId={definition.workspaceId} definition={definition} onClose={close} onAccepted={accepted} /></QueryClientProvider>)
  const user = userEvent.setup()
  await screen.findByText(/validation passed/)
  await user.click(screen.getByRole('button', { name: 'Start job' }))
  await screen.findByText(/Start acknowledgment is unknown/)
  await user.click(screen.getByRole('button', { name: 'Retry same start request' }))
  await waitFor(() => expect(bodies).toHaveLength(2))
  await screen.findByText(/Start acknowledgment is unknown/)
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Retry same start request' }))
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(execution))
  expect(bodies[2]).toEqual(bodies[0])
})
it('explicit rerun discloses changed revision without changing the old accepted source', async () => {
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ valid: false, reasons: ['Resource offline'], sideEffects: false })))
  render(<QueryClientProvider client={new QueryClient()}><JobLaunch workspaceId={definition.workspaceId} definition={{ ...definition, revision: 2, versionId: 'version-b' }} rerun={execution} onClose={vi.fn()} onAccepted={vi.fn()} /></QueryClientProvider>)
  expect(await screen.findByText(/Resource offline/)).toBeInTheDocument()
  expect(screen.getByText(/old result stays pinned to revision 1/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Rerun as new execution' })).toBeDisabled()
  expect(screen.getByText('Readiness issues; request can queue')).toBeInTheDocument()
  expect(execution.acceptedSpec.definitionRevision).toBe(1)
})

it('queues a valid auto request while its computer is offline and closes after acknowledgment', async () => {
  const close = vi.fn()
  const accepted = vi.fn()
  let current = autoQueueTicket
  server.use(http.post(`${root}/validate`, () =>
    HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
  http.post(`${root}/executions`, async ({ request }) => {
    const input = await request.json() as JobStart
    current = { ...autoQueueTicket, commandId: input.commandId }
    return HttpResponse.json({ admission: { kind: 'pending-admission', ticket: current } })
  }), http.get(`${root}/queue/:ticketId`, () => HttpResponse.json({ ticket: current })))
  render(<QueryClientProvider client={new QueryClient()}>
    <JobLaunch workspaceId={definition.workspaceId} definition={autoDefinition} onClose={close} onAccepted={accepted} />
  </QueryClientProvider>)
  const user = userEvent.setup()
  await screen.findByText('Configuration valid')
  await user.click(screen.getByRole('button', { name: 'Start job' }))
  await screen.findByText('Queued · waiting')
  expect(screen.getByText(queueTicket.deadlineAt)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Retry same start request' })).not.toBeInTheDocument()
  expect(accepted).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(close).toHaveBeenCalledOnce()
})

it('polls the original ticket through claim and acceptance before opening its execution', async () => {
  const accepted = vi.fn()
  let current: JobQueueTicket = queueTicket
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
    http.post(`${root}/executions`, async ({ request }) => {
      const input = await request.json() as JobStart
      current = { ...queueTicket, commandId: input.commandId }
      return HttpResponse.json({ admission: { kind: 'pending-admission', ticket: current } })
    }), http.get(`${root}/queue/:ticketId`, () => HttpResponse.json({ ticket: current })),
    http.get(`${root}/executions/:executionId`, ({ params }) => {
      expect(params.executionId).toBe(queueTicket.executionId)
      return HttpResponse.json({ execution })
    }))
  render(<QueryClientProvider client={cache}>
    <JobLaunch workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} onAccepted={accepted} />
  </QueryClientProvider>)
  await screen.findByText('Ready to start')
  await userEvent.click(screen.getByRole('button', { name: 'Start job' }))
  await screen.findByText('Queued · waiting')
  current = { ...current, state: 'claimed', revision: 2, reservationId: queueTicket.id, queuePosition: null }
  await act(async () => { await cache.refetchQueries({ queryKey: jobKeys.queueTicket(definition.workspaceId, current.id) }) })
  await screen.findByText('Claimed · preparing')
  expect(accepted).not.toHaveBeenCalled()
  current = { ...current, state: 'accepted', revision: 3 }
  await act(async () => { await cache.refetchQueries({ queryKey: jobKeys.queueTicket(definition.workspaceId, current.id) }) })
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(execution))
})

it('keeps a known accepted request when its result read fails and retries only the read', async () => {
  const starts = vi.fn()
  const accepted = vi.fn()
  let commandId = ''
  server.use(http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
    http.post(`${root}/executions`, async ({ request }) => {
      starts()
      commandId = (await request.json() as JobStart).commandId
      return HttpResponse.json({ admission: { kind: 'accepted', ticketId: queueTicket.id, executionId: execution.id } })
    }), http.get(`${root}/queue/:ticketId`, () => HttpResponse.json({ ticket: {
      ...queueTicket, commandId, state: 'accepted', reservationId: queueTicket.id,
    } })), http.get(`${root}/executions/:executionId`, () =>
      HttpResponse.json({ error: { code: 'READ_UNAVAILABLE', message: 'Result unavailable' } }, { status: 503 })))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })}>
    <JobLaunch workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} onAccepted={accepted} />
  </QueryClientProvider>)
  await screen.findByText('Ready to start')
  await userEvent.click(screen.getByRole('button', { name: 'Start job' }))
  await screen.findByText('Accepted result unavailable')
  expect(screen.queryByRole('button', { name: 'Retry same start request' })).not.toBeInTheDocument()
  server.use(http.get(`${root}/executions/:executionId`, () => HttpResponse.json({ execution })))
  await userEvent.click(screen.getByRole('button', { name: 'Retry result read' }))
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(execution))
  expect(starts).toHaveBeenCalledOnce()
})
