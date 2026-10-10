import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, expect, it, vi } from 'vitest'
import type { JobExecutionRecord, WorkflowJobPage } from '@foreman-code/contracts/job-verification'
import type { JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { server } from '../../mocks/server'
import { execution, logPage, queueTicket, verificationExecution } from '../jobs/fixtures'
import { BoardNavigationControls } from './BoardNavigationControls'
import { deferred } from '../runs-selector/testFixtures'

vi.mock('../runs-selector', () => ({ RunsSelector: () => <button>Runs</button> }))
vi.mock('../schedules', () => ({ ScheduleClockButton: () => null }))
vi.mock('../workflow-files', () => ({ WorkflowFilesButton: () => null }))
vi.mock('../graph/nextDraft/transport', () => ({ nextDraftApi: { context: async () => ({ draft: {} }) } }))

const workspaceId = execution.workspaceId
const workflowId = 'workflow-a'
const root = '*/api/management/workspaces/:workspaceId/jobs'
const historyPath = `${root}/workflows/:workflowId/executions`
beforeEach(() => {
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [], nextHistoryCursor: null })))
})
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
  { outcome: 'succeeded', phase: 'terminal', exitCode: 0, stopped: true, label: 'Process succeeded · publication complete' },
  { outcome: 'cancelled', phase: 'terminal', exitCode: null, stopped: true, label: 'Canceled' },
  { outcome: null, phase: 'running', exitCode: null, stopped: false, label: 'Running' },
  { outcome: null, phase: 'preparing', exitCode: null, stopped: false, label: 'Preparing' },
] as const)('shows $label and Agent CI provenance', async ({ outcome, phase, exitCode, stopped, label }) => {
  const value: JobExecutionRecord = { ...execution, resultIssue: null,
    initiatingAgent: { workflowId, runId: 'run-a', agentId: 'agent-a', executionId: 'agent-exec-a' },
    process: { phase, outcome, exitCode, signal: null, processStopped: stopped } }
  responses(page([{ name: 'unit', execution: value }]))
  mount()
  await open()
  const row = await screen.findByRole('button', { name: /CI: unit/ })
  expect(within(row).getByLabelText(label)).toBeInTheDocument()
})

it.each([
  { publication: 'pending', resultIssue: null, label: 'Process succeeded · publishing results' },
  { publication: 'collecting', resultIssue: null, label: 'Process succeeded · publishing results' },
  { publication: 'failed', resultIssue: null, label: 'Process succeeded · results incomplete' },
  { publication: 'complete', resultIssue: 'missing_output', label: 'Process succeeded · results incomplete' },
  { publication: 'complete', resultIssue: null, label: 'Process succeeded · publication complete' },
] as const)('qualifies process success when publication is $publication and issue is $resultIssue',
  async ({ publication, resultIssue, label }) => {
    responses(page([{ name: 'unit', execution: { ...verificationExecution, publication, resultIssue,
      initiatingAgent: { workflowId, runId: 'run-a', agentId: 'agent-a', executionId: 'agent-exec-a' } } }]))
    mount()
    await open()
    const row = await screen.findByRole('button', { name: /CI: unit/ })
    expect(within(row).getByLabelText(label)).toBeInTheDocument()
    expect(within(row).queryByLabelText('Succeeded')).toBeNull()
    expect(within(row).queryByLabelText('Verification: passed')).toBeNull()
  })

function request(index: number): JobQueueTicket {
  return { ...queueTicket, id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    executionId: `not-accepted-${index}`, enqueueSequence: String(index), queuePosition: index,
    definition: { ...queueTicket.definition, name: `CI: agent ${index}` },
    initiatingAgent: { workflowId, runId: 'run-a', agentId: `agent-${index}`, executionId: `agent-exec-${index}` } }
}

