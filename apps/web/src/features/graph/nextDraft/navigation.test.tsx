import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UnsavedChangesContext, type EditorRegistration } from '../../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../store'
import { nextDraftKey } from './state'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'
import { nextDraftApi } from './transport'
import { queryKeys } from '../../../shared/api/query'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { makeWave25Fixture } from '@graphql/contracts/wave25'
import { WorkflowBoardContext } from '../../workflow-board/context'
import { RunActivityPanel } from '../../workflow-board/RunActivityPanel'
import { ApiError } from '../../../shared/api/client'

async function confirmDiscard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Discard changes$/ }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }))
}
async function reloadSavedDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Reload saved draft' }))
  const dialog = screen.queryByRole('alertdialog')
  if (dialog) await user.click(within(dialog).getByRole('button', { name: 'Reload saved draft' }))
}

// Form/registration tests. This is not React Flow or authenticated browser evidence.
vi.mock('./DraftCanvas', () => ({ DraftCanvas: ({ open, panels }: { open?: { nodeId: string; panel: 'chat' | 'settings' | 'info' }; panels?: (nodeId: string) => Record<string, unknown> }) => <div>Canvas fixture{open && panels
  ? <section role="dialog" aria-label={`${open.nodeId} ${open.panel}`}>{panels(open.nodeId)[open.panel] as never}</section> : null}</div> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, work: () => unknown) => {
    const result = (queues.get(name) ?? Promise.resolve()).then(work)
    queues.set(name, result.catch(() => undefined))
    return result
  } } })
})
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })

function readyClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  return client
}
function boardContext() {
  return { workspaceId: 'workspace', workflowId: 'workflow', inspection: {}, selectInspection: vi.fn(),
    selectRun: vi.fn(), conversionRequested: false, requestConversion: vi.fn(), closeConversion: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn(), activeRuns: 0 }
}
it('registers local form dirtiness and discard with the existing navigation guard', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const registrations = new Map<string, EditorRegistration>()
  const guard = { changed: vi.fn(), surfaces: async () => true, request: async () => true,
    register: (id: string, editor: EditorRegistration) => { registrations.set(id, editor); return () => { registrations.delete(id) } } }
  const user = userEvent.setup(), client = readyClient()
  render(<QueryClientProvider client={client}><UnsavedChangesContext.Provider value={guard}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </UnsavedChangesContext.Provider></QueryClientProvider>)
    await user.click(screen.getByRole('button', { name: /Entry · Node 0/ }))
  const panel = await screen.findByRole('dialog', { name: /settings$/ })
  const name = within(panel).getByRole('textbox', { name: 'Name' }), original = (name as HTMLInputElement).value
  await user.clear(name); await user.type(name, 'Unsaved name')
  await user.click(within(panel).getByRole('button', { name: 'Save agent settings' }))
  const registered = [...registrations.values()].find((item) => item.current.label.endsWith('next draft'))!
  expect(registered.current.dirty).toBe(true)
  await act(async () => { await registered.current.discard() })
  expect(within(screen.getByRole('dialog', { name: /settings$/ })).getByRole('textbox', { name: 'Name' })).toHaveValue(original)
  expect(registered.current.dirty).toBe(false)
})
it('discarding a semantic edit preserves independent node layout', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const client = readyClient(), user = userEvent.setup()
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  const position = { x: 615, y: -90 }
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, position, initialPrompt: 'Unpublished instruction' } : node),
  })))
  await confirmDiscard(user)
  const draft = useGraphDraftStore.getState().nextDrafts[key]!
  expect(draft.graph.nodes[0]?.initialPrompt).toBeUndefined()
  expect(draft.graph.nodes[0]?.position).toEqual(position)
  expect(draft.context.draft.revision).toBe(7)
})
it('clearing the application session also purges next drafts and pending conversions', () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  useGraphDraftStore.getState().setNextDraftPromotion(key, { busy: false, request: { kind: 'apply', executionSemanticsVersion: 2,
    expectedRevision: 7, workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', commandId: 'pending-conversion', operations: [] } })
  useGraphDraftStore.getState().clearAllDrafts()
  expect(useGraphDraftStore.getState().nextDrafts).toEqual({})
  expect(useGraphDraftStore.getState().nextDraftPromotions).toEqual({})
})
it('a remount cannot hide an ambiguous promotion just because the server already returns v2', async () => {
  useGraphDraftStore.getState().setNextDraftPromotion(key, { busy: false, error: { code: 'NETWORK_ERROR', message: 'Unknown result', uncertain: true },
    request: { kind: 'apply', executionSemanticsVersion: 2, expectedRevision: 6, workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', commandId: 'pending-conversion', operations: [{ type: 'nodes.reorder', nodeIds: ['node-0', 'node-1'] }] } })
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(fixture())
  render(<NextDraftEditor workspaceId="workspace" workflowId="workflow" />)
  expect(await screen.findByRole('button', { name: 'Reconcile conversion' })).toBeInTheDocument()
  expect(useGraphDraftStore.getState().nextDrafts[key]).toBeUndefined()
})
it('journals one exact Start before HTTP and recovers it after in-memory remount', async () => {
  const store = useGraphDraftStore.getState()
  const input = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'workflow-version-1',
    executionSemanticsVersion: 2 as const, draftId: 'draft', expectedDraftRevision: 7,
    expectedLocationRevision: 1, commandId: 'first-start', input: {} }
  expect(await store.reserveRunStart(key, input)).toEqual(input)
  const storageKey = protectedKey('outbox', `next-draft-start:${key}`)
  expect(localStorage.getItem(storageKey)).toContain('first-start')
  useGraphDraftStore.setState({ pendingRunStarts: {} })
  useGraphDraftStore.getState().loadPendingRunStart(key)
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toEqual(input)
  expect(await store.reserveRunStart(key, { ...input, commandId: 'replacement' })).toEqual(input)
  await expect(store.acknowledgeRunStart(key, 'replacement')).rejects.toThrow()
  await store.acknowledgeRunStart(key, input.commandId)
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toBeUndefined()
  expect(localStorage.getItem(storageKey)).toBeNull()
  await store.reserveRunStart(key, { ...input, commandId: 'later-start' })
  store.clearAllDrafts()
  expect(localStorage.getItem(storageKey)).toBeNull()
})
it('fails closed when the durable pending Start record is unreadable', async () => {
  const storageKey = protectedKey('outbox', `next-draft-start:${key}`)
  localStorage.setItem(storageKey, '{invalid')
  const input = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'workflow-version-1',
    executionSemanticsVersion: 2 as const, draftId: 'draft', expectedDraftRevision: 7,
    expectedLocationRevision: 1, commandId: 'replacement', input: {} }
  await expect(useGraphDraftStore.getState().reserveRunStart(key, input)).rejects.toThrow('pending Start record is invalid')
  expect(localStorage.getItem(storageKey)).toBe('{invalid')
})
it('keeps an uncertain Start and refuses to clear a different exact command', async () => {
  const store = useGraphDraftStore.getState()
  const request = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'workflow-version-1',
    executionSemanticsVersion: 2 as const, draftId: 'draft', expectedDraftRevision: 7,
    expectedLocationRevision: 1, commandId: 'retained-start', input: {} }
  await store.reserveRunStart(key, request)
  expect(await store.rejectRunStart(key, request, new Error('Connection lost'))).toBe(false)
  expect(await store.rejectRunStart(key, request, new ApiError({ code: 'WORKFLOW_VERSION_UNSUPPORTED', message: 'Server failure' }, 500))).toBe(false)
  expect(await store.rejectRunStart(key, request, new ApiError({ code: 'INVALID_RESPONSE', message: 'Invalid result' }))).toBe(false)
  await expect(store.rejectRunStart(key, { ...request, commandId: 'different' }, new ApiError({
    code: 'WORKFLOW_VERSION_UNSUPPORTED', message: 'Rejected' }, 409))).rejects.toThrow('not cleared')
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toEqual(request)
  expect(localStorage.getItem(protectedKey('outbox', `next-draft-start:${key}`))).toContain(request.commandId)
})
it('serializes a late rejection after another tab has reserved a newer command', async () => {
  const store = useGraphDraftStore.getState()
  const first = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'workflow-version-1',
    executionSemanticsVersion: 2 as const, draftId: 'draft', expectedDraftRevision: 7,
    expectedLocationRevision: 1, commandId: 'first-start', input: {} }
  const later = { ...first, commandId: 'later-start', workflowVersionId: 'workflow-version-2' }
  await store.reserveRunStart(key, first)
  const acknowledge = store.acknowledgeRunStart(key, first.commandId)
  const reserve = store.reserveRunStart(key, later)
  const reject = store.rejectRunStart(key, first, new ApiError({ code: 'WORKFLOW_VERSION_UNSUPPORTED', message: 'Rejected' }, 409))
  await acknowledge
  expect(await reserve).toEqual(later)
  await expect(reject).rejects.toThrow('not cleared')
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toEqual(later)
  expect(localStorage.getItem(protectedKey('outbox', `next-draft-start:${key}`))).toContain(later.commandId)
})
it('reconciles the same uncertain Start after draft reload and editor remount', async () => {
  const context = fixture()
  useGraphDraftStore.getState().installNextDraft(key, context)
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(context)
  const start = vi.spyOn(nextDraftApi, 'start').mockRejectedValue(new Error('Response lost'))
  const client = readyClient(), user = userEvent.setup()
  const first = render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: 'Start saved version' }))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  const request = start.mock.calls[0]![0]
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toEqual(request)
  expect(useGraphDraftStore.getState().nextDrafts[key]?.startRejectedVersionId).toBeUndefined()
  await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
  await reloadSavedDraft(user)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile Start' })).toBeEnabled())
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toEqual(request)
  first.unmount()
  useGraphDraftStore.setState({ pendingRunStarts: {} })
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  await user.click(await screen.findByRole('button', { name: 'Reconcile Start' }))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  expect(start.mock.calls[1]![0]).toEqual(request)
})
it('releases only a rejected Start and requires confirmed reload before a fresh version command', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const fresh = fixture()
  fresh.draft.revision = 8
  fresh.draft.publishedRevision = 8
  fresh.draft.baseWorkflowVersionId = 'workflow-version-2'
  vi.spyOn(nextDraftApi, 'context').mockResolvedValueOnce(fixture()).mockResolvedValue(fresh)
  const start = vi.spyOn(nextDraftApi, 'start').mockRejectedValueOnce(new ApiError({
    code: 'WORKFLOW_VERSION_UNSUPPORTED', message: 'Saved version is stale.' }, 409))
    .mockImplementation(async (request) => ({ accepted: true, replayed: false, run: {
      ...makeWave25Fixture('fresh-start').run, workspaceId: 'workspace', workflowId: 'workflow',
      workflowVersionId: request.workflowVersionId } }))
  const client = readyClient(), user = userEvent.setup()
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: 'Start saved version' }))
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]?.startRejectedVersionId).toBe('workflow-version-1'))
  const rejected = start.mock.calls[0]![0]
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toBeUndefined()
  expect(localStorage.getItem(protectedKey('outbox', `next-draft-start:${key}`))).toBeNull()
  expect(screen.getByRole('button', { name: 'Start saved version' })).toBeDisabled()
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, name: 'Unsaved local name' })))
  await user.click(screen.getByRole('button', { name: 'Reload saved draft' }))
  expect(start).toHaveBeenCalledTimes(1)
  expect(useGraphDraftStore.getState().nextDrafts[key]?.graph.name).toBe('Unsaved local name')
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reload saved draft' }))
  await waitFor(() => expect(screen.getByText(/still points to the rejected version/)).toBeInTheDocument())
  expect(useGraphDraftStore.getState().nextDrafts[key]?.startRejectedVersionId).toBe('workflow-version-1')
  expect(useGraphDraftStore.getState().nextDrafts[key]?.graph.name).toBe('Unsaved local name')
  await user.click(screen.getByRole('button', { name: 'Reload saved draft' }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reload saved draft' }))
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]?.context.draft.baseWorkflowVersionId).toBe('workflow-version-2'))
  expect(useGraphDraftStore.getState().nextDrafts[key]?.startRejectedVersionId).toBeUndefined()
  await user.click(screen.getByRole('button', { name: 'Start saved version' }))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  expect(start.mock.calls[1]![0]).toMatchObject({ workflowVersionId: 'workflow-version-2', expectedDraftRevision: 8 })
  expect(start.mock.calls[1]![0].commandId).not.toBe(rejected.commandId)
})
it('allows a new Start after a local save advances beyond the rejected version', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const start = vi.spyOn(nextDraftApi, 'start').mockRejectedValueOnce(new ApiError({
    code: 'WORKFLOW_VERSION_UNSUPPORTED', message: 'Saved version is stale.' }, 409))
    .mockImplementation(async (request) => ({ accepted: true, replayed: false, run: {
      ...makeWave25Fixture('saved-again').run, workspaceId: 'workspace', workflowId: 'workflow',
      workflowVersionId: request.workflowVersionId } }))
  const client = readyClient(), user = userEvent.setup()
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: 'Start saved version' }))
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]?.startRejectedVersionId).toBe('workflow-version-1'))
  const saved = fixture()
  saved.draft.revision = 8
  saved.draft.publishedRevision = 8
  saved.draft.baseWorkflowVersionId = 'workflow-version-3'
  act(() => useGraphDraftStore.getState().updateNextDraft(key, (edit) => ({ ...edit, context: saved, graph: saved.draft.graph })))
  expect(screen.queryByText(/previous Start was rejected/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Start saved version' }))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  expect(start.mock.calls[1]![0]).toMatchObject({ workflowVersionId: 'workflow-version-3', expectedDraftRevision: 8 })
})
it('duplicate Start clicks share one pending command and one accepted Run', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  let resolve!: (value: Awaited<ReturnType<typeof nextDraftApi.start>>) => void
  const start = vi.spyOn(nextDraftApi, 'start').mockReturnValue(new Promise((done) => { resolve = done }))
  const client = readyClient(), user = userEvent.setup()
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  const button = screen.getByRole('button', { name: 'Start saved version' })
  await user.dblClick(button)
  await waitFor(() => expect(start).toHaveBeenCalledOnce())
  const request = start.mock.calls[0]![0]
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toEqual(request)
  expect(localStorage.getItem(protectedKey('outbox', `next-draft-start:${key}`))).toContain(request.commandId)
  await act(async () => resolve({ accepted: true, replayed: false, run: { ...makeWave25Fixture('duplicate-start').run,
    workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: request.workflowVersionId } }))
  expect(start).toHaveBeenCalledOnce()
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toBeUndefined()
})
it('pages through persisted Runs on the board and retains the older Run pin', async () => {
  const sample = makeWave25Fixture('pages').run
  const first = { ...sample, id: 'run-first', workspaceId: 'workspace', workflowId: 'workflow' }
  const older = { ...sample, id: 'run-older', workspaceId: 'workspace', workflowId: 'workflow' }
  vi.spyOn(nextDraftApi, 'runs').mockImplementation(async (_workspace, _workflow, cursor) => cursor
    ? { items: [older], pageInfo: { nextCursor: null } }
    : { items: [first], pageInfo: { nextCursor: 'run-first' } })
  const client = readyClient(), user = userEvent.setup(), board = boardContext()
  render(<QueryClientProvider client={client}><WorkflowBoardContext.Provider value={board}>
    <RunActivityPanel summaries={[]} />
  </WorkflowBoardContext.Provider></QueryClientProvider>)
  expect(await screen.findByRole('button', { name: /Open Run run-first/ })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Load more Runs' }))
  await user.click(await screen.findByRole('button', { name: /Open Run run-older/ }))
  expect(board.selectRun).toHaveBeenCalledWith({ workspaceId: 'workspace', workflowId: 'workflow', runId: older.id,
    workflowVersionId: older.workflowVersionId, executionSemanticsVersion: 2 })
})
it('a delayed accepted Start selects its exact version without erasing edits made in flight', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const instance = useGraphDraftStore.getState().nextDrafts[key]!.instanceId
  let resolve!: (value: Awaited<ReturnType<typeof nextDraftApi.start>>) => void
  const start = vi.spyOn(nextDraftApi, 'start').mockReturnValue(new Promise((done) => { resolve = done }))
  const board = boardContext(), user = userEvent.setup(), client = readyClient()
  render(<QueryClientProvider client={client}><WorkflowBoardContext.Provider value={board}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </WorkflowBoardContext.Provider></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: 'Start saved version' }))
  await waitFor(() => expect(start).toHaveBeenCalledOnce())
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Next Run only' })),
  })))
  await act(async () => resolve({ accepted: true, replayed: false, run: { ...makeWave25Fixture('start').run,
    workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'workflow-version-1' } }))
  expect(board.selectRun).toHaveBeenCalledWith(expect.objectContaining({ workflowVersionId: 'workflow-version-1' }))
  expect(useGraphDraftStore.getState().nextDrafts[key]?.instanceId).toBe(instance)
  expect(useGraphDraftStore.getState().nextDrafts[key]?.graph.nodes[0]?.initialPrompt).toBe('Next Run only')
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toBeUndefined()
})
it('a completed Start cannot navigate from an editor that has since unmounted', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  let resolve!: (value: Awaited<ReturnType<typeof nextDraftApi.start>>) => void
  vi.spyOn(nextDraftApi, 'start').mockReturnValue(new Promise((done) => { resolve = done }))
  const board = boardContext(), user = userEvent.setup(), client = readyClient()
  const page = render(<QueryClientProvider client={client}><WorkflowBoardContext.Provider value={board}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </WorkflowBoardContext.Provider></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: 'Start saved version' }))
  page.unmount()
  await act(async () => resolve({ accepted: true, replayed: false, run: { ...makeWave25Fixture('late').run,
    workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'workflow-version-1' } }))
  expect(board.selectRun).not.toHaveBeenCalled()
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toBeUndefined()
})
