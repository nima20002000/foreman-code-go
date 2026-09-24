import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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

// Form/registration tests. This is not React Flow or authenticated browser evidence.
vi.mock('./DraftCanvas', () => ({ DraftCanvas: () => <div>Canvas test placeholder</div> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
beforeEach(() => { useGraphDraftStore.getState().clearAllDrafts() })
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })

function readyClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  return client
}
function boardContext() {
  return { workspaceId: 'workspace', workflowId: 'workflow', inspection: {}, selectInspection: vi.fn(),
    selectRun: vi.fn(), conversionRequested: false, requestConversion: vi.fn(), closeConversion: vi.fn(), openLocation: vi.fn() }
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
  await user.click(screen.getByText('Select a board node or connection'))
  await user.click(screen.getByRole('button', { name: /Entry · Node 0/ }))
  await user.type(screen.getByLabelText('Node instruction'), 'Unsaved instruction')
  const registered = [...registrations.values()].find((item) => item.current.label.endsWith('next draft'))!
  expect(registered.current.dirty).toBe(true)
  await act(async () => { await registered.current.discard() })
  expect(screen.getByLabelText('Node instruction')).toHaveValue('')
  expect(registered.current.dirty).toBe(false)
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
it('journals one exact Start before HTTP and recovers it after in-memory remount', () => {
  const store = useGraphDraftStore.getState()
  const input = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'workflow-version-1',
    executionSemanticsVersion: 2 as const, draftId: 'draft', expectedDraftRevision: 7,
    expectedLocationRevision: 1, commandId: 'first-start', input: {} }
  expect(store.reserveRunStart(key, input)).toEqual(input)
  const storageKey = protectedKey('outbox', `next-draft-start:${key}`)
  expect(localStorage.getItem(storageKey)).toContain('first-start')
  useGraphDraftStore.setState({ pendingRunStarts: {} })
  useGraphDraftStore.getState().loadPendingRunStart(key)
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toEqual(input)
  expect(store.reserveRunStart(key, { ...input, commandId: 'replacement' })).toEqual(input)
  expect(() => store.acknowledgeRunStart(key, 'replacement')).toThrow()
  store.acknowledgeRunStart(key, input.commandId)
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toBeUndefined()
  expect(localStorage.getItem(storageKey)).toBeNull()
  store.reserveRunStart(key, { ...input, commandId: 'later-start' })
  store.clearAllDrafts()
  expect(localStorage.getItem(storageKey)).toBeNull()
})
it('fails closed when the durable pending Start record is unreadable', () => {
  const storageKey = protectedKey('outbox', `next-draft-start:${key}`)
  localStorage.setItem(storageKey, '{invalid')
  const input = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'workflow-version-1',
    executionSemanticsVersion: 2 as const, draftId: 'draft', expectedDraftRevision: 7,
    expectedLocationRevision: 1, commandId: 'replacement', input: {} }
  expect(() => useGraphDraftStore.getState().reserveRunStart(key, input)).toThrow('pending Start record is invalid')
  expect(localStorage.getItem(storageKey)).toBe('{invalid')
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
  await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
  await user.click(screen.getByRole('button', { name: 'Reload shared draft' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile Start' })).toBeEnabled())
  expect(useGraphDraftStore.getState().pendingRunStarts[key]).toEqual(request)
  first.unmount()
  useGraphDraftStore.setState({ pendingRunStarts: {} })
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  await user.click(await screen.findByRole('button', { name: 'Reconcile Start' }))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  expect(start.mock.calls[1]![0]).toEqual(request)
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
  await user.click(screen.getByText('Current and past Runs'))
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
