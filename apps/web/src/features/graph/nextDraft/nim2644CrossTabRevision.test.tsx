import { boardStartClient } from '../../workflow-board/startClient'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createStore } from 'zustand/vanilla'
import { GraphEditIntentV3Schema, GraphEditReadResultV3Schema,
  type GraphEditReadResultV3, type GraphEditStageInputV3 } from '@graphql/contracts/wave25'
import { ApiError } from '../../../shared/api/client'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { queryKeys } from '../../../shared/api/query'
import { useGraphDraftStore } from '../store'
import { NextDraftEditor } from './NextDraftEditor'
import { draftOperations } from './model'
import { acknowledgeEditIntentSnapshot } from './useGraphEditIntent'
import { acknowledgeEditOutbox, readEditOutbox, reserveEditOutbox, storeEditSnapshot, type EditIntentOutbox } from './editIntentStorage'
import { newNextDraft, nextDraftKey, type NextDraftEdit } from './state'
import { nextDraftApi } from './transport'
import { repairFixture } from './nim2644State.cases'

// Mounted Query/Zustand transport regression. It models two browser tabs with
// separate Zustand stores/session snapshot IDs and shared protected localStorage.
// It is not authenticated HTTP, PostgreSQL, native Run, or browser-provider evidence.
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

const key = nextDraftKey('workspace', 'workflow')
const tabKey = protectedKey('ui', 'graph-edit-intent:tab')
const now = '2026-09-24T00:00:00Z'
const hash = 'sha256:' + '7'.repeat(64)
const clients: QueryClient[] = []
const edit = () => useGraphDraftStore.getState().nextDrafts[key]!
const saveButton = () => screen.getByRole('button', { name: /^Save changes$/ })

