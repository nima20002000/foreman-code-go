// @vitest-environment jsdom
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { type WorkflowDefinitionV3, WorkflowVersionV3Schema, CurrentWorkflowCreateInputSchema, RunStartV3InputSchema } from '@graphql/contracts/wave25'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey, nextDraftDirty } from '../graph/nextDraft/state'
import { readBoardStart } from './startOutbox'
import { readBoardStop } from './stopOutbox'
import { readEditOutbox } from '../graph/nextDraft/editIntentStorage'
import { queryKeys } from '../../shared/api/query'

// The route tree, RootShell, sidebar, creation dialog, persisted boundary, Board,
// canvas, form, Query hooks, Zustand store, HTTP clients and schemas are REAL.
// Only HTTP and absent JSDOM measurement/locking APIs are fixtures. This is source
// acceptance, not an authenticated real-browser/PostgreSQL/native success claim.
type Mock = ReturnType<typeof createCurrentBoardMock>
type Shape = 'single' | 'sequential' | 'parallel' | 'conditional' | 'approval' | 'repeat-ready'
const clients: QueryClient[] = []
const unhandledRequests: string[] = []
const recordUnhandled = ({ request }: { request: Request }) => {
  unhandledRequests.push(`${request.method} ${request.url}`)
}
// Scope role queries to small control surfaces instead of repeatedly scanning
// every Agent action and hidden panel in the real React Flow canvas.
const authoring = () => screen.getByRole('region', { name: 'Workflow authoring' })
const controls = () => within(authoring()).getByRole('group', { name: 'Workflow controls' })
const control = (name: string) => within(controls()).getByRole('button', { name })
const saveButton = () => within(screen.getByRole('region', { name: 'Unsaved changes' }))
  .getByRole('button', { name: /^Save changes$/ })
let fixtureNumber = 0
function newBoardMock(options: Parameters<typeof createCurrentBoardMock>[0] = {}) {
  // Separate synthetic backends must not alias the module-level local-draft cache.
  // A reopen deliberately retains this same factory and workspace identity.
  return createCurrentBoardMock({ ...options, workspaceId: `ws-board-case-${++fixtureNumber}` })
}
function locks() {
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, action: () => unknown) => {
    const result = (queues.get(key) ?? Promise.resolve()).then(action); queues.set(key, result.catch(() => undefined)); return result
  } } })
}
configure({ asyncUtilTimeout: 5000 })
beforeEach(() => {
  unhandledRequests.length = 0; server.events.on('request:unhandled', recordUnhandled)
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); sessionStorage.clear(); locks()
  // DOM infrastructure only; never stub a Board/editor/React Flow component.
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {} disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720, toJSON: () => ({}) }))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  server.events.removeListener('request:unhandled', recordUnhandled)
  expect(unhandledRequests, 'No unhandled Board request may bypass MSW').toEqual([])
})

