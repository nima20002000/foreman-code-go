import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { it, expect } from 'vitest'
import { server } from '../../mocks/server'
import { JobResult } from './JobResult'
import { execution, logPage } from './fixtures'
const root = '*/api/management/workspaces/:workspaceId/jobs/executions/:id'
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><JobResult workspaceId={execution.workspaceId} executionId={execution.id} /></QueryClientProvider>) }
function responses(value = execution) { server.use(http.get(root, () => HttpResponse.json({ execution: value })), http.get(`${root}/logs`, () => HttpResponse.json(logPage)), http.get(`${root}/artifacts`, () => HttpResponse.json({ artifacts: [] }))) }

it('renders exit7 independently from healthy transport and missing required output', async () => {
  responses(); mount()
  expect(await screen.findByText('Process: build failed')).toBeInTheDocument()
  expect(screen.getByText('Transport: connected')).toBeInTheDocument()
  expect(await screen.findByText('Required artifact missing')).toBeInTheDocument()
  expect(await screen.findByText(/build failed <script>/)).toBeInTheDocument()
  expect(document.querySelector('.job-log-window script')).toBeNull()
})
it.each(['queued', 'preparing', 'running'] as const)('shows %s with offline cancellation remaining unconfirmed', async phase => {
  responses({ ...execution, transport: 'offline', cancelRequestedAt: execution.createdAt, process: { ...execution.process, phase, outcome: null, exitCode:null,signal:null, processStopped: false } }); mount()
  expect(await screen.findByText('Process: Cancellation requested · stop unconfirmed')).toBeInTheDocument()
  expect(screen.getByText('Transport: offline')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeDisabled()
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
