import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { ReadSelectedRunChatResponseSchema } from '@graphql/contracts/selected-run-chat'
import { routeTree } from '../app/router'
import { useGraphDraftStore } from '../features/graph/store'
import { nextDraftKey } from '../features/graph/nextDraft/state'
import { reply, runsUrl } from '../features/run-board/testFixtures'
import { installFlowLayout } from '../features/run-board/testFlowLayout'
import { page, runA, runB } from '../features/runs-selector/testFixtures'
import { bindMockInstallation } from '../shared/mocks/handlers'
import { getMockFixture, setMockScenario } from '../shared/mocks/scenarios'
import { server } from '../mocks/server'

const scope = { workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline' }
const key = nextDraftKey(scope.workspaceId, scope.workflowId)
const runsRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs'
const clients: QueryClient[] = []
const unhandled: string[] = []
const writes: string[] = [], scheduleReads: string[] = []
const recordUnhandled = ({ request }: { request: Request }) => unhandled.push(`${request.method} ${request.url}`)
const recordWrite = ({ request }: { request: Request }) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) writes.push(`${request.method} ${new URL(request.url).pathname}`)
}

async function mount(entry = runsUrl(null, scope)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  clients.push(client)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  const result = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { ...result, router, client }
}
async function authoring() {
  const editor = await screen.findByRole('region', { name: 'Workflow authoring' }, { timeout: 3000 })
  await within(editor).findByRole('heading', { name: 'Research to review' })
  return editor
}
async function choose(runId: string | null) {
  const controls = screen.getByRole('group', { name: 'Board controls' })
  await userEvent.click(within(controls).getByRole('button', { name: /^Runs$/ }))
  const menu = await screen.findByRole('menu', { name: 'Runs' })
  const item = runId === null ? within(menu).getByRole('menuitemradio', { name: 'Current workflow' })
    : await waitFor(() => {
      const row = menu.querySelector<HTMLButtonElement>(`[data-run-id="${runId}"]`)
      expect(row).not.toBeNull()
      return row!
    })
  await userEvent.click(item)
}
const savedY = () => screen.findByRole('img', { name: 'Y, saved agent, read only' })

beforeEach(() => {
  unhandled.length = 0; server.events.on('request:unhandled', recordUnhandled)
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear(); sessionStorage.clear(); bindMockInstallation()
  writes.length = 0; scheduleReads.length = 0
  server.events.on('request:start', recordWrite)
  installFlowLayout(1000, 720)
  const fixture = getMockFixture(scope.workspaceId)!
  server.use(
    http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({
      evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 1,
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
    })),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
      workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [],
    })),
    http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json({
      workspace: fixture.workspace, revision: 1, archivedAt: null,
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' }, locationRevision: 1,
      locationValidation: { status: 'ready', checkedAt: '2026-09-19T00:00:00.000Z' },
    })),
    http.get(`${runsRoute}/summaries`, () => HttpResponse.json(page([runA, runB]))),
    http.get(`${runsRoute}/:runId/snapshot`, ({ params }) => HttpResponse.json(reply(String(params.runId), {
      workspaceId: String(params.workspaceId), workflowId: String(params.workflowId),
    }))),
    http.get('*/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:workflowNodeId',
      ({ params }) => HttpResponse.json(ReadSelectedRunChatResponseSchema.parse({ kind: 'unavailable',
        target: { workspaceId: String(params.workspaceId), workflowId: String(params.workflowId),
          runId: String(params.runId), workflowNodeId: String(params.workflowNodeId) }, reason: 'execution_missing',
      }))),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/schedule', ({ request }) => {
      scheduleReads.push(new URL(request.url).pathname)
      return HttpResponse.json({ schedule: null })
    }),
  )
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  server.events.removeListener('request:unhandled', recordUnhandled)
  expect(unhandled, 'No selected Board request may bypass MSW').toEqual([])
  server.events.removeListener('request:start', recordWrite)
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear(); sessionStorage.clear(); setMockScenario('normal')
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

