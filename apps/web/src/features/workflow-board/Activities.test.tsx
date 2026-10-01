import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunActivityPublicSchema, type RepeatGraphScopeV3, type RunActivityPublic } from '@graphql/contracts/wave25'
import { server } from '../../mocks/server'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { Activities } from './Activities'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace-a', workflowId: 'workflow-a',
  workflowVersionId: 'version-a', runId: 'run-a', executionSemanticsVersion: 3 }
const agent = { agentId: 'agent-builder', agentName: 'Builder', nodeId: 'agent-node', nodeName: 'Agent node' }
const job = { kind: 'job' as const, nodeId: 'job-node', nodeName: 'Build release',
  jobDefinitionId: 'agent-builder', jobDefinitionRevision: 2, jobDefinitionVersionId: 'job-version' }
const event = (sequence: string, summary: string, participants: Pick<RunActivityPublic, 'actor' | 'subject'>,
  kind: RunActivityPublic['kind'] = 'job_work') => RunActivityPublicSchema.parse({
  id: `activity-${sequence}`, scope, sequence, occurredAt: '2026-10-01T12:00:00.000Z',
  source: 'backend', kind, status: 'recorded', severity: 'info', summary, refs: {}, ...participants,
})
const items = [
  event('1', 'Job ran', { actor: job }),
  event('2', 'Agent worked', { actor: agent }, 'agent_work'),
  event('3', 'Job notified Agent', { actor: job, subject: agent }, 'work_notice'),
  event('4', 'Job was queued', { subject: job }),
  event('5', 'Run recorded', {}, 'run'),
]
const clients: QueryClient[] = []
let reads = 0

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema, component: () => <Activities scope={scope} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), defaultPendingMinMs: 0,
    history: createMemoryHistory({ initialEntries: ['/workspaces/workspace-a?workflowId=workflow-a&selectedRunId=run-a'] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByText('Job ran')
  return router
}

beforeEach(() => {
  reads = 0
  server.use(http.get('*/api/management/workspaces/workspace-a/runs/run-a/activities', () => {
    reads++
    return HttpResponse.json({ scope, items, mode: 'initial', highWater: '5', retainedFrom: '1',
      nextCursor: 'cursor-5', olderCursor: null, hasMore: false })
  }))
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()) })

describe('Activities shared Agent and Job actors', () => {
  it('labels Job actors and subjects while listing only true Agents in the Agent filter', async () => {
    await mount()
    for (const summary of ['Job ran', 'Job notified Agent', 'Job was queued']) {
      const row = screen.getByText(summary).closest('li')!
      expect(within(row).getByText('Job · Build release')).toBeVisible()
      expect(within(row).queryByText('Workflow')).not.toBeInTheDocument()
    }
    expect(within(screen.getByText('Agent worked').closest('li')!).getByText('Builder')).toBeVisible()
    expect(within(screen.getByText('Run recorded').closest('li')!).getByText('Workflow')).toBeVisible()
    const options = within(screen.getByRole('combobox', { name: 'Agent' }))
    expect(options.getByRole('option', { name: /^Builder$/ })).toHaveValue(agent.agentId)
    expect(options.queryByRole('option', { name: /Build release/ })).not.toBeInTheDocument()
  })

  it('matches real Agent actors or subjects without treating a Job definition ID as an Agent ID', async () => {
    const router = await mount()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), agent.agentId)
    await waitFor(() => expect(screen.queryByText('Job ran')).not.toBeInTheDocument())
    expect(screen.getByText('Agent worked')).toBeVisible()
    expect(screen.getByText('Job notified Agent')).toBeVisible()
    expect(screen.queryByText('Job was queued')).not.toBeInTheDocument()
    expect(screen.queryByText('Run recorded')).not.toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ activityAgentId: agent.agentId, selectedRunId: 'run-a', workflowId: 'workflow-a' })
  })

  it('keeps the existing kind filter and refresh action usable for Job activity', async () => {
    const router = await mount()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Activity kind' }), 'job_work')
    await waitFor(() => expect(screen.queryByText('Agent worked')).not.toBeInTheDocument())
    expect(screen.getByText('Job ran')).toBeVisible()
    expect(screen.getByText('Job was queued')).toBeVisible()
    const previous = reads
    await userEvent.click(screen.getByRole('button', { name: 'Refresh Activities' }))
    await waitFor(() => expect(reads).toBeGreaterThan(previous))
    expect(await screen.findByText('Job ran')).toBeVisible()
    expect(router.state.location.search).toMatchObject({ activityKind: 'job_work', selectedRunId: 'run-a' })
  })
})
