import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
  boardSearchForInspection, boardSearchForRun, runInspectionKey,
  type RepeatGraphScopeV3, type WorkspaceBoardInspection,
} from '@foreman-code/contracts/wave25'
import { routeTree } from '../../../app/router'
import { server } from '../../../mocks/server'
import { bindMockInstallation } from '../../../shared/mocks/handlers'
import { useGraphDraftStore } from '../../graph/store'
import { nextDraftKey } from '../../graph/nextDraft/state'
import { inspectionBoardFixture } from './inspectionFixtures'
import { useInspectionPresentation } from './presentation'
import { executionPagesKey } from './queries'
import { currentRunKey } from '../currentRunQuery'
import { base as childRoute, child, detail, message, tool } from '../../run-subagents/testFixtures'
import { clearBoardStopStorage, readBoardStop, recordBoardStopReceipt, reserveBoardStop, type BoardStopJournal } from '../stopOutbox'

// Actual registered route, Board, retained authoring owner, pinned React Flow,
// Query hooks, HTTP clients and contract parsers. Only the HTTP service and
// absent JSDOM layout/locking primitives are synthetic; no component mocks.
configure({ asyncUtilTimeout: 5000 })
type Fixture = Awaited<ReturnType<typeof inspectionBoardFixture>>
const clients: QueryClient[] = []
let number = 0, fixture: Fixture
const unhandled: string[] = []
const recordUnhandled = ({ request }: { request: Request }) => unhandled.push(`${request.method} ${request.url}`)
const basePath = (scope: RepeatGraphScopeV3) => `/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}`
function href(scope: RepeatGraphScopeV3, inspection: WorkspaceBoardInspection = {}) {
  const search = boardSearchForInspection({}, scope.workflowId, scope, inspection)
  const params = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)]))
  return `/workspaces/${scope.workspaceId}?${params}`
}
function domInfrastructure() {
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, action: () => unknown) => {
    const result = (queues.get(key) ?? Promise.resolve()).then(action)
    queues.set(key, result.catch(() => undefined))
    return result
  } } })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver))
    }
    unobserve() {} disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720, toJSON: () => ({}),
  }))
}
async function mount(url: string) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  clients.push(cache)
  const history = createMemoryHistory({ initialEntries: [url] })
  const router = createRouter({ routeTree, history, defaultPendingMinMs: 0 })
  await router.load()
  const view = render(<QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByTestId('unified-workflow-board')
  return { ...view, cache, router, history }
}
const pinnedCanvas = () => screen.getByRole('region', { name: 'Selected Run pinned topology' })
const inspector = () => screen.getByRole('region', { name: 'Exact execution inputs and results' })
const eventCalls = () => fixture.mock.calls.filter((call) => call.method === 'GET' && call.path.endsWith('/events'))
async function openDetails() {
  const close = screen.queryByRole('button', { name: 'Close runs' })
  if (!close) await userEvent.setup().click(await screen.findByRole('button', { name: 'Activities' }))
  await screen.findByRole('region', { name: 'Exact execution inputs and results' })
}
async function retainStop(status?: NonNullable<BoardStopJournal['receipt']>['status'], processStopped = false) {
  const scope = fixture.runs.before.scope, journal = await reserveBoardStop(scope)
  if (status) await recordBoardStopReceipt(journal, { runId: scope.runId, status, processStopped, replayed: false })
  return readBoardStop(scope)!
}
beforeEach(async () => {
  unhandled.length = 0
  server.events.on('request:unhandled', recordUnhandled)
  localStorage.clear(); bindMockInstallation(); sessionStorage.clear(); clearBoardStopStorage()
  useGraphDraftStore.setState({ nextDrafts: {} })
  useInspectionPresentation.setState({ open: {} })
  vi.stubGlobal('crypto', webcrypto)
  domInfrastructure()
  fixture = await inspectionBoardFixture(`mounted-inspection-${++number}`)
  server.use(...fixture.mock.handlers)
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((cache) => cache.clear()); clearBoardStopStorage()
  useGraphDraftStore.setState({ nextDrafts: {} })
  useInspectionPresentation.setState({ open: {} })
  server.events.removeListener('request:unhandled', recordUnhandled)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  expect(unhandled, 'No Run inspection request may bypass its MSW service').toEqual([])
})