it('shows requests across Agents and retains preacceptance cancellation and timeout without fetching an execution', async () => {
  responses(page([]))
  const executionRead = vi.fn()
  let tickets = [request(1), request(2)]
  let filter: string | null = null
  server.use(http.get(`${root}/queue`, ({ request }) => {
    filter = new URL(request.url).searchParams.get('workflowId')
    return HttpResponse.json({ tickets, nextHistoryCursor: null })
  }), http.get(`${root}/executions/:id`, () => {
    executionRead()
    return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'No execution' } }, { status: 404 })
  }))
  const { client } = mount()
  await open()
  expect(await screen.findByRole('heading', { name: 'CI: agent 1' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'CI: agent 2' })).toBeInTheDocument()
  expect(filter).toBe(workflowId)
  expect(screen.queryByText('No jobs yet.')).toBeNull()
  const first = screen.getByRole('region', { name: `Job request ${tickets[0]!.id}` })
  expect(within(first).getByText('offline')).toBeInTheDocument()
  expect(within(first).getByText(queueTicket.deadlineAt)).toBeInTheDocument()
  expect(within(first).getByText('Workspace queue position').nextElementSibling).toHaveTextContent('1')
  tickets = tickets.map((ticket, index) => ({ ...ticket, state: 'terminal', revision: 2,
    terminalReason: index ? 'timed_out' : 'cancelled', finishedAt: ticket.deadlineAt,
    cancelRequestedAt: index ? null : ticket.enqueuedAt, queuePosition: null, waitingReasons: [] }))
  await client.invalidateQueries({ queryKey: ['jobs', workspaceId, 'workflow-queue', workflowId] })
  expect(await screen.findByText('cancelled')).toBeInTheDocument()
  expect(screen.getByText('timed out')).toBeInTheDocument()
  expect(executionRead).not.toHaveBeenCalled()
})

it('reads older request outcomes without duplicating active requests', async () => {
  responses(page([]))
  const active = request(3)
  const completed: JobQueueTicket = { ...request(2), state: 'terminal', terminalReason: 'timed_out',
    finishedAt: queueTicket.deadlineAt, queuePosition: null }
  const older: JobQueueTicket = { ...completed, ...request(1), state: 'terminal', terminalReason: 'timed_out',
    finishedAt: queueTicket.deadlineAt, queuePosition: null }
  const cursors: (string | null)[] = []
  server.use(http.get(`${root}/queue`, ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('historyBeforeSequence')
    cursors.push(cursor)
    return HttpResponse.json({ tickets: cursor ? [active, older] : [active, completed],
      nextHistoryCursor: cursor ? null : '2' })
  }))
  mount()
  await open()
  fireEvent.click(await screen.findByRole('button', { name: 'Older requests' }))
  expect(await screen.findByRole('heading', { name: 'CI: agent 1' })).toBeInTheDocument()
  expect(screen.getAllByRole('heading', { name: 'CI: agent 3' })).toHaveLength(1)
  expect(cursors).toEqual([null, '2'])
})

it('rejects a request from another workflow', async () => {
  responses(page([]))
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [{ ...request(1),
    initiatingAgent: { workflowId: 'foreign', runId: 'other-run', agentId: 'other', executionId: 'other' } }],
    nextHistoryCursor: null })))
  mount()
  await open()
  expect(await screen.findByRole('alert')).toHaveTextContent('another job or workspace')
  expect(screen.queryByRole('heading', { name: 'CI: agent 1' })).toBeNull()
  expect(screen.queryByText('No jobs yet.')).toBeNull()
})

it('keeps process success qualified when published verification artifacts have expired', async () => {
  const value: JobExecutionRecord = { ...verificationExecution,
    initiatingAgent: { workflowId, runId: 'run-a', agentId: 'agent-a', executionId: 'agent-exec-a' } }
  responses(page([{ name: 'unit', execution: value }]))
  const summary = value.acceptedSpec.outputs.find(output => 'kind' in output && output.kind === 'suite-summary')!
  server.use(http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution: value })),
    http.get(`${root}/executions/:id/artifacts`, () => HttpResponse.json({ artifacts: [{
      executionId: value.id, fileId: 'summary', revisionId: 'revision', publicationId: 'publication',
      path: summary.path, mediaType: summary.mediaType, sha256: 'a'.repeat(64), byteSize: 1,
      state: 'expired', expiresAt: '2026-10-02T00:00:00Z',
    }] })))
  mount()
  await open()
  const row = await screen.findByRole('button', { name: /CI: unit/ })
  expect(within(row).getByLabelText('Process succeeded · publication complete')).toBeInTheDocument()
  expect(within(row).queryByLabelText('Succeeded')).toBeNull()
  fireEvent.click(row)
  expect(await screen.findByText('The verification summary has expired.')).toBeInTheDocument()
  expect(screen.queryByText('Verification: passed')).toBeNull()
})