async function mount(mock: Mock, href = `/workspaces/${mock.workspaceId}`) {
  server.use(...mock.handlers)
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  clients.push(query)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [href] }), defaultPendingMinMs: 0 })
  // Complete initial memory routing before mounting; do not race a second load
  // against RouterProvider. Query/HTTP work still runs through the real controls.
  await router.load()
  const result = render(<QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider>)
  return { ...result, router, query }
}
async function create(mock: Mock, user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New workflow' }))
  const dialog = await screen.findByRole('dialog', { name: 'New workflow' })
  const name = within(dialog).getByRole('textbox', { name: 'Name' })
  await user.click(name)
  await user.paste('S3 mounted workflow')
  expect(name).toHaveValue('S3 mounted workflow')
  await user.click(within(dialog).getByRole('button', { name: 'Create workflow' }))
  await screen.findByTestId('unified-workflow-board')
  await screen.findByRole('region', { name: 'Workflow authoring' })
  const id = [...mock.workflows.keys()].at(-1)!
  const key = nextDraftKey(mock.workspaceId, id)
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  const creation = mock.calls.find((call) => call.method === 'POST' && call.path.endsWith('/workflows'))!
  expect(CurrentWorkflowCreateInputSchema.parse(creation.body).executionSemanticsVersion).toBe(3)
  expect(mock.workflows.get(id)).not.toHaveProperty('repeat')
  return { id, key }
}
function shapeGraph(base: WorkflowDefinitionV3, shape: Shape, mock: Mock): WorkflowDefinitionV3 {
  const count = shape === 'single' ? 1 : shape === 'parallel' ? 5 : shape === 'conditional' ? 3 : 2
  const nodes = mock.agents.slice(0, count).map((agent, i) => ({ id: `node-${agent.id}`, agentId: agent.id, name: agent.name,
    position: { x: i * 250, y: i % 2 * 180 }, ...(shape === 'parallel' && i === 4 ? { join: { mode: 'all' as const } } : {}) }))
  const pairs = shape === 'single' ? [] : shape === 'parallel' ? [[0, 1], [0, 2], [2, 3], [1, 4], [3, 4]]
    : shape === 'conditional' ? [[0, 1], [0, 2]] : [[0, 1]]
  const edges = pairs.map(([from, to], i) => ({ id: `handoff-${i}`, source: nodes[from!]!.id, target: nodes[to!]!.id, kind: 'execution' as const }))
  const graph: WorkflowDefinitionV3 = { ...base, nodes, edges, entryNodeId: nodes[0]!.id, approval: { handler: 'user' },
    executionPolicy: { maxParallelism: 4, maxNodeExecutions: 40 } }
  if (shape === 'conditional') graph.nodes[0]!.choice = { outcomes: edges.map((edge, i) => ({ outcome: i ? 'right' : 'left', target: { kind: 'edge', relationshipId: edge.id } })) }
  if (shape === 'repeat-ready') graph.nodes[1]!.choice = { outcomes: [
    { outcome: 'again', target: { kind: 'branch_end' } }, { outcome: 'done', target: { kind: 'branch_end' } },
  ] }
  if (shape === 'approval') graph.nodes[1]!.initialPrompt = 'Request the configured user approval before a sensitive operation.'
  return graph
}
function stageShape(key: string, shape: Shape, mock: Mock) {
  // Seed the local form through its public Zustand interaction boundary. Save,
  // reopen and Start below still traverse the real mounted controls and HTTP.
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => shapeGraph(graph, shape, mock)))
}
async function save(mock: Mock, user: ReturnType<typeof userEvent.setup>, expectedVersions: number) {
  await user.click(saveButton())
  await waitFor(() => expect(mock.versions.size === expectedVersions
    || !!screen.queryByRole('alertdialog', { name: 'Stop running work and save?' })).toBe(true))
  const dialog = screen.queryByRole('alertdialog', { name: 'Stop running work and save?' })
  if (dialog) await user.click(within(dialog).getByRole('button', { name: 'Stop runs and save' }))
  await waitFor(() => expect(mock.versions.size).toBe(expectedVersions))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument())
  const version = [...mock.versions.values()].at(-1)!
  expect(WorkflowVersionV3Schema.parse(version).executionSemanticsVersion).toBe(3)
  return version
}
async function start(mock: Mock, user: ReturnType<typeof userEvent.setup>, expectedRuns = 1) {
  const button = control('Start saved version')
  await waitFor(() => expect(button, button.title).toBeEnabled())
  await user.click(button)
  await waitFor(() => expect(mock.runs.size).toBe(expectedRuns))
  const run = [...mock.runs.values()].at(-1)!.run
  await waitFor(() => expect(readBoardStart(nextDraftKey(mock.workspaceId, run.workflowId))).toBeUndefined())
  await waitFor(() => expect(within(controls()).queryByRole('button', { name: 'Reconcile Start' })).not.toBeInTheDocument())
  return run
}

