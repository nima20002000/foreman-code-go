import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import type { JobExecutionRecord, WorkflowJobPage } from '@foreman-code/contracts/job-verification'
import { server } from '../../mocks/server'
import { execution, logPage } from '../jobs/fixtures'
import { BoardNavigationControls } from './BoardNavigationControls'

vi.mock('../runs-selector', () => ({ RunsSelector: () => <button>Runs</button> }))
vi.mock('../schedules', () => ({ ScheduleClockButton: () => null }))
vi.mock('../workflow-files', () => ({ WorkflowFilesButton: () => null }))
vi.mock('../graph/nextDraft/transport', () => ({ nextDraftApi: { context: async () => ({ draft: {} }) } }))

const workspaceId = execution.workspaceId
const workflowId = 'workflow-a'
const root = '*/api/management/workspaces/:workspaceId/jobs'
const historyPath = `${root}/workflows/:workflowId/executions`
const nodeJob = { ...execution, workflow: { workflowId, runId: 'run-a', nodeId: 'node-a', nodeExecutionId: 'node-exec-a' } }
function page(items: WorkflowJobPage['items'] = [{ name: 'Web build', execution: nodeJob }]): WorkflowJobPage {
  return { workspaceId, workflowId, items, nextCursor: null }
}
function responses(value = page()) {
  server.use(http.get(historyPath, () => HttpResponse.json(value)),
    http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution: nodeJob })),
    http.get(`${root}/executions/:id/logs`, () => HttpResponse.json(logPage)),
    http.get(`${root}/executions/:id/artifacts`, () => HttpResponse.json({ artifacts: [] })))
}
function controls(workflow = workflowId) {
  return <BoardNavigationControls workspaceId={workspaceId} workflowId={workflow}
    selection={{ identity: { runId: null } } as Parameters<typeof BoardNavigationControls>[0]['selection']} />
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { client, ...render(<QueryClientProvider client={client}>{controls()}</QueryClientProvider>) }
}
async function open() { fireEvent.click(screen.getByRole('button', { name: 'Jobs' })) }

it('opens workflow history beside Runs, showing a compact row and a read-only result', async () => {
  responses()
  mount()
  expect(screen.getByRole('button', { name: 'Runs' })).toBeInTheDocument()
  await open()
  const row = await screen.findByRole('button', { name: /Web build/ })
  expect(within(row).getByLabelText('Failed')).toBeInTheDocument()
  expect(within(row).getByText('2.0 s')).toBeInTheDocument()
  expect(within(row).getByText('Qualified PC')).toBeInTheDocument()
  expect(within(row).getByText(/days? ago|yesterday/i)).toBeInTheDocument()
  fireEvent.click(row)
  expect(await screen.findByText('Process: build failed')).toBeInTheDocument()
  expect(await screen.findByText(/build failed <script>/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /cancel|rerun/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Back to jobs' }))
  expect(screen.getByRole('button', { name: /Web build/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Close jobs' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([
  { outcome: 'succeeded', phase: 'terminal', exitCode: 0, stopped: true, label: 'Succeeded' },
  { outcome: 'cancelled', phase: 'terminal', exitCode: null, stopped: true, label: 'Canceled' },
  { outcome: null, phase: 'running', exitCode: null, stopped: false, label: 'Running' },
  { outcome: null, phase: 'preparing', exitCode: null, stopped: false, label: 'Preparing' },
] as const)('shows $label and Agent CI provenance', async ({ outcome, phase, exitCode, stopped, label }) => {
  const value: JobExecutionRecord = { ...execution,
    initiatingAgent: { workflowId, runId: 'run-a', agentId: 'agent-a', executionId: 'agent-exec-a' },
    process: { phase, outcome, exitCode, signal: null, processStopped: stopped } }
  responses(page([{ name: 'unit', execution: value }]))
  mount()
  await open()
  const row = await screen.findByRole('button', { name: /CI: unit/ })
  expect(within(row).getByLabelText(label)).toBeInTheDocument()
})

it('retains the short CI suite name without repeating its prefix', async () => {
  responses(page([{ name: 'CI: unit', execution: { ...execution,
    initiatingAgent: { workflowId, runId: 'run-a', agentId: 'agent-a', executionId: 'agent-exec-a' } } }]))
  mount()
  await open()
  expect(await screen.findByText('CI: unit')).toBeInTheDocument()
  expect(screen.queryByText('CI: CI: unit')).toBeNull()
})

it('shows one short empty line', async () => {
  responses(page([]))
  mount()
  await open()
  expect(await screen.findByText('No jobs yet.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Older jobs' })).toBeNull()
})

it('requests older history with the returned cursor', async () => {
  const cursor = { createdAt: execution.createdAt, id: execution.id }
  const cursors: (string | null)[] = []
  server.use(http.get(historyPath, ({ request }) => {
    const received = new URL(request.url).searchParams.get('cursor')
    cursors.push(received)
    if (received) return HttpResponse.json(page([{ name: 'Older build', execution: { ...nodeJob, id: 'older' } }]))
    return HttpResponse.json({ ...page(), nextCursor: cursor })
  }))
  mount()
  await open()
  fireEvent.click(await screen.findByRole('button', { name: 'Older jobs' }))
  expect(await screen.findByRole('button', { name: /Older build/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Web build/ })).toBeInTheDocument()
  expect(cursors).toEqual([null, JSON.stringify(cursor)])
})

it('rejects another workflow response and hides its rows', async () => {
  responses({ ...page(), workflowId: 'foreign' })
  mount()
  await open()
  expect(await screen.findByRole('alert')).toHaveTextContent('another job or workspace')
  expect(screen.queryByRole('button', { name: /Web build/ })).toBeNull()
})

it('hides previously read jobs after denied readback', async () => {
  responses()
  const { client } = mount()
  await open()
  expect(await screen.findByRole('button', { name: /Web build/ })).toBeInTheDocument()
  server.use(http.get(historyPath, () => HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Denied' } }, { status: 403 })))
  await client.invalidateQueries({ queryKey: ['jobs', workspaceId, 'workflow', workflowId] })
  expect(await screen.findByRole('alert')).toHaveTextContent('permission lost')
  expect(screen.queryByRole('button', { name: /Web build/ })).toBeNull()
})

it('closes the local panel when workflow navigation changes', async () => {
  responses()
  const { client, rerender } = mount()
  await open()
  expect(await screen.findByRole('button', { name: /Web build/ })).toBeInTheDocument()
  rerender(<QueryClientProvider client={client}>{controls('other-workflow')}</QueryClientProvider>)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('button', { name: 'Jobs' })).toHaveAttribute('aria-expanded', 'false')
})