it('removes cached requests after a denied queue readback', async () => {
  responses(page([]))
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [request(1)], nextHistoryCursor: null })))
  const { client } = mount()
  await open()
  expect(await screen.findByRole('heading', { name: 'CI: agent 1' })).toBeInTheDocument()
  server.use(http.get(`${root}/queue`, () => HttpResponse.json({ error: {
    code: 'ACCESS_DENIED', message: 'Denied',
  } }, { status: 403 })))
  await client.invalidateQueries({ queryKey: ['jobs', workspaceId, 'workflow-queue', workflowId] })
  expect(await screen.findByRole('alert')).toHaveTextContent('permission lost')
  expect(screen.queryByRole('heading', { name: 'CI: agent 1' })).toBeNull()
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

it('waits for the history refresh before requesting older jobs', async () => {
  const cursor = { createdAt: execution.createdAt, id: execution.id }
  const refreshed = deferred<WorkflowJobPage>()
  const cursors: (string | null)[] = []
  let refreshing = false
  server.use(http.get(historyPath, async ({ request }) => {
    const received = new URL(request.url).searchParams.get('cursor')
    cursors.push(received)
    if (received) return HttpResponse.json(page([{ name: 'Older build', execution: { ...nodeJob, id: 'older' } }]))
    return HttpResponse.json(refreshing ? await refreshed.promise : { ...page(), nextCursor: cursor })
  }))
  const { client } = mount()
  await open()
  const older = await screen.findByRole('button', { name: 'Older jobs' })
  refreshing = true
  const refresh = client.invalidateQueries({ queryKey: ['jobs', workspaceId, 'workflow', workflowId] })
  await waitFor(() => expect(older).toBeDisabled())
  fireEvent.click(older)
  expect(cursors).toEqual([null, null])

  refreshed.resolve({ ...page([{ name: 'Newest build', execution: { ...nodeJob, id: 'newest' } },
    { name: 'Web build', execution: { ...nodeJob,
      process: { ...nodeJob.process, outcome: 'succeeded', exitCode: 0 } } }]),
  nextCursor: cursor })
  await refresh
  await screen.findByRole('button', { name: /Newest build/ })
  await waitFor(() => expect(older).toBeEnabled())
  fireEvent.click(older)
  await screen.findByRole('button', { name: /Older build/ })
  expect(screen.getAllByRole('button', { name: /Web build/ })).toHaveLength(1)
  expect(within(screen.getByRole('button', { name: /Web build/ }))
    .getByLabelText('Process succeeded · results incomplete')).toBeInTheDocument()
  expect(cursors).toEqual([null, null, JSON.stringify(cursor)])
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

it('retains the selected tail result and its log controls after the history page shifts', async () => {
  const items = Array.from({ length: 50 }, (_, index) => ({
    name: `Build ${index + 1}`,
    execution: { ...nodeJob, id: `execution-${index + 1}` },
  }))
  const selected = items.at(-1)!.execution
  responses(page(items))
  server.use(http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution: selected })),
    http.get(`${root}/executions/:id/logs`, () => HttpResponse.json({ ...logPage,
      chunks: logPage.chunks.map(chunk => ({ ...chunk, executionId: selected.id })) })))
  const { client } = mount()
  await open()
  fireEvent.click(await screen.findByRole('button', { name: /Build 50/ }))
  const search = await screen.findByRole('searchbox', { name: 'Search loaded logs' })
  fireEvent.change(search, { target: { value: 'build failed' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Follow tail' }))
  await screen.findByText(/build failed <script>/)

  server.use(http.get(historyPath, () => HttpResponse.json(page([
    { name: 'Newest build', execution: { ...nodeJob, id: 'newest' } }, ...items.slice(0, 49),
  ]))))
  await client.invalidateQueries({ queryKey: ['jobs', workspaceId, 'workflow', workflowId] })

  expect(screen.getByRole('button', { name: 'Back to jobs' })).toBeInTheDocument()
  expect(screen.getByRole('searchbox', { name: 'Search loaded logs' })).toBe(search)
  expect(search).toHaveValue('build failed')
  expect(screen.getByRole('checkbox', { name: 'Follow tail' })).not.toBeChecked()
  expect(screen.getByText(/build failed <script>/)).toBeInTheDocument()

  server.use(http.get(historyPath, () => HttpResponse.json({ error: {
    code: 'ACCESS_DENIED', message: 'Denied',
  } }, { status: 403 })))
  await client.invalidateQueries({ queryKey: ['jobs', workspaceId, 'workflow', workflowId] })
  expect(await screen.findByRole('alert')).toHaveTextContent('permission lost')
  expect(screen.queryByRole('region', { name: 'Job logs' })).toBeNull()
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
