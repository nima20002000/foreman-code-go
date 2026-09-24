import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GraphEditIntentSchema, type GraphEditReadResult, type GraphEditStageInput } from '@graphql/contracts/wave25'
import { queryKeys } from '../../../shared/api/query'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'
import { nextDraftKey } from './state'
import { nextDraftApi } from './transport'
import { readEditOutbox } from './editIntentStorage'

async function confirmDiscard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Discard changes$/ }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }))
}

// Mounted React state/form tests with a mocked transport and canvas. These do
// not claim an authenticated browser, React Flow geometry or native Stop test.
vi.mock('./DraftCanvas', () => ({ DraftCanvas: ({ open, panels }: { open?: { nodeId: string; panel: 'chat' | 'settings' | 'info' }; panels?: (nodeId: string) => Record<string, unknown> }) => <div>Canvas fixture{open && panels
  ? <section role="dialog" aria-label={`${open.nodeId} ${open.panel}`}>{panels(open.nodeId)[open.panel] as never}</section> : null}</div> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
const empty: GraphEditReadResult = { intent: null, current: [], canStop: false, affectedSetChanged: false }
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
}
function changeMeaning() {
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: 'Retained exact instruction', position: { x: 802, y: -71 } }),
  })))
}
function staged(request: GraphEditStageInput): GraphEditReadResult {
  const context = fixture(), hash = 'sha256:' + '1'.repeat(64)
  const pins = ['run-one', 'run-two'].map((runId, index) => ({ workspaceId: 'workspace', workflowId: index ? 'shared-workflow' : 'workflow',
    runId, workflowVersionId: `accepted-${runId}`, executionSemanticsVersion: 2 as const, agentConfigurationVersionIds: { agent: 'accepted-configuration' } }))
  const graph = useGraphDraftStore.getState().nextDrafts[key]!.graph
  const intent = GraphEditIntentSchema.parse({ id: 'private-intent', ownerPrincipalId: 'principal',
    workspaceId: request.workspaceId, workflowId: request.workflowId, draftId: request.draftId,
    stageCommandId: request.commandId, stageInputHash: hash,
    advanceCommandId: 'exact-advance', advanceInputHash: hash, discardCommandId: 'exact-discard', discardInputHash: hash,
    expectedRevision: request.expectedRevision, expectedWorkflowVersionId: request.expectedWorkflowVersionId, savedWorkflowRevision: 1,
    stagedDraft: { ...context.draft, graph }, agentPins: [], affected: pins,
    stops: pins.map((pin) => ({ input: { workspaceId: pin.workspaceId, runId: pin.runId, commandId: `exact-stop-${pin.runId}` }, inputHash: hash })),
    saveInput: { workspaceId: 'workspace', workflowId: 'workflow', draftId: request.draftId,
      commandId: 'exact-save', expectedRevision: request.expectedRevision, executionSemanticsVersion: 2 },
    saveInputHash: hash, state: 'staged', saveAttempted: false, createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' })
  return { intent, canStop: true, affectedSetChanged: false, current: pins.map((pin) => ({ pin, terminal: false, settled: false,
    outcome: 'pending', cleanupPending: false, nativePending: true, interactionPending: true, reviewPending: false })) }
}
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); sessionStorage.clear()
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  vi.stubGlobal('navigator', { ...navigator, locks: { request: async (_name: string, work: () => Promise<unknown>) => work() } })
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(fixture())
  vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue(empty)
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it('shows both exact board actions; Discard does not Stop, publish, or erase independent layout', async () => {
  const stage = vi.spyOn(nextDraftApi, 'editStage'), advance = vi.spyOn(nextDraftApi, 'editAdvance'), start = vi.spyOn(nextDraftApi, 'start')
  const user = userEvent.setup(); mount(); changeMeaning()
  expect(screen.getByRole('button', { name: /^Save changes$/ })).toBeInTheDocument()
  await confirmDiscard(user)
  const edit = useGraphDraftStore.getState().nextDrafts[key]!
  expect(edit.graph.nodes[0]?.initialPrompt).toBeUndefined()
  expect(edit.graph.nodes[0]?.position).toEqual({ x: 802, y: -71 }); expect(edit.context.draft.revision).toBe(7)
  expect(stage).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
})
it('recovers a dropped Stage reply after full form-memory loss and retries the same payload, without Start', async () => {
  let persisted: GraphEditReadResult = empty
  vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
  const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
    if (!persisted.intent) { persisted = staged(input); throw new Error('Stage reply lost') }
    return persisted
  })
  const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => {
    persisted = { ...persisted, intent: { ...persisted.intent!, state: 'waiting' } }; return persisted
  })
  const start = vi.spyOn(nextDraftApi, 'start'), user = userEvent.setup(), first = mount()
  changeMeaning()
  await user.click(screen.getByRole('button', { name: /^Save changes$/ }))
  await waitFor(() => expect(stage).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByRole('button', { name: /^Save changes$/ })).toBeEnabled())
  const request = stage.mock.calls[0]![0]
  expect(readEditOutbox(key)?.request).toEqual(request)
  first.unmount()
  // Deliberate memory loss only; logout/clearAllDrafts would correctly purge the session.
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  mount()
  await user.click(await screen.findByRole('button', { name: /^Save changes$/ }))
  await waitFor(() => expect(advance).toHaveBeenCalledOnce())
  expect(stage.mock.calls[1]![0]).toEqual(request)
  expect(advance.mock.calls[0]![0]).toMatchObject({ intentId: 'private-intent', commandId: 'exact-advance', action: 'stop_and_save' })
  expect(useGraphDraftStore.getState().nextDrafts[key]?.graph.nodes[0]?.initialPrompt).toBe('Retained exact instruction')
  expect(screen.getByText(/another workflow/)).toBeInTheDocument()
  expect(start).not.toHaveBeenCalled()
})
it('duplicate clicks share one stage/advance; private Discard reconciles without another Stop', async () => {
  let persisted: GraphEditReadResult = empty
  vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
  const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => persisted.intent ? persisted : (persisted = staged(input)))
  let release!: (value: GraphEditReadResult) => void
  const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => new Promise((resolve) => { release = resolve }))
  const discard = vi.spyOn(nextDraftApi, 'editDiscard').mockImplementation(async () => (persisted = { ...persisted, intent: { ...persisted.intent!, state: 'discarded' } }))
  const user = userEvent.setup(); mount(); changeMeaning()
  await user.dblClick(screen.getByRole('button', { name: /^Save changes$/ }))
  await waitFor(() => expect(advance).toHaveBeenCalledOnce())
  expect(stage).toHaveBeenCalledOnce()
  await act(async () => { persisted = { ...persisted, intent: { ...persisted.intent!, state: 'waiting' } }; release(persisted) })
  await confirmDiscard(user)
  await waitFor(() => expect(discard).toHaveBeenCalledOnce())
  expect(discard.mock.calls[0]![0]).toMatchObject({ intentId: 'private-intent', commandId: 'exact-discard', action: 'discard_edits' })
  expect(advance).toHaveBeenCalledOnce()
  expect(useGraphDraftStore.getState().nextDrafts[key]?.graph.nodes[0]?.position).toEqual({ x: 802, y: -71 })
  expect(readEditOutbox(key)).toBeUndefined()
})
