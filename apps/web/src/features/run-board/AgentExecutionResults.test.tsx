import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { RunExecutionSummary, RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { autoQueueTicket, execution as job, definition, logPage } from '../jobs/fixtures'
import { AgentExecutionResults } from './AgentExecutionResults'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a',
  workflowVersionId: 'version-a', executionSemanticsVersion: 3 }
const selection = { identity: scope, generation: { id: 1 }, active: true, invalid: false,
  isCurrent: () => true } as unknown as SelectedRunState
const execution: Exclude<RunExecutionSummary, { kind: 'job' }> = {
  workflowNodeId: 'coder', agentId: 'agent-a', agentConfigurationVersionId: 'configuration-a',
  executionId: 'agent-execution', attempt: 1, state: 'running', createdAt: job.createdAt,
  acceptedResultAvailable: false,
}
const initiatingAgent = { workflowId: scope.workflowId, runId: scope.runId,
  agentId: execution.agentId, executionId: execution.executionId }
const jobsRoot = '*/api/management/workspaces/:workspaceId/jobs/executions/:executionId'
function responses(origin = initiatingAgent, state: 'accepted' | 'terminal' = 'accepted') {
  const ticket = { ...autoQueueTicket, initiatingAgent, state,
    terminalReason: state === 'terminal' ? 'completed' : null,
    finishedAt: state === 'terminal' ? job.createdAt : null, executionId: job.id,
    reservationId: autoQueueTicket.id, selectedComputer: { target: definition.spec.target,
      rootId: '11111111-1111-4111-8111-111111111111', bindingRevision: 1, profileId: 'profile', profileRevision: 1 } }
  let filter: string | null = null
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/queue', ({ request }) => {
    filter = new URL(request.url).searchParams.get('initiatingExecutionId')
    return HttpResponse.json({ tickets: [ticket], nextHistoryCursor: null })
  }), http.get(jobsRoot, () => HttpResponse.json({ execution: { ...job, workflow: null, initiatingAgent: origin } })),
  http.get(`${jobsRoot}/logs`, () => HttpResponse.json(logPage)),
  http.get(`${jobsRoot}/artifacts`, () => HttpResponse.json({ artifacts: [] })),
  http.get('*/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:nodeId', () =>
    HttpResponse.json({ kind: 'unavailable', target: { workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId, workflowNodeId: execution.workflowNodeId }, reason: 'execution_missing' })))
  return () => filter
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}>
    <AgentExecutionResults scope={scope} selection={selection} execution={execution} name="Coder" />
  </QueryClientProvider>)
  return { ...view, client }
}
it.each(['accepted', 'terminal'] as const)(
  'shows %s CI results, logs, artifacts and parent Run using separate Agent provenance', async state => {
  const filter = responses(initiatingAgent, state)
  const { client, unmount } = mount()
  try {
    expect(await screen.findByText('Process: build failed')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Job logs' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Job artifacts' })).toBeInTheDocument()
    expect(screen.getByText('Initiating Run / Agent / execution')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'run-a' })).toHaveAttribute('href',
      '/workspaces/workspace-a?workflowId=workflow-a&selectedRunId=run-a')
    expect(screen.queryByRole('button', { name: /Request cancellation|Review rerun/ })).toBeNull()
    expect(filter()).toBe(execution.executionId)
  } finally { unmount(); client.clear() }
})
it('withholds a job result that belongs to another initiating Agent execution', async () => {
  responses({ ...initiatingAgent, executionId: 'foreign-execution' })
  const { client, unmount } = mount()
  try {
    await screen.findByText('CI origin mismatch')
    expect(screen.queryByText('Process: build failed')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Job logs' })).toBeNull()
  } finally { unmount(); client.clear() }
})
it('withdraws cached CI results when an authenticated queue refresh is denied', async () => {
  responses()
  const { client, unmount } = mount()
  try {
    await screen.findByText('Process: build failed')
    server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/queue', () =>
      HttpResponse.json({ error: { code: 'DENIED', message: 'No access' } }, { status: 403 })))
    await client.refetchQueries({ queryKey: ['saved-run-inspection'] })
    await waitFor(() => expect(screen.queryByText('Process: build failed')).toBeNull())
    expect(screen.getByText(/CI history unavailable/)).toBeInTheDocument()
  } finally { unmount(); client.clear() }
})