function inTab<T>(id: string, work: () => T): T {
  const previous = sessionStorage.getItem(tabKey)
  sessionStorage.setItem(tabKey, id)
  try { return work() }
  finally { if (previous === null) sessionStorage.removeItem(tabKey); else sessionStorage.setItem(tabKey, previous) }
}
function baseContext() {
  const context = repairFixture(1)
  context.draft.revision = 10
  context.draft.publishedRevision = 10
  context.draft.baseWorkflowVersionId = 'version-5'
  context.draft.graph.version = 5
  return context
}
function mark(current: NextDraftEdit, value: string): NextDraftEdit {
  return { ...current, graph: { ...current.graph, nodes: current.graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: value }) } }
}
function outbox(current: NextDraftEdit, commandId: string): EditIntentOutbox {
  const { draft } = current.context
  return { request: { action: 'stage_edits', workspaceId: draft.workspaceId, workflowId: draft.workflowId,
    draftId: draft.id, commandId, expectedRevision: draft.revision,
    expectedWorkflowVersionId: draft.baseWorkflowVersionId, executionSemanticsVersion: 3,
    operations: draftOperations(current.context, current.graph, current.agentEdits) },
  target: current.graph, ...(current.agentEdits ? { agentTarget: current.agentEdits } : {}) }
}
function savedRead(current: NextDraftEdit, submitted: EditIntentOutbox): GraphEditReadResultV3 {
  const request = submitted.request
  const stagedDraft = { ...current.context.draft, graph: submitted.target,
    stagedAgents: Object.values(submitted.agentTarget ?? {}).map((agent) => ({
      agent: { ...agent, prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [] }, baseRevision: null,
    })) }
  const graph = { ...submitted.target, version: 6 }
  const revision = request.expectedRevision + 1
  const intent = GraphEditIntentV3Schema.parse({ id: `intent-${request.commandId}`, ownerPrincipalId: 'fixture',
    workspaceId: request.workspaceId, workflowId: request.workflowId, draftId: request.draftId,
    stageCommandId: request.commandId, stageInputHash: hash,
    advanceCommandId: `advance-${request.commandId}`, advanceInputHash: hash,
    discardCommandId: `discard-${request.commandId}`, discardInputHash: hash,
    expectedRevision: request.expectedRevision, expectedWorkflowVersionId: request.expectedWorkflowVersionId,
    savedWorkflowRevision: 1, stagedDraft, agentPins: [], affected: [], stops: [],
    saveInput: { workspaceId: request.workspaceId, workflowId: request.workflowId, draftId: request.draftId,
      commandId: `save-${request.commandId}`, expectedRevision: request.expectedRevision, executionSemanticsVersion: 3 },
    saveInputHash: hash, state: 'saved', saveAttempted: true, createdAt: now, updatedAt: now,
    result: { draft: { ...stagedDraft, graph, revision, publishedRevision: revision,
      baseWorkflowVersionId: 'version-6', stagedAgents: [], sourceAgentPins: [] },
    agents: current.context.agents,
    version: { id: 'version-6', workspaceId: request.workspaceId, workflowId: request.workflowId, version: 6,
      executionSemanticsVersion: 3, definition: graph, entryNodeId: graph.entryNodeId, approval: graph.approval,
      agentConfigurationVersionIds: Object.fromEntries(graph.nodes.map((node) => [node.agentId,
        current.context.agents.find((item) => item.agent.id === node.agentId)!.agent.configurationVersionId])),
      contentHash: hash, createdAt: now } } })
  return GraphEditReadResultV3Schema.parse({ intent, current: [], canStop: false, affectedSetChanged: false })
}
function stagedRead(request: GraphEditStageInputV3): GraphEditReadResultV3 {
  const retained = readEditOutbox(key)!
  const context = edit().context
  expect(retained.request).toEqual(request)
  const pin = { workspaceId: request.workspaceId, workflowId: request.workflowId, runId: 'run-correction',
    workflowVersionId: context.draft.baseWorkflowVersionId!, executionSemanticsVersion: 3 as const,
    agentConfigurationVersionIds: { 'agent-0': 'configuration-agent-0' } }
  const intent = GraphEditIntentV3Schema.parse({ id: `intent-${request.commandId}`, ownerPrincipalId: 'fixture',
    workspaceId: request.workspaceId, workflowId: request.workflowId, draftId: request.draftId,
    stageCommandId: request.commandId, stageInputHash: hash,
    advanceCommandId: `advance-${request.commandId}`, advanceInputHash: hash,
    discardCommandId: `discard-${request.commandId}`, discardInputHash: hash,
    expectedRevision: request.expectedRevision, expectedWorkflowVersionId: request.expectedWorkflowVersionId,
    savedWorkflowRevision: 1, stagedDraft: { ...context.draft, graph: retained.target, stagedAgents: [] },
    agentPins: [], affected: [pin], stops: [{ input: { workspaceId: request.workspaceId, runId: pin.runId,
      commandId: `stop-${request.commandId}` }, inputHash: hash }],
    saveInput: { workspaceId: request.workspaceId, workflowId: request.workflowId, draftId: request.draftId,
      commandId: `save-${request.commandId}`, expectedRevision: request.expectedRevision, executionSemanticsVersion: 3 },
    saveInputHash: hash, state: 'staged', saveAttempted: false, createdAt: now, updatedAt: now })
  return GraphEditReadResultV3Schema.parse({ intent, canStop: true, affectedSetChanged: false,
    current: [{ pin, terminal: false, settled: false, outcome: 'pending', cleanupPending: false,
      nativePending: true, interactionPending: false, reviewPending: false }] })
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: now } })
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
}

beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); sessionStorage.clear()
  sessionStorage.setItem(tabKey, 'B')
  vi.stubGlobal('navigator', { ...navigator, locks: { request: async (_name: string, work: () => Promise<unknown>) => work() } })
  vi.spyOn(boardStartClient, 'start').mockRejectedValue(new Error('This regression must not Start a Run'))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('NIM-2644 typed-board cross-tab stale revision fence', () => {
  it('A save cannot move B unsent meaning to the new revision; B conflicts before Stop until explicit reload', async () => {
    const base = baseContext()
    useGraphDraftStore.getState().installNextDraft(key, structuredClone(base), true)
    act(() => useGraphDraftStore.getState().updateNextDraft(key, (current) => mark(current, 'marker B')))
    inTab('B', () => storeEditSnapshot(key, edit()))

    const aStore = createStore<{ edit: NextDraftEdit }>(() => ({ edit: mark(newNextDraft(structuredClone(base), 'tab-A'), 'marker A') }))
    const a = aStore.getState().edit, aBox = outbox(a, 'stage-A-1')
    inTab('A', () => { storeEditSnapshot(key, a); reserveEditOutbox(key, aBox) })
    const savedA = savedRead(a, aBox)
    inTab('A', () => acknowledgeEditOutbox(key, aBox.request.commandId))

    vi.spyOn(nextDraftApi, 'context').mockResolvedValue({ draft: savedA.intent!.result!.draft, agents: savedA.intent!.result!.agents })
    vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue(savedA)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (request) => {
      if (request.expectedRevision === 10) throw new ApiError({ code: 'REVISION_CONFLICT', message: 'Draft is now revision 11' }, 409)
      return stagedRead(request)
    })
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => {
      const value = stagedRead(stage.mock.calls.at(-1)![0])
      return { ...value, intent: { ...value.intent!, state: 'waiting' } }
    })

    const user = userEvent.setup(); mount()
    await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(nextDraftApi.editRead).toHaveBeenCalled())
    await waitFor(() => expect(clients[0]!.isFetching()).toBe(0))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(edit().context.draft.revision).toBe(10)
    expect(edit().graph.nodes[0]?.initialPrompt).toBe('marker B')

    await user.click(saveButton())
    await waitFor(() => expect(stage).toHaveBeenCalledOnce())
    expect(stage.mock.calls[0]![0].expectedRevision).toBe(10)
    expect(advance).not.toHaveBeenCalled()
    expect(readEditOutbox(key)).toBeUndefined()
    expect(edit().context.draft.revision).toBe(10)
    expect(edit().context.draft.baseWorkflowVersionId).toBe('version-5')
    expect(edit().graph.nodes[0]?.initialPrompt).toBe('marker B')
    expect(savedA.intent?.result?.version.id).toBe('version-6')
    expect(boardStartClient.start).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
    await user.click(screen.getByRole('button', { name: 'Reload saved draft' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reload saved draft' }))
    await waitFor(() => expect(edit().context.draft.revision).toBe(11))
    expect(edit().context.draft.baseWorkflowVersionId).toBe('version-6')
    expect(edit().graph.nodes[0]?.initialPrompt).toBe('marker A')

    act(() => useGraphDraftStore.getState().updateNextDraft(key, (current) => mark(current, 'marker B corrected')))
    await user.click(saveButton())
    await waitFor(() => expect(stage).toHaveBeenCalledTimes(2))
    expect(stage.mock.calls[1]![0].expectedRevision).toBe(11)
    await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    expect(boardStartClient.start).not.toHaveBeenCalled()
  })

  it('same-form single-tab lineage can acknowledge once, keep newer typing, and replay idempotently', () => {
    const base = baseContext()
    const first = mark(newNextDraft(base, 'single-tab'), 'marker A')
    const box = outbox(first, 'stage-single')
    inTab('single', () => {
      storeEditSnapshot(key, first)
      reserveEditOutbox(key, box)
      const saved = savedRead(first, box)
      const newer = mark(first, 'marker A newer')
      storeEditSnapshot(key, newer)
      const acknowledged = acknowledgeEditIntentSnapshot(key, newer, saved.intent!)
      expect(acknowledged.context.draft.revision).toBe(11)
      expect(acknowledged.context.draft.baseWorkflowVersionId).toBe('version-6')
      expect(acknowledged.graph.nodes[0]?.initialPrompt).toBe('marker A newer')
      const replay = acknowledgeEditIntentSnapshot(key, acknowledged, saved.intent!)
      expect(replay).toBe(acknowledged)
      acknowledgeEditOutbox(key, box.request.commandId)
      expect(readEditOutbox(key)).toBeUndefined()
    })
  })
})
