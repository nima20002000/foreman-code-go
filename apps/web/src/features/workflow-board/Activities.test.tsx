import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunActivityPublicSchema, type RepeatGraphScopeV3, type RunActivitiesPage,
  type RunActivityPublic } from '@graphql/contracts/wave25'
import { server } from '../../mocks/server'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { Activities } from './Activities'
import { runActivitiesKey, type RunActivityFeed } from './runActivitiesQuery'

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

async function mount({ timed = false, expectedText = 'Job ran' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema, component: () => <Activities scope={scope} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), defaultPendingMinMs: 0,
    history: createMemoryHistory({ initialEntries: ['/workspaces/workspace-a?workflowId=workflow-a&selectedRunId=run-a'] }) })
  await router.load()
  if (timed) vi.useFakeTimers()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await act(async () => { await vi.waitFor(() => expect(screen.getByText(expectedText)).toBeVisible()) })
  return router
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const activitiesPath = '*/api/management/workspaces/workspace-a/runs/run-a/activities'
function page(overrides: Partial<RunActivitiesPage> = {}): RunActivitiesPage {
  return { scope, items, mode: 'initial', highWater: '5', retainedFrom: '1',
    nextCursor: 'cursor-5', olderCursor: 'older-1', hasMore: false, ...overrides }
}
function cachedFeed() {
  return clients.at(-1)!.getQueryData<RunActivityFeed>(runActivitiesKey(scope))
}
async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}
async function eventually(assertion: () => void) {
  await act(async () => { await vi.waitFor(assertion) })
}

beforeEach(() => {
  reads = 0
  server.use(http.get('*/api/management/workspaces/workspace-a/runs/run-a/activities', () => {
    reads++
    return HttpResponse.json({ scope, items, mode: 'initial', highWater: '5', retainedFrom: '1',
      nextCursor: 'cursor-5', olderCursor: null, hasMore: false })
  }))
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
})

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

describe('Activities pagination and refresh', () => {
  it('waits for an older page cache write before polling the merged feed', async () => {
    const olderPage = deferred<RunActivitiesPage>()
    const poll = deferred<RunActivitiesPage>()
    const requests: Array<string | null> = []
    server.use(http.get(activitiesPath, async ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requests.push(cursor)
      if (cursor === 'older-1') return HttpResponse.json(await olderPage.promise)
      if (cursor === 'cursor-5') return HttpResponse.json(await poll.promise)
      return HttpResponse.json(page({ items: items.slice(1) }))
    }))
    await mount({ timed: true, expectedText: 'Agent worked' })
    fireEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
    await eventually(() => expect(requests).toEqual([null, 'older-1']))
    await advance(3000)
    expect(requests).toEqual([null, 'older-1'])
    olderPage.resolve(page({ items: [event('1', 'Earlier work', {})], mode: 'older', olderCursor: null }))
    await eventually(() => expect(requests).toEqual([null, 'older-1', 'cursor-5']))
    expect(screen.getByText('Earlier work')).toBeVisible()
    poll.resolve(page({ items: [event('6', 'New work', {})], mode: 'newer', highWater: '6',
      nextCursor: 'cursor-6', olderCursor: null }))
    await eventually(() => expect(screen.getByText('New work')).toBeVisible())
    expect(screen.getByText('Earlier work')).toBeVisible()
    expect(cachedFeed()).toMatchObject({ nextCursor: 'cursor-6', olderCursor: null, retainedFrom: '1' })
    expect(cachedFeed()?.items.map((item) => item.sequence)).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it.each(['older first', 'refresh first'] as const)(
    'fences an older response from Refresh with %s response order', async (order) => {
      const olderPage = deferred<RunActivitiesPage>()
      const refreshed = deferred<RunActivitiesPage>()
      let initialReads = 0
      let olderReads = 0
      server.use(http.get(activitiesPath, async ({ request }) => {
        if (new URL(request.url).searchParams.get('cursor') === 'older-1') {
          olderReads++
          return HttpResponse.json(await olderPage.promise)
        }
        initialReads++
        return HttpResponse.json(initialReads === 1 ? page() : await refreshed.promise)
      }))
      await mount({ timed: true })
      fireEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
      await eventually(() => expect(olderReads).toBe(1))
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Activities' }))
      await eventually(() => expect(initialReads).toBe(2))
      const stale = page({ items: [event('1', 'Stale older work', {})], mode: 'older',
        olderCursor: 'stale-older', retainedFrom: '1' })
      const fresh = page({ items: [event('6', 'Refreshed work', {})], highWater: '6', retainedFrom: '6',
        olderCursor: null, nextCursor: 'fresh-next' })
      if (order === 'older first') {
        olderPage.resolve(stale)
        await advance(0)
        refreshed.resolve(fresh)
      } else {
        refreshed.resolve(fresh)
        await eventually(() => expect(screen.getByText('Refreshed work')).toBeVisible())
        olderPage.resolve(stale)
      }
      await eventually(() => expect(screen.getByText('Refreshed work')).toBeVisible())
      await advance(0)
      expect(screen.queryByText('Stale older work')).not.toBeInTheDocument()
      expect(cachedFeed()).toMatchObject({ items: fresh.items, nextCursor: 'fresh-next',
        olderCursor: null, retainedFrom: '6' })
    },
  )

  it('retires an older cursor after a poll advances retention while keeping retained rows', async () => {
    const requests: Array<string | null> = []
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requests.push(cursor)
      return HttpResponse.json(cursor ? page({ items: [event('6', 'New retained work', {})],
        mode: 'newer', highWater: '6', retainedFrom: '2', nextCursor: 'cursor-6', olderCursor: null }) : page())
    }))
    await mount({ timed: true })
    await advance(3000)
    await eventually(() => expect(screen.getByText('New retained work')).toBeVisible())
    expect(screen.queryByText('Job ran')).not.toBeInTheDocument()
    expect(screen.getByText('Agent worked')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Load older Activities' })).not.toBeInTheDocument()
    expect(requests).toEqual([null, 'cursor-5'])
    expect(cachedFeed()).toMatchObject({ olderCursor: null, nextCursor: 'cursor-6', retainedFrom: '2' })
  })

  it('keeps the current feed visible when its historical cursor expires before the next poll', async () => {
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      if (cursor === 'older-1') return new HttpResponse(null, { status: 410 })
      return HttpResponse.json(cursor ? page({ items: [event('6', 'Continued work', {})], mode: 'newer',
        highWater: '6', nextCursor: 'cursor-6', retainedFrom: '2', olderCursor: null }) : page())
    }))
    await mount({ timed: true })
    fireEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
    await eventually(() => expect(screen.getByText('Activity history has a retention gap.')).toBeVisible())
    expect(screen.getByText('Job ran')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Load older Activities' })).not.toBeInTheDocument()
    await advance(3000)
    await eventually(() => expect(screen.getByText('Continued work')).toBeVisible())
    expect(screen.getByText('Agent worked')).toBeVisible()
    expect(cachedFeed()).toMatchObject({ nextCursor: 'cursor-6', olderCursor: null, retainedFrom: '2' })
  })
})
