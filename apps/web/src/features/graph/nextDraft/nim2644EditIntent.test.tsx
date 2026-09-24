import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GraphEditIntentSchema, GraphEditReadResultSchema, sameExecutableWorkflow,
  type GraphEditReadResult, type GraphEditStageInput } from '@graphql/contracts/wave25'
import { ApiError } from '../../../shared/api/client'
import { queryKeys } from '../../../shared/api/query'
import { useGraphDraftStore } from '../store'
import { NextDraftEditor } from './NextDraftEditor'
import { nextDraftApi } from './transport'
import { nextDraftDirty, nextDraftKey } from './state'
import { changeDraftAgent, editorAgents } from './agentEdits'
import { removeNode } from './model'
import { readEditOutbox, readEditSnapshot } from './editIntentStorage'
import { repairFixture } from './nim2644State.cases'

// Mounted Query/Zustand/form regressions with the existing transport boundary
// mocked. Not authenticated HTTP/MCP, a real browser/canvas, or native Stop evidence.
vi.mock('./DraftCanvas', () => ({ DraftCanvas: () => <div>Canvas fixture</div> }))
vi.mock('../../../shared/api/query', async (original) => {
  const { DEFAULT_HARNESS_DEFAULTS } = await import('@graphql/contracts')
  return { ...await original<typeof import('../../../shared/api/query')>(),
    useInteractionsQuery: () => ({ data: { items: [] } }),
    useAgentDefaultsQuery: () => ({ isError: false, data: { value: {
      coder: { harness: DEFAULT_HARNESS_DEFAULTS.codex }, orchestrator: { harness: DEFAULT_HARNESS_DEFAULTS.codex },
    } } }),
  }
})
const key = nextDraftKey('workspace', 'workflow'), clients: QueryClient[] = []
const empty: GraphEditReadResult = { intent: null, current: [], canStop: false, affectedSetChanged: false }
const hash = 'sha256:' + '1'.repeat(64), now = '2026-09-24T00:00:00Z'
const edit = () => useGraphDraftStore.getState().nextDrafts[key]!
const saveButton = () => screen.getByRole('button', { name: /^Stop current Run and save edits$/ })
const startButton = () => screen.getByRole('button', { name: 'Start saved version' })
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: now } })
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
}
function typeMeaning(value = 'submitted instruction') {
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: value }),
  })))
}
function moveSurvivor() {
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node) => node.id !== 'node-0' ? node : { ...node, position: { x: 934, y: -28 } }),
  })))
}
function reopen(first: ReturnType<typeof mount>) {
  first.unmount()
  // Lose form memory, not the principal's durable protected storage.
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  return mount()
}
function stageValue(request: GraphEditStageInput): GraphEditReadResult {
  const retained = readEditOutbox(key)!, context = edit().context
  expect(retained.request).toEqual(request)
  const pin = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run-fixture',
    workflowVersionId: 'version-1', executionSemanticsVersion: 2 as const,
    agentConfigurationVersionIds: { 'agent-0': 'configuration-agent-0' } }
  const intent = GraphEditIntentSchema.parse({ id: `private-${request.commandId}`, ownerPrincipalId: 'fixture',
    workspaceId: request.workspaceId, workflowId: request.workflowId, draftId: request.draftId,
    stageCommandId: request.commandId, stageInputHash: hash,
    advanceCommandId: `advance-${request.commandId}`, advanceInputHash: hash,
    discardCommandId: `discard-${request.commandId}`, discardInputHash: hash,
    expectedRevision: request.expectedRevision, expectedWorkflowVersionId: request.expectedWorkflowVersionId, savedWorkflowRevision: 1,
    stagedDraft: { ...context.draft, graph: retained.target,
      stagedAgents: Object.values(retained.agentTarget ?? {}).map((agent) => ({
        agent: { ...agent, prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [] },
        baseRevision: context.agents.find((item) => item.agent.id === agent.id)?.metadataRevision ?? null,
      })) },
    agentPins: [], affected: [pin], stops: [{ input: { workspaceId: 'workspace', runId: pin.runId, commandId: 'exact-stop-fixture' }, inputHash: hash }],
    saveInput: { workspaceId: 'workspace', workflowId: 'workflow', draftId: request.draftId, commandId: 'exact-save-fixture',
      expectedRevision: request.expectedRevision, executionSemanticsVersion: 2 }, saveInputHash: hash,
    state: 'staged', saveAttempted: false, createdAt: now, updatedAt: now })
  return GraphEditReadResultSchema.parse({ intent, canStop: true, affectedSetChanged: false,
    current: [{ pin, terminal: false, settled: false, outcome: 'pending', cleanupPending: false,
      nativePending: true, interactionPending: false, reviewPending: false }] })
}
function published(value: GraphEditReadResult): GraphEditReadResult {
  const intent = value.intent!, graph = { ...intent.stagedDraft.graph, version: 2 }
  const agents = new Map(edit().context.agents.map((item) => [item.agent.id, item]))
  for (const { agent, baseRevision } of intent.stagedDraft.stagedAgents) agents.set(agent.id, {
    metadataRevision: (baseRevision ?? 0) + 1,
    agent: { ...agent, configurationVersionId: `configuration-${agent.id}-saved`, createdAt: now, updatedAt: now },
  })
  const revision = intent.expectedRevision + 1, versionId = 'version-2'
  return GraphEditReadResultSchema.parse({ ...value,
    current: value.current.map((item) => ({ ...item, terminal: true, settled: true, outcome: 'canceled', nativePending: false })),
    intent: { ...intent, state: 'saved', saveAttempted: true,
      result: { draft: { ...intent.stagedDraft, graph, revision, publishedRevision: revision,
        baseWorkflowVersionId: versionId, stagedAgents: [], sourceAgentPins: [] },
      agents: [...agents.values()],
      version: { id: versionId, workspaceId: 'workspace', workflowId: 'workflow', version: 2, executionSemanticsVersion: 2,
        definition: graph, entryNodeId: graph.entryNodeId, approval: graph.approval,
        agentConfigurationVersionIds: Object.fromEntries(graph.nodes.map((node) => [node.agentId, agents.get(node.agentId)!.agent.configurationVersionId])),
        contentHash: hash, createdAt: now } } } })
}
function waiting(value: GraphEditReadResult): GraphEditReadResult {
  return { ...value, intent: { ...value.intent!, state: 'waiting' } }
}
async function createWorker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Add agent to graph' }))
  await user.click(screen.getByRole('button', { name: 'Worker' }))
  const node = edit().graph.nodes.find((item) => item.agentId !== 'agent-0')!
  expect(edit().agentEdits?.[node.agentId]?.configurationVersionId).toBeUndefined()
  expect(edit().agentEdits?.[node.agentId]?.prompt).toBeUndefined()
  expect(edit().agentEdits?.[node.agentId]?.assignedSkills).toBeUndefined()
  return node
}
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); sessionStorage.clear()
  useGraphDraftStore.getState().installNextDraft(key, repairFixture(1))
  vi.stubGlobal('navigator', { ...navigator, locks: { request: async (_name: string, work: () => Promise<unknown>) => work() } })
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(repairFixture(1))
  vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue(empty)
  vi.spyOn(nextDraftApi, 'start').mockRejectedValue(new Error('These regressions must not start a Run'))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('NIM-2644 mounted frontend recovery through the real edit-intent hook', () => {
  it('FE-001 retains a rejected form, unlocks it, and lets the next Discard finish without Stage replay or Stop', async () => {
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockRejectedValue(new ApiError({ code: 'REVISION_CONFLICT', message: 'Rejected before insert' }, 409))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance'), user = userEvent.setup()
    mount(); typeMeaning(); await user.click(saveButton())
    await waitFor(() => expect(stage).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText(/The local form is retained. Correct it/)).toBeInTheDocument())
    expect(readEditOutbox(key)).toBeUndefined(); expect(edit().graph.nodes[0]?.initialPrompt).toBe('submitted instruction')
    expect(readEditSnapshot(key)?.graph.nodes[0]?.initialPrompt).toBe('submitted instruction')
    expect(startButton()).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /^Discard changes$/ }))
    expect(edit().graph.nodes[0]?.initialPrompt).toBeUndefined()
    expect(stage).toHaveBeenCalledOnce(); expect(advance).not.toHaveBeenCalled(); expect(nextDraftApi.start).not.toHaveBeenCalled()
    await waitFor(() => expect(startButton()).toBeEnabled())
  })
  it('FE-001 reopens a safely rejected form and permits explicit reload/correction with a new Stage identity', async () => {
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockRejectedValueOnce(new ApiError({ code: 'REVISION_CONFLICT', message: 'Rejected before insert' }, 409))
      .mockImplementation(async (input) => stageValue(input))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => waiting(stageValue(stage.mock.calls.at(-1)![0])))
    const user = userEvent.setup(), first = mount(); typeMeaning(); await user.click(saveButton())
    await waitFor(() => expect(stage).toHaveBeenCalledOnce())
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    reopen(first)
    await screen.findByRole('region', { name: 'Workflow authoring' })
    expect(edit().graph.nodes[0]?.initialPrompt).toBe('submitted instruction')
    const fresh = repairFixture(1); fresh.draft.revision = 8; fresh.draft.publishedRevision = 8
    vi.mocked(nextDraftApi.context).mockResolvedValue(fresh); vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
    await user.click(screen.getByRole('button', { name: 'Reload shared draft' }))
    await waitFor(() => expect(edit().context.draft.revision).toBe(8))
    typeMeaning('corrected'); await user.click(saveButton())
    await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    expect(stage).toHaveBeenCalledTimes(2)
    expect(stage.mock.calls[1]![0].commandId).not.toBe(stage.mock.calls[0]![0].commandId)
    expect(stage.mock.calls[1]![0].expectedRevision).toBe(8)
    expect(nextDraftApi.start).not.toHaveBeenCalled()
  })
  it.each([new Error('reply lost'), new ApiError({ code: 'INVALID_RESPONSE', message: 'bad reply' }),
    new ApiError({ code: 'FORBIDDEN', message: 'readback denied' }, 403), new ApiError({ code: 'INTERNAL_ERROR', message: 'post-commit failure' }, 500)])(
    'FE-001 preserves exact Stage identity across ambiguous response/reopen %#', async (error) => {
      let persisted = empty
      vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
      const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
        if (!persisted.intent) { persisted = stageValue(input); throw error }
        return persisted
      })
      const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => (persisted = waiting(persisted)))
      const user = userEvent.setup(), first = mount(); typeMeaning(); await user.click(saveButton())
      await waitFor(() => expect(stage).toHaveBeenCalledOnce())
      await waitFor(() => expect(saveButton()).toBeEnabled())
      const request = stage.mock.calls[0]![0]
      expect(readEditOutbox(key)?.request).toEqual(request)
      reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
      await user.click(saveButton()); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
      expect(stage.mock.calls[1]![0]).toEqual(request)
      expect(readEditOutbox(key)?.request).toEqual(request); expect(nextDraftApi.start).not.toHaveBeenCalled()
    })
  it('FE-001 a REVISION_CONFLICT from Advance is not a rejected Stage and cannot release its reservation', async () => {
    let persisted = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
    vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockRejectedValue(new ApiError({ code: 'REVISION_CONFLICT', message: 'After Stage' }, 409))
    const user = userEvent.setup(); mount(); typeMeaning(); await user.click(saveButton())
    await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(readEditOutbox(key)?.request.commandId).toBe(persisted.intent?.stageCommandId)
    expect(startButton()).toBeDisabled(); expect(edit().graph.nodes[0]?.initialPrompt).toBe('submitted instruction')
  })
  it('FE-002/004 creates a Worker, replaces the sole entry, selects it explicitly, and acknowledges normalized Stop/save publication', async () => {
    let persisted = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => (persisted = published(persisted)))
    const user = userEvent.setup(), first = mount(), node = await createWorker(user)
    await user.click(screen.getByText('Select a board node or connection'))
    await user.click(screen.getByRole('button', { name: 'Entry · Node 0' }))
    await user.click(screen.getByRole('button', { name: 'Remove node' }))
    expect(edit().graph.entryNodeId).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
    const option = screen.getByRole('option', { name: 'Worker 2 · Worker' })
    expect(option).toBeEnabled()
    expect(screen.getByText(/Local Agent roles are pending server validation/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Entry node' }), node.id)
    expect(edit().graph.entryNodeId).toBe(node.id); expect(startButton()).toBeDisabled()
    await user.click(saveButton()); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    await waitFor(() => expect(startButton()).toBeEnabled())
    const request = stage.mock.calls[0]![0]
    expect(request.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.add', agentId: node.agentId, productRole: 'coder' }),
      expect.objectContaining({ type: 'agent.configure', agentId: node.agentId, prompt: {}, assignedSkills: [] }),
      { type: 'node.remove', nodeId: 'node-0' }, { type: 'workflow.set_entry', entryNodeId: node.id },
    ]))
    expect(advance.mock.calls[0]![0]).toMatchObject({ action: 'stop_and_save', commandId: persisted.intent!.advanceCommandId })
    expect(nextDraftDirty(edit())).toBe(false); expect(edit().agentEdits?.[node.agentId]).toBeUndefined()
    expect(editorAgents(edit()).find((agent) => agent.id === node.agentId)).toMatchObject({
      configurationVersionId: `configuration-${node.agentId}-saved`, prompt: {}, assignedSkills: [],
    })
    expect(readEditOutbox(key)).toBeUndefined(); expect(nextDraftApi.start).not.toHaveBeenCalled()
    reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(startButton()).toBeEnabled())
    expect(nextDraftDirty(edit())).toBe(false); expect(edit().context.draft.baseWorkflowVersionId).toBe('version-2')
  })
  it('FE-002 a lost publication reply is acknowledged from readback using the retained raw new-Agent snapshot', async () => {
    let persisted = empty, visible = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => visible)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (visible = persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => { persisted = published(persisted); throw new Error('publication reply lost') })
    const user = userEvent.setup(), first = mount(), node = await createWorker(user)
    await user.click(saveButton()); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(readEditOutbox(key)?.agentTarget?.[node.agentId]?.prompt).toBeUndefined()
    expect(readEditOutbox(key)).toBeDefined()
    visible = persisted; reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    await waitFor(() => expect(startButton()).toBeEnabled())
    expect(nextDraftDirty(edit())).toBe(false); expect(edit().agentEdits?.[node.agentId]).toBeUndefined()
    expect(edit().context.agents.find((item) => item.agent.id === node.agentId)?.metadataRevision).toBe(1)
    expect(stage).toHaveBeenCalledOnce(); expect(advance).toHaveBeenCalledOnce(); expect(nextDraftApi.start).not.toHaveBeenCalled()
  })
  it('FE-002 publication retains independent newer Agent typing and installs saved metadata without enabling Start', async () => {
    let persisted = empty, release!: (value: GraphEditReadResult) => void
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
    vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => new Promise((resolve) => { release = resolve }))
    const user = userEvent.setup(); mount(); const node = await createWorker(user)
    await user.click(saveButton()); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    // Simulate an independently newer retained form, not typing into a locked fieldset.
    act(() => useGraphDraftStore.getState().updateNextDraft(key, (state) => changeDraftAgent(state,
      { ...state.agentEdits![node.agentId]!, name: 'Independently newer Worker' }, state.graph)))
    await act(async () => { persisted = published(persisted); release(persisted) })
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    expect(edit().agentEdits?.[node.agentId]).toMatchObject({ name: 'Independently newer Worker',
      configurationVersionId: `configuration-${node.agentId}-saved`, createdAt: now, updatedAt: now })
    expect(edit().context.agents.find((item) => item.agent.id === node.agentId)?.agent.name).toBe('Worker 2')
    expect(nextDraftDirty(edit())).toBe(true); expect(startButton()).toBeDisabled(); expect(nextDraftApi.start).not.toHaveBeenCalled()
  })
  it.each([[true, false], [true, true], [false, false], [false, true]])('FE-003 topology Discard: dropped reply=%s, newer edits=%s', async (dropped, newer) => {
    const context = repairFixture()
    useGraphDraftStore.getState().installNextDraft(key, context, true)
    let persisted = empty, visible = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => visible)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
      if (!persisted.intent) visible = persisted = stageValue(input)
      return persisted
    })
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => (visible = persisted = waiting(persisted)))
    const discard = vi.spyOn(nextDraftApi, 'editDiscard').mockImplementation(async () => {
      persisted = { ...persisted, intent: { ...persisted.intent!, state: 'discarded' } }
      if (dropped) throw new Error('discard reply lost')
      return (visible = persisted)
    })
    const user = userEvent.setup(), first = mount()
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => removeNode(graph, 'node-1')))
    await user.click(saveButton()); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    await waitFor(() => expect(saveButton()).toBeEnabled()); moveSurvivor()
    if (newer) {
      typeMeaning('independently newer')
      act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => removeNode(graph, 'node-2')))
    }
    await user.click(screen.getByRole('button', { name: /^Discard changes$/ }))
    await waitFor(() => expect(discard).toHaveBeenCalledOnce())
    await waitFor(() => expect(saveButton()).toBeEnabled())
    if (dropped) {
      expect(readEditOutbox(key)).toBeDefined(); expect(edit().graph.nodes.some((node) => node.id === 'node-1')).toBe(false)
    } else await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    visible = persisted; reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    expect(edit().graph.nodes.map((node) => node.id)).toEqual(newer ? ['node-0', 'node-1'] : ['node-0', 'node-1', 'node-2'])
    expect(edit().graph.edges.map((edge) => edge.id)).toEqual(newer ? ['edge-1'] : ['edge-1', 'edge-2'])
    expect(edit().graph.nodes[0]?.position).toEqual({ x: 934, y: -28 })
    expect(edit().graph.nodes[0]?.initialPrompt).toBe(newer ? 'independently newer' : undefined)
    expect(sameExecutableWorkflow(edit().graph, context.draft.graph)).toBe(!newer)
    expect(readEditSnapshot(key)?.graph).toEqual(edit().graph)
    expect(stage).toHaveBeenCalledTimes(2); expect(stage.mock.calls[1]![0]).toEqual(stage.mock.calls[0]![0])
    expect(advance).toHaveBeenCalledOnce(); expect(discard).toHaveBeenCalledOnce(); expect(nextDraftApi.start).not.toHaveBeenCalled()
  })
})