describe('Run inspection inside the one mounted Board', () => {
  it('shows nested native children on Start-pinned Run links and pages their own recorded items', async () => {
    const scope = fixture.runs.before.scope
    const { workspaceId, workflowId, workflowVersionId, runId } = scope
    const childScope = { workspaceId, workflowId, workflowVersionId, runId }
    const parent = child({ ...childScope, id: 'parent-child', parentNodeId: fixture.first.id,
      parentAgentId: fixture.first.agentId, name: 'Native child' })
    const nested = child({ ...childScope, id: 'nested-child', parentNodeId: fixture.first.id,
      parentAgentId: fixture.first.agentId, parentSubagentId: parent.id, name: 'Nested child' })
    const cursors: string[] = []
    server.use(
      http.get(childRoute, ({ params }) => HttpResponse.json({
        items: params.runId === scope.runId ? [detail(parent), detail(nested)] : [],
        nextCursor: null, projection: 'caught-up',
      })),
      http.get(`${childRoute}/:subagentId`, ({ params }) => HttpResponse.json(detail(
        params.subagentId === nested.id ? nested : parent))),
      http.get(`${childRoute}/:subagentId/messages`, ({ request, params }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        cursors.push(`messages:${cursor ?? 'first'}`)
        return HttpResponse.json({ items: [{ ...message(cursor ?? 'first', cursor ? 'Earlier child answer' : 'Child answer'),
          subagentId: String(params.subagentId) }], nextCursor: cursor ? null : 'messages-next', coverage: parent.coverage })
      }),
      http.get(`${childRoute}/:subagentId/tools`, ({ request, params }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        cursors.push(`tools:${cursor ?? 'first'}`)
        return HttpResponse.json({ items: [{ ...tool(), id: cursor ?? 'first-tool', subagentId: String(params.subagentId) }],
          nextCursor: cursor ? null : 'tools-next', coverage: parent.coverage })
      }),
    )
    const { history } = await mount(`${href(scope)}#keep=anchor`)
    const root = await screen.findByRole('button', { name: 'Native child, Codex, Running' })
    const descendant = await screen.findByRole('button', { name: 'Nested child, Codex, Running' })
    expect(root).toHaveAttribute('data-parent-id', fixture.first.id)
    expect(descendant).toHaveAttribute('data-parent-id', parent.id)
    await userEvent.click(root)
    const panel = await screen.findByRole('dialog', { name: 'Native child' })
    await within(panel).findByText('Child answer')
    expect(history.location.hash).toContain('selectedSubagentId=parent-child')
    expect(within(panel).getByText('Controls are unavailable for this subagent right now.')).toBeVisible()
    expect(within(panel).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Load more messages' }))
    await within(panel).findByText('Earlier child answer')
    await userEvent.click(within(panel).getByRole('tab', { name: /Tool calls/ }))
    await userEvent.click(await within(panel).findByRole('button', { name: 'Load more tool calls' }))
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Load more tool calls' })).not.toBeInTheDocument())
    expect(cursors).toContain('messages:messages-next')
    expect(cursors).toContain('tools:tools-next')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Native child' })).not.toBeInTheDocument())
    expect(root).toHaveFocus()
    expect(history.location.hash).toBe('#keep=anchor')
    await act(async () => { history.back() })
    expect(await screen.findByRole('dialog', { name: 'Native child' })).toBeVisible()
    await act(async () => { history.forward() })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Native child' })).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /^Runs$/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'New run' }))
    expect(history.location.hash).toBe('#keep=anchor')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Native child, Codex, Running' })).not.toBeInTheDocument())
  }, 15_000)
  it('switches before/with/after-repeat Runs without changing the draft or its owner', async () => {
    const user = userEvent.setup(), key = nextDraftKey(fixture.mock.workspaceId, fixture.after.workflowId)
    const { router } = await mount(href(fixture.runs.before.scope))
    await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('Before repeat'))
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
    const boardElement = screen.getByTestId('unified-workflow-board')
    const authoring = screen.getByRole('region', { name: 'Workflow authoring' })
    const instanceId = useGraphDraftStore.getState().nextDrafts[key]!.instanceId
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({
      ...graph, nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Keep this unpublished next draft' })),
    })))
    await openDetails()
    expect(within(inspector()).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: `Open Run ${fixture.runs.repeated.run.id} · completed · succeeded` }))
    await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('With repeat'))
    expect(await within(inspector()).findByRole('combobox', { name: 'Business repetition' })).toBeInTheDocument()
    await user.selectOptions(within(inspector()).getByRole('combobox', { name: 'Run node' }), fixture.second.id)
    await user.click(screen.getByRole('button', { name: `Open Run ${fixture.runs.after.run.id} · completed · succeeded` }))
    await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('After repeat removed'))
    expect(router.state.location.search).not.toHaveProperty('runNodeId')
    expect(router.state.location.search).not.toHaveProperty('runExchangeKey')
    expect(within(inspector()).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    expect(screen.getByTestId('unified-workflow-board')).toBe(boardElement)
    expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBe(authoring)
    expect(useGraphDraftStore.getState().nextDrafts[key]!.instanceId).toBe(instanceId)
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!).initialPrompt).toBe('Keep this unpublished next draft')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  }, 10_000)

  it('does not render a node added later or silently retarget its historical deep link', async () => {
    const scope = fixture.runs.before.scope, requests: URLSearchParams[] = []
    server.use(http.get(`${basePath(scope)}/executions`, ({ request }) => {
      requests.push(new URL(request.url).searchParams)
      return fixture.mock.dispatch(request)
    }))
    const { router, cache } = await mount(href(scope, { runNodeId: fixture.added.id }))
    await screen.findByText('The linked node is not in this Run’s saved version.')
    expect(within(pinnedCanvas()).queryByRole('button', { name: 'Inspect Run node Added later' })).not.toBeInTheDocument()
    await screen.findByText('This selection is not in the Run’s saved version.')
    // C's contextual status uses the same endpoint with limit=1. That bounded
    // read is allowed; the unavailable node must not enable B's history query.
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    expect(requests.every((query) => query.get('limit') === '1' && !query.has('workflowNodeId')
      && !query.has('occurrenceId') && !query.has('cursor'))).toBe(true)
    expect(cache.getQueryState(executionPagesKey(scope, { workflowNodeId: fixture.added.id })))
      .toMatchObject({ status: 'pending', fetchStatus: 'idle', data: undefined })
    expect(within(inspector()).queryByRole('listitem')).not.toBeInTheDocument()
    expect(router.state.location.search.runNodeId).toBe(fixture.added.id)
    await userEvent.setup().click(within(inspector()).getByRole('button', { name: 'Clear detail filter' }))
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('runNodeId'))
    await within(inspector()).findByRole('button', { name: new RegExp(fixture.ordinaryExecutions[1]!.detail.execution.executionId) })
    expect(within(inspector()).getByRole('combobox', { name: 'Run node' }).querySelectorAll('option')).toHaveLength(2)
    expect(requests.some((query) => query.get('limit') === '25' && !query.has('workflowNodeId'))).toBe(true)
    expect(requests.some((query) => query.get('workflowNodeId') === fixture.added.id)).toBe(false)
    expect(cache.getQueryState(executionPagesKey(scope, {})))
      .toMatchObject({ status: 'success', fetchStatus: 'idle' })
  })

  it('settles the exact retained Stop with C mounted in the actions slot, without another command or focus move', async () => {
    const scope = fixture.runs.before.scope
    fixture.mock.runs.get(scope.runId)!.cleanupPending = true
    fixture.mock.currents.get(scope.runId)!.state.run.cleanupPending = true
    const journal = await retainStop('accepted')
    const { cache } = await mount(href(scope, { runNodeId: fixture.first.id }))
    const slot = await screen.findByTestId('run-details-actions-slot')
    await within(slot).findByRole('region', { name: 'Selected Run actions' })
    await waitFor(() => expect(within(slot).getByRole('button', { name: 'Verify cleanup settlement' })).toBeDisabled())
    expect(readBoardStop(scope)).toEqual(journal)
    expect(journal.receipt?.processStopped).toBe(false)
    const focus = screen.getByRole('button', { name: 'Close runs' })
    focus.focus()
    await act(async () => { fixture.mock.settle(scope.runId); await cache.invalidateQueries() })
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    expect(focus).toHaveFocus()
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it.each(['missing', 'not_owner'] as const)('retains a %s Stop receipt after terminal cleanup readback', async (receipt) => {
    const scope = fixture.runs.before.scope
    const journal = await retainStop(receipt === 'missing' ? undefined : receipt)
    const { cache } = await mount(href(scope, { runNodeId: fixture.first.id }))
    await screen.findByRole('region', { name: 'Selected Run actions' })
    await screen.findByRole('button', { name: 'Refresh accepted Run facts' })
    await act(async () => { await cache.invalidateQueries() })
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    expect(readBoardStop(scope)).toEqual(journal)
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('does not clear Stop while the canonical cut still reports cleanup, even with private settled readback', async () => {
    const scope = fixture.runs.before.scope, current = fixture.mock.currents.get(scope.runId)!
    current.state.run.cleanupPending = true
    const journal = await retainStop('already_terminal', true)
    const { cache } = await mount(href(scope, { runNodeId: fixture.first.id }))
    await screen.findByRole('button', { name: 'Refresh accepted Run facts' })
    await screen.findByRole('region', { name: 'Selected Run actions' })
    // Unrelated Board queries keep polling; settlement depends on this Run's readbacks.
    await waitFor(() => expect(cache.getQueryState<typeof current>(currentRunKey(scope))).toMatchObject({
      status: 'success', fetchStatus: 'idle', data: { state: { run: { cleanupPending: true } } },
    }))
    const stop = await screen.findByRole('region', { name: 'Stop and cleanup' })
    await waitFor(() => expect(within(stop).getByRole('button', { name: 'Verify cleanup settlement' })).toBeEnabled())
    expect(readBoardStop(scope)).toEqual(journal)
    await act(async () => {
      current.state.run.cleanupPending = false
      current.asOfSequence = '1'
      await cache.invalidateQueries({ queryKey: currentRunKey(scope), exact: true })
    })
    await waitFor(() => expect(cache.getQueryData<typeof current>(currentRunKey(scope))).toMatchObject({
      asOfSequence: '1', state: { run: { cleanupPending: false } },
    }))
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('retains the journal when private Run readback fails and settles only after an explicit successful retry', async () => {
    const scope = fixture.runs.before.scope, journal = await retainStop('accepted')
    let unavailable = true
    server.use(http.get(basePath(scope), ({ request }) => unavailable ? HttpResponse.json({
      error: { code: 'UNAVAILABLE', message: 'Private Run readback is unavailable' },
    }, { status: 503 }) : fixture.mock.dispatch(request)))
    const { cache } = await mount(href(scope, { runNodeId: fixture.first.id }))
    await screen.findByText('Private Run details are unavailable.')
    await screen.findByRole('region', { name: 'Selected Run actions' })
    await waitFor(() => expect(cache.getQueryState(currentRunKey(scope)))
      .toMatchObject({ status: 'success', fetchStatus: 'idle' }))
    expect(readBoardStop(scope)).toEqual(journal)
    unavailable = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry pinned details' }))
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('reopens an occurrence/execution deep link with exact accepted input, result and bindings', async () => {
    const expected = fixture.repeatedExecutions[2]!, id = expected.detail.execution.executionId
    const occurrenceId = expected.detail.execution.occurrence!.occurrenceId
    const url = href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ occurrenceId, executionId: id }) })
    const mounted = await mount(url)
    const article = await screen.findByRole('article', { name: `Execution ${id}` })
    expect(JSON.parse(within(article).getByLabelText(`Input ${id}`).textContent!)).toEqual(expected.detail.acceptedInput.value)
    expect(expected.detail.acceptedResult.status).toBe('accepted')
    if (expected.detail.acceptedResult.status !== 'accepted') throw new Error('Fixture must have an accepted result')
    expect(JSON.parse(within(article).getByLabelText(`Accepted result ${id}`).textContent!)).toEqual(expected.detail.acceptedResult.value)
    expect(within(inspector()).getByRole('combobox', { name: 'Business repetition' })).toHaveValue(occurrenceId)
    expect(fixture.mock.calls.some((call) => call.path.endsWith('/bindings'))).toBe(false)
    fireEvent.click(within(article).getByText('Exact predecessor/result bindings'))
    expect(await within(article).findByLabelText(`Binding ${expected.bindings[0]!.bindingId}`)).toHaveTextContent(expected.detail.acceptedInput.digest)
    fireEvent.click(within(inspector()).getByText('Saved node configuration (this Run)'))
    const saved = await within(inspector()).findByLabelText(`Saved Run node ${fixture.second.id}`)
    expect(JSON.parse(saved.textContent!).node).toEqual(fixture.second)
    expect(saved).not.toHaveTextContent('Current Agent name')
    const reopenedUrl = mounted.router.state.location.href
    mounted.unmount(); mounted.cache.clear()
    act(() => useInspectionPresentation.setState({ open: {} }))
    await mount(reopenedUrl)
    const reopened = await screen.findByRole('article', { name: `Execution ${id}` })
    expect(JSON.parse(within(reopened).getByLabelText(`Accepted result ${id}`).textContent!)).toEqual(expected.detail.acceptedResult.value)
    expect(within(inspector()).getByRole('combobox', { name: 'Business repetition' })).toHaveValue(occurrenceId)
    expect(pinnedCanvas()).toHaveTextContent(fixture.repeated.id)
  })

  it('keeps technical failure separate from accepted result and permits another real attempt', async () => {
    const attempt = fixture.repeatedExecutions[1]!.detail, id = attempt.execution.executionId
    await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ occurrenceId: attempt.execution.occurrence!.occurrenceId, executionId: id }) }))
    const article = await screen.findByRole('article', { name: `Execution ${id}` })
    expect(within(article).queryByLabelText(`Accepted result ${id}`)).not.toBeInTheDocument()
    expect(article).toHaveTextContent('No accepted result is recorded for this exact execution.')
    expect(within(article).queryByLabelText(`Reported result ${id}`)).not.toBeInTheDocument()
    fireEvent.click(within(article).getByText('Recorded execution result (not proof of acceptance)'))
    expect(await within(article).findByLabelText(`Reported result ${id}`)).toHaveTextContent('FIXTURE_INTERRUPTED')
    const acceptedId = fixture.repeatedExecutions[2]!.detail.execution.executionId
    await userEvent.setup().click(await within(inspector()).findByRole('button', { name: new RegExp(acceptedId) }))
    const accepted = await screen.findByRole('article', { name: `Execution ${acceptedId}` })
    expect(within(accepted).getByLabelText(`Accepted result ${acceptedId}`)).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: `Execution ${id}` })).not.toBeInTheDocument()
  })

  it('loads activity only on expansion, pages it, and refreshes only the first page', async () => {
    await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id }))
    await screen.findByText('Run activity history')
    expect(eventCalls()).toHaveLength(0)
    const summary = screen.getByText('Run activity history'), history = summary.closest('details')!
    fireEvent.click(summary)
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(50))
    expect(eventCalls()).toHaveLength(1)
    expect(within(history).queryByLabelText(/^Activity /)).not.toBeInTheDocument()
    await userEvent.setup().click(within(history).getByRole('button', { name: 'Load more activity' }))
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(52))
    expect(eventCalls()).toHaveLength(2)
    await userEvent.setup().click(within(history).getByRole('button', { name: 'Refresh activity' }))
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(50))
    expect(eventCalls()).toHaveLength(3)
    fireEvent.click(within(history).getAllByText('Activity details')[0]!)
    expect(await within(history).findByLabelText(`Activity ${fixture.mock.history.get(fixture.runs.repeated.run.id)![0]!.id}`))
      .toHaveTextContent('Historical event 0')
  })

  it('shows unavailable pinned topology without falling back to the current draft', async () => {
    server.use(http.get(`${basePath(fixture.runs.before.scope)}/version`, () => HttpResponse.json({
      error: { code: 'NOT_FOUND', message: 'Immutable version is unavailable' },
    }, { status: 404 })))
    await mount(href(fixture.runs.before.scope))
    await screen.findByText('The selected Run topology is unavailable.')
    expect(within(pinnedCanvas()).queryByLabelText('Run graph canvas')).not.toBeInTheDocument()
    expect(within(pinnedCanvas()).queryByText('After repeat removed')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Editable workflow graph')).toHaveAttribute('aria-hidden', 'true')
  })

  it('ignores a late exact execution response after switching Runs', async () => {
    const previous = fixture.repeatedExecutions[2]!.detail
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    let started = false
    server.use(http.get(`${basePath(fixture.runs.repeated.scope)}/executions/${previous.execution.executionId}`, async () => {
      started = true; await pending; return HttpResponse.json(previous)
    }))
    await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ executionId: previous.execution.executionId }) }))
    await waitFor(() => expect(started).toBe(true))
    try {
      await userEvent.setup().click(await screen.findByRole('button', { name: `Open Run ${fixture.runs.before.run.id} · completed · succeeded` }))
      await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('Before repeat'))
    } finally { await act(async () => { release(); await pending }) }
    expect(screen.queryByLabelText(`Accepted result ${previous.execution.executionId}`)).not.toBeInTheDocument()
    expect(within(inspector()).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
  })

  it('keeps exact history available when bounded current-state refresh fails', async () => {
    const expected = fixture.repeatedExecutions[2]!.detail
    server.use(http.get(/\/graph\/.*\/current$/, () => HttpResponse.json({
      error: { code: 'GRAPH_NOT_INITIALIZED', message: 'Current projection is unavailable' },
    }, { status: 503 })))
    await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ executionId: expected.execution.executionId }) }))
    await screen.findByRole('article', { name: `Execution ${expected.execution.executionId}` })
    expect(await screen.findByLabelText(`Accepted result ${expected.execution.executionId}`)).toBeInTheDocument()
    await screen.findByText('Current Run state is unavailable.')
    expect(pinnedCanvas()).toHaveTextContent(fixture.repeated.id)
  })

  it('returns keyboard focus to the stable Details trigger when closing the Run drawer', async () => {
    const user = userEvent.setup()
    await mount(href(fixture.runs.before.scope))
    const trigger = await screen.findByRole('button', { name: 'Activities' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('button', { name: 'Close runs' })
    await user.click(screen.getByRole('button', { name: 'Close runs' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('restores an execution selection through URL back navigation without a separate page', async () => {
    const expected = fixture.repeatedExecutions[2]!.detail
    const { router, history } = await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ executionId: expected.execution.executionId }) }))
    await screen.findByRole('article', { name: `Execution ${expected.execution.executionId}` })
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: fixture.mock.workspaceId },
      search: boardSearchForRun({}, fixture.after.workflowId, fixture.runs.after.scope) }) })
    await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('After repeat removed'))
    await act(async () => { history.back() })
    await screen.findByRole('article', { name: `Execution ${expected.execution.executionId}` })
    expect(router.state.location.pathname).toBe(`/workspaces/${fixture.mock.workspaceId}`)
    expect(screen.getAllByTestId('unified-workflow-board')).toHaveLength(1)
  })
})
