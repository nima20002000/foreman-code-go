import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '../../../mocks/server'
import { queryKeys } from '../../../shared/api/query'
import { definition } from '../../jobs/fixtures'
import { useGraphDraftStore } from '../store'
import { nextDraftKey } from './state'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'

// Form/registration test with a stubbed canvas. This is not React Flow or authenticated browser evidence.
vi.mock('./DraftCanvas', () => ({ DraftCanvas: () => <div>Canvas fixture</div> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
const saved = { ...definition, workspaceId: 'workspace' }
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, work: () => unknown) => {
    const result = (queues.get(name) ?? Promise.resolve()).then(work)
    queues.set(name, result.catch(() => undefined))
    return result
  } } })
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/definitions', () => HttpResponse.json({ definitions: [saved] })))
})
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
}

it('adds the exact saved job version to the draft from the Board picker', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const user = userEvent.setup(); mount()
  await user.click(screen.getByRole('button', { name: 'Add agent or job to graph' }))
  await user.click(await screen.findByRole('button', { name: 'Web build · revision 1' }))
  const jobs = useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes.filter((node) => node.kind === 'job')
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ kind: 'job', jobDefinitionId: saved.id, jobDefinitionRevision: saved.revision, jobDefinitionVersionId: saved.versionId })
})

it('offers saved jobs only after the explicit one-pass dependency action on a handoff workflow', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, handoffs: { contractVersion: 1 } }) as typeof graph))
  const user = userEvent.setup(); mount()
  await user.click(screen.getByRole('button', { name: 'Add agent or job to graph' }))
  expect(screen.queryByRole('region', { name: 'Choose a saved job for this node' })).toBeNull()
  expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.handoffs).toBeDefined()
  await user.click(screen.getByRole('button', { name: 'Use one-pass dependencies' }))
  expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.handoffs).toBeUndefined()
  expect(await screen.findByRole('button', { name: 'Web build · revision 1' })).toBeInTheDocument()
})