describe('ENG-S3-ONLY actual registered Board / shared current HTTP', () => {
  it.each<Shape>(['single', 'sequential', 'parallel', 'conditional', 'approval'])('S3-01..04: fresh %s Save/reopen/Start persists V3 without dummy repeat state', async (shape) => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), first = await mount(mock)
    const { id, key } = await create(mock, user)
    if (shape === 'single') {
      // Exercise real keyboard-accessible attach + entry controls from the empty Board.
      await user.click(control('Add agent to graph'))
      const add = within(screen.getByRole('complementary', { name: 'Add agent' }))
      await user.selectOptions(add.getByRole('combobox', { name: 'Existing agent' }), mock.agents[0]!.id)
      await user.click(add.getByRole('button', { name: 'Add to workflow' }))
      await user.click(control('Workflow settings'))
      const node = useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!
      const settings = within(screen.getByRole('complementary', { name: 'Workflow settings' }))
      await user.selectOptions(settings.getByRole('combobox', { name: 'Starts the workflow' }), node.id)
      await user.click(settings.getByRole('button', { name: 'Close panel' }))
    } else stageShape(key, shape, mock)
    const version = await save(mock, user, 1)
    expect(version.definition).not.toHaveProperty('repeat')
    expect(mock.controls.stopCalls).toBe(0)
    const href = first.router.state.location.href
    first.unmount(); first.query.clear()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    // Acknowledged form memory is lost. The retained snapshot may restore it,
    // but the remounted Board must still read the exact immutable saved pins.
    const beforeReopen = mock.calls.length
    const second = await mount(mock, href)
    await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => {
      const draft = useGraphDraftStore.getState().nextDrafts[key]?.context.draft
      expect(draft?.baseWorkflowVersionId).toBe(version.id)
      expect(draft?.publishedRevision).toBe(mock.managed(id).revision)
      expect(draft?.revision).toBe(draft?.publishedRevision)
    })
    const run = await start(mock, user)
    expect(mock.calls.slice(beforeReopen).some((call) => call.method === 'GET'
      && call.path.endsWith(`/versions/${version.id}`))).toBe(true)
    await waitFor(() => expect(second.router.state.location.search).toMatchObject({ workflowId: id, runId: run.id, workflowVersionId: version.id, executionSemanticsVersion: 3 }))
    const requests = mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).not.toHaveProperty('draftId')
    expect(requests[0]!.body).not.toHaveProperty('expectedDraftRevision')
    const request = RunStartV3InputSchema.parse(requests[0]!.body)
    expect(request.expectedAgentConfigurationVersionIds).toEqual(version.agentConfigurationVersionIds)
    expect(request.workflowVersionId).toBe(version.id); expect(request.expectedLocationRevision).toBe(1)
    expect(run).not.toHaveProperty('repeat'); expect(mock.currents.get(run.id)!.topology).not.toHaveProperty('repeat')
    expect(mock.currents.get(run.id)!.state.occurrences).toEqual([])
    expect(mock.currents.get(run.id)!.state.decisions).toEqual([])
    expect(mock.currents.get(run.id)!.state.bindings).toEqual([])
    expect(mock.calls.some((call) => /repeat.*update|convert|promote|\/graph$/.test(call.path))).toBe(false)
    expect(readBoardStart(key)).toBeUndefined()
  })
  it('S3-05: the same form adds and removes finite repeat as separate V3 versions, while past Runs retain exact pins', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), mounted = await mount(mock)
    const { id, key } = await create(mock, user); stageShape(key, 'repeat-ready', mock)
    const ordinary = await save(mock, user, 1), oldRun = await start(mock, user)
    mock.settle(oldRun.id)
    await mounted.query.invalidateQueries({ queryKey: queryKeys.workspaceDetails(mock.workspaceId) })
    await user.click(control('Repeats'))
    const repeat = screen.getByRole('region', { name: 'Repeat settings' })
    await user.click(within(repeat).getByRole('button', { name: 'Add repeat' }))
    const graph = useGraphDraftStore.getState().nextDrafts[key]!.graph
    for (const node of graph.nodes) await user.click(within(repeat).getByRole('checkbox', { name: node.name! }))
    await user.selectOptions(within(repeat).getByRole('combobox', { name: 'Entry node' }), graph.nodes[0]!.id)
    await user.selectOptions(within(repeat).getByRole('combobox', { name: 'Exit node' }), graph.nodes[1]!.id)
    await user.selectOptions(within(repeat).getByRole('combobox', { name: 'Repeat outcome' }), 'again')
    await user.selectOptions(within(repeat).getByRole('combobox', { name: 'Early-exit outcome' }), 'done')
    const repeated = await save(mock, user, 2)
    expect(repeated.definition.repeat?.blocks[0]).toMatchObject({ maxOccurrences: 2, repeatOutcome: 'again', earlyExitOutcome: 'done', limitExit: { kind: 'branch_end' } })
    const repeatRun = await start(mock, user, 2); mock.settle(repeatRun.id)
    await mounted.query.invalidateQueries({ queryKey: queryKeys.workspaceDetails(mock.workspaceId) })
    await user.click(within(repeat).getByRole('button', { name: 'Remove repeat' }))
    const removed = await save(mock, user, 3)
    expect(removed.definition).not.toHaveProperty('repeat'); expect(removed.id).not.toBe(ordinary.id)
    expect(mock.versions.get(repeated.id)!.definition.repeat?.blocks).toHaveLength(1)
    expect(mock.runs.get(oldRun.id)!.run.workflowVersionId).toBe(ordinary.id)
    expect(mock.runs.get(repeatRun.id)!.run.workflowVersionId).toBe(repeated.id)
    expect(mock.workflows.get(id)).not.toHaveProperty('repeat')
    // Current/past selection changes the URL, not the mounted local form.
    const editor = screen.getByRole('region', { name: 'Workflow authoring' })
    await user.click(control('Runs'))
    await user.click(await screen.findByRole('button', { name: new RegExp(`Open Run ${oldRun.id} ·`) }))
    await waitFor(() => expect(mounted.router.state.location.search.workflowVersionId).toBe(ordinary.id))
    expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBe(editor)
    await user.click(screen.getByRole('button', { name: 'Clear Run selection' }))
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).not.toHaveProperty('repeat')
  })
  it('keeps production capability false without issuing Start, and rejects retired saved tags before definition dispatch', async () => {
    const mock = newBoardMock(), user = userEvent.setup(), mounted = await mount(mock)
    const { key } = await create(mock, user); stageShape(key, 'single', mock); await save(mock, user, 1)
    expect(control('Start saved version')).toBeDisabled()
    expect(mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))).toEqual([])
    mounted.unmount(); mounted.query.clear(); act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    for (const tag of [1, 2, 99, undefined]) {
      const details = mock.details(), workflow = details.workflows[0]!
      server.use(http.get(`/api/workspaces/${mock.workspaceId}`, () => HttpResponse.json({ ...details, workflows: [{ ...workflow, executionSemanticsVersion: tag }] })))
      const before = mock.calls.filter((call) => /\/(?:definition|drafts)(?:\/|$)/.test(call.path)).length
      // Mount without replacing the denial override with the fixture handlers.
      const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(query)
      const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [`/workspaces/${mock.workspaceId}`] }) })
      const view = render(<QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider>)
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Workflow authoring' })).not.toBeInTheDocument())
      await waitFor(() => expect(query.getQueryState(queryKeys.workspaceDetails(mock.workspaceId))?.status).toBe('error'))
      expect(mock.calls.filter((call) => /\/(?:definition|drafts)(?:\/|$)/.test(call.path))).toHaveLength(before)
      view.unmount(); query.clear()
    }
  })
  it.each(['denied', 'stale', 'unsupported', 'lost'] as const)('Start %s is fail-closed; reload never fabricates a replacement command', async (mode) => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), mounted = await mount(mock)
    const { key } = await create(mock, user); stageShape(key, 'sequential', mock); await save(mock, user, 1)
    const button = control('Start saved version'); await waitFor(() => expect(button).toBeEnabled())
    // Deny in the service AFTER its allowed session/read display: authority is rechecked.
    if (mode === 'denied') mock.controls.deniedStart = true
    if (mode === 'stale') mock.controls.staleStart = true
    if (mode === 'unsupported') mock.controls.unsupportedStart = true
    if (mode === 'lost') mock.controls.loseStartReply = true
    await user.click(button)
    await waitFor(() => expect(mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))).toHaveLength(1))
    if (mode === 'unsupported') {
      await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]?.startRejectedVersionId).toBeDefined())
      expect(readBoardStart(key)).toBeUndefined()
      expect(mock.runs.size).toBe(0); expect(control('Start saved version')).toBeDisabled(); return
    }
    await waitFor(() => expect(readBoardStart(key)).toBeDefined())
    const retained = readBoardStart(key)!, href = mounted.router.state.location.href
    if (mode === 'denied' || mode === 'stale') expect(mock.runs.size).toBe(0)
    if (mode !== 'lost') return
    expect(mock.runs.size).toBe(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile Start' })).toBeEnabled())
    mounted.unmount(); mounted.query.clear()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} })); await mount(mock, href)
    const reconcile = await screen.findByRole('button', { name: 'Reconcile Start' })
    await waitFor(() => expect(reconcile).toBeEnabled())
    await user.click(reconcile)
    await waitFor(() => expect(readBoardStart(key)).toBeUndefined())
    const requests = mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))
    expect(requests.at(-1)!.body).toEqual(retained); expect(mock.runs.size).toBe(1)
  })
  it('Stop receipt replay is not cleanup proof; Discard does not Stop and layout does not publish', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), mounted = await mount(mock)
    const { key } = await create(mock, user); stageShape(key, 'single', mock); await save(mock, user, 1)
    const run = await start(mock, user), scope = mock.currents.get(run.id)!.scope
    await user.click(screen.getByRole('button', { name: 'Details' }))
    mock.controls.loseStopReply = true
    const stop = await screen.findByRole('button', { name: 'Stop this Run' })
    await waitFor(() => expect(stop).toBeEnabled()); await user.click(stop)
    await waitFor(() => expect(readBoardStop(scope)?.request).toBeDefined())
    const command = readBoardStop(scope)!.request
    await user.click(await screen.findByRole('button', { name: 'Reconcile Stop' }))
    await waitFor(() => expect(readBoardStop(scope)?.receipt?.status).toBe('accepted'))
    expect(mock.controls.stopCalls).toBe(1); expect(readBoardStop(scope)!.request).toEqual(command)
    expect(readBoardStop(scope)).toBeDefined(); expect(mock.runs.get(run.id)!.cleanupPending).toBe(true)
    mock.settle(run.id); await mounted.query.invalidateQueries()
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    await user.click(screen.getByRole('button', { name: 'Close runs' }))
    const node = useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, nodes: [{ ...node, initialPrompt: 'Unpublished change', position: { x: 300, y: -99 } }] })))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }))
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).toMatchObject({ position: { x: 300, y: -99 } })
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).not.toHaveProperty('initialPrompt')
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
    expect(mock.versions.size).toBe(1); expect(mock.controls.stopCalls).toBe(1)
  })
  it('stages before Stop confirmation even when the Board summary misses an active Run', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), mounted = await mount(mock)
    const { key, id } = await create(mock, user); stageShape(key, 'single', mock); await save(mock, user, 1)
    const run = await start(mock, user)
    const beforeEdit = mock.calls.length
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Next pinned instructions' })) })))
    // Only the summary lies. Stage still discovers the authoritative affected Run.
    server.use(http.get(`/api/workspaces/${mock.workspaceId}`, () => HttpResponse.json({ ...mock.details(), runs: [] })))
    act(() => { mounted.query.setQueryData(queryKeys.workspaceDetails(mock.workspaceId), { ...mock.details(), runs: [] }) })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const canceled = await screen.findByRole('alertdialog', { name: 'Stop running work and save?' })
    expect(canceled).toHaveTextContent('1 affected Run requires Stop or cleanup')
    await user.click(within(canceled).getByRole('button', { name: 'Keep it' }))
    expect(mock.record(id).intent?.state).toBe('staged')
    const retained = readEditOutbox(key)!
    expect(retained).toBeDefined()
    expect(mock.controls.stopCalls).toBe(0); expect(mock.versions.size).toBe(1)
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(true)
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!.initialPrompt).toBe('Next pinned instructions')
    expect(mock.calls.slice(beforeEdit).some((call) => call.method === 'PUT' && call.path.endsWith('/definition'))).toBe(false)
    const saveAgain = screen.getByRole('button', { name: 'Stop affected Runs and save' })
    await waitFor(() => expect(saveAgain).toBeEnabled())
    await user.click(saveAgain)
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop runs and save' }))
    await waitFor(() => expect(mock.record(id).intent?.state).toBe('waiting'))
    const stages = mock.calls.slice(beforeEdit).filter((call) => call.method === 'POST' && call.path.endsWith('/definition/edits')
      && (call.body as { action?: string }).action === 'stage_edits')
    expect(stages.length).toBeGreaterThan(0)
    // Reconciliation replays one exact Stage, always pinned to the saved revision.
    for (const stage of stages) expect(stage.body).toEqual(retained.request)
    expect(retained.request).toMatchObject({ expectedRevision: mock.managed(id).revision,
      expectedWorkflowVersionId: mock.managed(id).currentVersionId })
    expect(mock.controls.stopCalls).toBe(1); expect(mock.versions.size).toBe(1)
    mock.settle(run.id); await mounted.query.invalidateQueries()
    await waitFor(() => expect(mock.versions.size).toBe(2))
    expect(mock.runs.size).toBe(1); expect(mock.runs.get(run.id)!.run.executionState).toBe('completed')
    expect([...mock.versions.values()].at(-1)!.definition.nodes[0]!.initialPrompt).toBe('Next pinned instructions')
  })
})