describe('SCH-BOARD on the real workspace route, editor and HTTP boundary', () => {
  it('shows A read-only, fences hidden authoring actions, and restores the SAME unsaved editor', async () => {
    const { router } = await mount()
    const editor = await authoring()
    const canvas = within(editor).getByLabelText('Editable workflow graph')
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, name: 'Unsaved board name' })))
    await within(editor).findByRole('heading', { name: 'Unsaved board name' })
    const graph = useGraphDraftStore.getState().nextDrafts[key]!.graph
    const save = within(editor).getByRole('button', { name: /^Save changes$/ })
    const writesBefore = [...writes]

    await choose('run-a'); await savedY()
    expect(router.state.location.search.selectedRunId).toBe('run-a')
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveTextContent('Read only')
    expect(screen.getByRole('region', { name: 'Selected Run chat' })).toHaveAttribute('data-run-id', 'run-a')
    expect(editor.closest('.run-board-current')).toHaveAttribute('hidden')
    expect(editor.closest('.run-board-current')).toHaveAttribute('inert')
    expect(editor).not.toBeVisible()
    expect(screen.queryByRole('button', { name: /Save changes|Start saved version|Save and run|Stop run/i })).not.toBeInTheDocument()
    // Programmatic events exercise the additional fence, beyond native inert.
    fireEvent.click(save)
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'y', metaKey: true })
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).toBe(graph)
    expect(writes).toEqual(writesBefore)
    expect(screen.queryByRole('alertdialog', { name: 'Save changes before leaving?' })).not.toBeInTheDocument()

    await choose(null)
    await waitFor(() => expect(editor).toBeVisible())
    expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBe(editor)
    expect(within(editor).getByLabelText('Editable workflow graph')).toBe(canvas)
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).toBe(graph)
    expect(within(editor).getByRole('heading', { name: 'Unsaved board name' })).toBeVisible()
    expect(router.state.location.search.selectedRunId).toBeUndefined()
    expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument()
  }, 20_000)

  it('restores the URL-selected Run in a fresh Router and QueryClient, with back/forward selection', async () => {
    const first = await mount()
    await authoring(); await choose('run-a'); await savedY()
    await act(async () => { first.router.history.back() })
    await waitFor(() => expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBeVisible())
    await act(async () => { first.router.history.forward() })
    await savedY()
    const href = first.router.history.location.href
    first.unmount(); first.client.clear(); useGraphDraftStore.getState().clearAllDrafts()
    const refreshed = await mount(href)
    await savedY()
    expect(refreshed.router.state.location.search.selectedRunId).toBe('run-a')
    expect(screen.queryByRole('region', { name: 'Workflow authoring' })).not.toBeInTheDocument()
  })

  it('opens the saved-workflow clock from history, without scheduling the historical version', async () => {
    await mount(); await authoring()
    await choose('run-a'); await savedY()
    expect(scheduleReads).toEqual([])
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule workflow' }))
    const modal = await screen.findByRole('dialog', { name: /^Schedule$/ })
    await within(modal).findByRole('tab', { name: 'Weekly' })
    expect(scheduleReads.length).toBeGreaterThan(0)
    expect(new Set(scheduleReads)).toEqual(new Set(['/api/management/workspaces/workspace-1/workflows/workflow-content-pipeline/schedule']))
    expect(within(modal).getByRole('button', { name: /^Save$/ })).toBeEnabled()
    await userEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(modal).not.toBeVisible())
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-run-id', 'run-a')
  })

  it('canonicalizes a legacy Run link and preserves unrelated selection and hash', async () => {
    const entry = `/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/run-a/graph/version-a/3?workflowId=${scope.workflowId}&agentId=agent-researcher#board`
    const { router } = await mount(entry)
    await savedY()
    const hash = router.history.location.hash
    await choose('run-b')
    await screen.findByRole('img', { name: 'X in B, saved agent, read only' })
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1')
    expect(router.state.location.search).toMatchObject({ workflowId: scope.workflowId, selectedRunId: 'run-b', agentId: 'agent-researcher' })
    expect(router.state.location.search.runId).toBeUndefined()
    expect(router.state.location.search.workflowVersionId).toBeUndefined()
    expect(router.state.location.search.executionSemanticsVersion).toBeUndefined()
    expect(router.history.location.hash).toBe(hash)
    await choose(null)
    expect(router.state.location.search.agentId).toBe('agent-researcher')
    expect(router.history.location.hash).toBe(hash)
  })

  it('never falls back to the first workflow after a requested history workflow is missing', async () => {
    const missing = { ...scope, workflowId: 'workflow-missing' }
    const notFound = () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })
    server.use(
      http.get('*/api/management/workspaces/workspace-1/workflows/workflow-missing', notFound),
      http.get(`${runsRoute}/:runId/snapshot`, notFound),
    )
    const { router } = await mount(runsUrl('run-a', missing))
    const board = await screen.findByRole('region', { name: 'Selected Run board' })
    await waitFor(() => expect(board).toHaveAttribute('aria-busy', 'false'))
    expect(router.state.location.search).toMatchObject({ workflowId: 'workflow-missing', selectedRunId: 'run-a' })
    expect(screen.queryByRole('region', { name: 'Workflow authoring' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('run-board-canvas')).not.toBeInTheDocument()
  })

  it('rejects an unscoped or conflicting history request without choosing the current workflow', async () => {
    const { router } = await mount('/workspaces/workspace-1?selectedRunId=run-a')
    await screen.findByText('Invalid board selection')
    expect(router.state.location.search.workflowId).toBeUndefined()
    expect(router.state.location.search.selectedRunId).toBe('run-a')
    await act(async () => { await router.navigate({ href: `${runsUrl('run-a', scope)}&runId=run-b&workflowVersionId=version-b&executionSemanticsVersion=3` }) })
    expect(await screen.findByText('Invalid board selection')).toBeVisible()
    expect(screen.queryByTestId('unified-workflow-board')).not.toBeInTheDocument()
  })

  it('keeps the compact clock, Runs and Files controls adjacent at 320px (DOM/CSS invariants only)', async () => {
    vi.stubGlobal('innerWidth', 320)
    installFlowLayout(320, 480)
    const { container } = await mount(runsUrl('run-a', scope))
    await savedY()
    const group = screen.getByRole('group', { name: 'Board controls' })
    const clock = await within(group).findByRole('button', { name: 'Schedule workflow' })
    const selector = within(group).getByRole('button', { name: /^Runs$/ })
    const files = within(group).getByRole('button', { name: 'Files' })
    expect(clock.compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(selector.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(group.closest('header')).toHaveStyle({ position: 'static', minWidth: '0', boxSizing: 'border-box' })
    expect(container.querySelector('.unified-workflow-board')).toHaveStyle({ flexDirection: 'column' })
    await userEvent.click(selector)
    const menu = await screen.findByRole('menu', { name: 'Runs' })
    await waitFor(() => expect(menu).toHaveStyle({ width: '296px' }))
    expect(within(menu).getByRole('menuitemradio', { name: 'Current workflow' })).toBeEnabled()
  })
})
