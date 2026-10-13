import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { RepeatGraphScopeV3, RunExecutionSummary } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { ciResultJob, ciResultTests } from '../workflow-board/inspect/ciResults.testSupport'
import { AgentExecutionResults } from './AgentExecutionResults'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a',
  workflowVersionId: 'version-a', executionSemanticsVersion: 3 }
const selection = { identity: scope, generation: { id: 1 }, active: true, invalid: false,
  isCurrent: () => true } as unknown as SelectedRunState
const execution: Exclude<RunExecutionSummary, { kind: 'job' }> = {
  workflowNodeId: 'coder', agentId: 'agent-a', agentConfigurationVersionId: 'configuration-a',
  executionId: 'agent-execution', attempt: 1, state: 'running', createdAt: ciResultJob.ci.queuedAt,
  acceptedResultAvailable: false,
}

it('reads Host CI tickets and tests for this initiating execution while excluding another execution', async () => {
  let runFilter: string | null = null
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci', ({ request }) => {
    runFilter = new URL(request.url).searchParams.get('runId')
    return HttpResponse.json({ runId: scope.runId, truncated: false, jobs: [ciResultJob,
      { ...ciResultJob, ticketId: 'foreign-ticket', ci: { ...ciResultJob.ci, part: 'unit-api' },
        requester: { ...ciResultJob.requester, executionId: 'foreign-execution' } }] })
  }), http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () =>
    HttpResponse.json({ ticketId: ciResultJob.ticketId, tests: ciResultTests })),
  http.get('*/api/management/workspaces/:workspaceId/jobs/queue', () =>
    HttpResponse.json({ tickets: [], nextHistoryCursor: null })))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><AgentExecutionResults scope={scope}
    selection={selection} execution={execution} name="Coder" acceptedResult={{ status: 'not_accepted' }} /></QueryClientProvider>)
  try {
    const results = screen.getByRole('region', { name: 'Agent CI results' })
    fireEvent.click(await within(results).findByRole('button', { name: /Show tests of unit · unit-web/ }))
    expect(await screen.findByText('failing example')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Show tests of unit · unit-api/ })).toBeNull()
    expect(runFilter).toBe(scope.runId)
  } finally { view.unmount(); client.clear() }
})
