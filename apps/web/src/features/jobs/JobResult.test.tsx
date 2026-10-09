import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { it, expect } from 'vitest'
import { server } from '../../mocks/server'
import { JobResult } from './JobResult'
import { execution, logPage, verificationExecution } from './fixtures'
const root = '*/api/management/workspaces/:workspaceId/jobs/executions/:id'
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><JobResult workspaceId={execution.workspaceId} executionId={execution.id} /></QueryClientProvider>) }
function responses(value: JobExecutionRecord = execution) { server.use(http.get(root, () => HttpResponse.json({ execution: value })), http.get(`${root}/logs`, () => HttpResponse.json(logPage)), http.get(`${root}/artifacts`, () => HttpResponse.json({ artifacts: [] }))) }

it('retains a valid long declared output path in its exact job result', async () => {
  const path = `dist/${'r'.repeat(1000)}.zip`
  responses({ ...execution, acceptedSpec: { ...execution.acceptedSpec, outputs: [{ path, required: true, mediaType: 'application/zip' }] } })
  mount()
  expect((await screen.findByText(path)).textContent).toBe(path)
  expect(await screen.findByText('Required artifact missing')).toBeInTheDocument()
})

it('renders exit7 independently from healthy transport and missing required output', async () => {
  responses(); mount()
  expect(await screen.findByText('Process: build failed')).toBeInTheDocument()
  expect(screen.getByText('Transport: connected')).toBeInTheDocument()
  expect(await screen.findByText('Required artifact missing')).toBeInTheDocument()
  expect(await screen.findByText(/build failed <script>/)).toBeInTheDocument()
  expect(document.querySelector('.job-log-window script')).toBeNull()
})
it.each(['offline', 'unknown'] as const)(
  'shows persisted terminal outcomes with %s transport without possibly-running guidance', async transport => {
    responses({ ...execution, transport, resultIssue: null,
      process: { ...execution.process, outcome: 'succeeded', exitCode: 0 } })
    mount()
    expect(await screen.findByText('Process: succeeded')).toBeInTheDocument()
    expect(screen.getByText(`Transport: ${transport}`)).toBeInTheDocument()
    expect(screen.getByText(`${execution.startedAt} / ${execution.finishedAt}`)).toBeInTheDocument()
    expect(screen.getByText(/The recorded process outcome is shown above/)).toBeInTheDocument()
    expect(screen.queryByText(/may still be running/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull()
  },
)
it('preserves the successful verification Job outcome when its computer is offline', async () => {
  responses({ ...verificationExecution, transport: 'offline' })
  mount()
  expect(await screen.findByText('Process: succeeded')).toBeInTheDocument()
  expect(screen.getByText(/The recorded process outcome is shown above/)).toBeInTheDocument()
  expect(screen.queryByText(/may still be running/)).toBeNull()
})
it.each(['build_failed', 'cancelled', 'timed_out', 'preparation_failed', 'spawn_failed'] as const)(
  'keeps a recorded %s outcome distinct from offline transport', async outcome => {
    responses({ ...execution, transport: 'offline', process: { ...execution.process, outcome } })
    mount()
    const label = outcome === 'cancelled' ? 'Cancellation confirmed' : outcome.replaceAll('_', ' ')
    expect(await screen.findByText(`Process: ${label}`)).toBeInTheDocument()
    expect(screen.getByText(/The recorded process outcome is shown above/)).toBeInTheDocument()
    expect(screen.queryByText(/may still be running/)).toBeNull()
  },
)
it.each(['queued', 'preparing', 'running'] as const)(
  'retains possibly-running guidance for an offline Job with %s process state', async phase => {
    responses({ ...execution, transport: 'offline', finishedAt: null,
      process: { phase, outcome: null, exitCode: null, signal: null, processStopped: false } })
    mount()
    expect(await screen.findByText(`Process: ${phase}`)).toBeInTheDocument()
    expect(screen.getByText(/The process may still be running/)).toBeInTheDocument()
    expect(screen.queryByText(/The recorded process outcome is shown above/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull()
  },
)
it.each(['queued', 'preparing', 'running'] as const)('shows %s with offline cancellation remaining unconfirmed', async phase => {
  responses({ ...execution, transport: 'offline', cancelRequestedAt: execution.createdAt, process: { ...execution.process, phase, outcome: null, exitCode:null,signal:null, processStopped: false } }); mount()
  expect(await screen.findByText('Process: Cancellation requested · stop unconfirmed')).toBeInTheDocument()
  expect(screen.getByText('Transport: offline')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull()
})
it('hides all accepted data after forbidden readback', async () => {
  server.use(http.get(root, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied' } }, { status: 403 }))); mount()
  expect(await screen.findByText(/permission lost/)).toBeInTheDocument()
  expect(screen.queryByText('Qualified PC')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Job logs' })).toBeNull()
})

it('a denied artifact read is unavailable history, not proof the required output is missing', async () => {
  responses()
  server.use(http.get(`${root}/artifacts`, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied' } }, { status: 403 })))
  mount()
  expect(await screen.findByText('Artifact history unavailable')).toBeInTheDocument()
  expect(screen.queryByText('Required artifact missing')).toBeNull()
})

it.each(['missing_output', null] as const)('shows failed publication with its retained issue %s', async resultIssue => {
  responses({ ...execution, publication: 'failed', resultIssue })
  mount()
  expect(await screen.findByText(resultIssue ? 'Publication failed: missing output.' : 'Publication failed.'))
    .toBeInTheDocument()
  expect(screen.queryByText('Awaiting publication')).toBeNull()
  expect(screen.queryByText('Loading publication…')).toBeNull()
})

it.each(['pending', 'collecting'] as const)('continues waiting for artifacts while publication is %s', async publication => {
  responses({ ...execution, publication, resultIssue: null })
  mount()
  expect(await screen.findByText('Awaiting publication')).toBeInTheDocument()
  expect(screen.queryByText(/Publication failed/)).toBeNull()
})
