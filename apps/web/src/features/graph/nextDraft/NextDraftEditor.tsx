import type { PinnedPanelNode } from './DraftCanvas'
import { AgentActiveTimeField } from './AgentActiveTimeField'
import { JobNodePanel, JobNodePicker } from '../../jobs'
import { attachJob } from './model'
import { BoardNotice } from './BoardNotice'
import { useDraftLayout } from './useDraftLayout'
import { useLocalHumanAccessQuery } from '../../../shared/api/settingsExperience'
import { canUseBoardAction } from '../../workflow-board/permissions'
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Inbox, Redo2, Save, Undo2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GraphDraftV3Schema, staysOnWorkflowBoard, sameAuthoredWorkflow, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { ActionMenu, AgentFacts, Button, ConfirmDialog, EmptyState, Icon, IconButton, LoadingState, TextField, Toolbar, type AgentPanel } from '../../../shared/ui/nocturne'
import { ToastContext } from '../../../shared/ui/nocturne/toastContext'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphPresentationStore } from '../useGraphPresentation'
import { applyGraphGeometry, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { UnsavedChangesContext, useUnsavedChanges } from '../../../shared/ui/unsavedChanges'
import { authoringHints, discardMeaningfulChanges, hasLocalChanges, nodeTitle, removeNode, removeRelationship, roleEvidence } from './model'
import { editorAgents } from './agentEdits'
import { nextDraftDirty, nextDraftKey, type NextDraftEdit } from './state'
import { nextDraftApi, type AuthoringContext } from './transport'
import { readEditOutbox, readEditSnapshot, storeEditSnapshot } from './editIntentStorage'
import { useGraphEditIntent } from './useGraphEditIntent'
import { WorkflowSaveError } from './WorkflowSaveError'
import { EditIntentStatus } from './EditIntentStatus'
import { draftFailure } from './writer'
import { useInteractionsQuery, useManagedWorkspaceQuery, useManagedWorkflowQuery } from '../../../shared/api/query'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { ApprovalFields, AttachAgentField, EntryFields, NodeConnections, NodeWorkflowFields } from './AuthoringFields'
import { AgentInfoTabs } from '../../workflow-board/AgentInfoTabs'
import { DraftCanvas, type AgentPanels, type DraftCanvasHandle, type OpenAgentPanel } from './DraftCanvas'
import { AgentChatPanel } from '../AgentPanels'
import { agentSettingRows } from '../signalEdge'
import { runNodeView, useSelectedRunRecord } from '../../workflow-board/runFacts'
import { useWorkflowBoard } from '../../workflow-board/context'
import { BoardAgentSettings, NewBoardAgent } from '../../workflow-board/AgentControls'
import { AgentPickerPanel } from '../../workflow-board/AgentPickerPanel'
import { WorkflowName, type WorkflowNameHandle } from '../../workflow-board/WorkflowName'
import { WorkflowWorktreeField } from '../../workflow-board/WorkflowWorktreeField'
import { announceBoardChange, boardScope, clearBoardRedo, describeDraftChange, pendingBoardAction, popBoardAction,
  popBoardRedo, publishDraftDepth, pushDraftRedo, useBoardUndo } from '../../workflow-board/boardUndo'
import { BoardUndoNotice } from '../../workflow-board/BoardUndoNotice'
import { BoardAlerts, type BoardUpdateFailure } from '../../workflow-board/BoardAlerts'
import { RemoveWorkflowButton } from '../../workflows/RemoveWorkflowButton'
import { boardDraftContextKey, boardRunListKey } from '../../workflow-board/keys'
import { useApprovalInboxStore } from '../../approvals'
import { RepeatEditor } from '../../repeats/RepeatEditor'
import { boardStartPins, readBoardStartPreflight, sameBoardStartPins, currentBoardStartRequest, useBoardStartPreflight } from '../../workflow-board/startPreflight'
import { boardStartClient, type BoardStartInput } from '../../workflow-board/startClient'
import { acknowledgeBoardStart, readBoardStart, rejectBoardStart, reserveBoardStart, useBoardStartOutbox } from '../../workflow-board/startOutbox'
import { scopeForBoardRun } from '../../workflow-board/client'
import '../graph.css'
import './nextDraft.css'

/** Authoring adapter within the workspace board. Selected Run is NOT an editor key. */
export function NextDraftEditor({ workspaceId, workflowId, initialContext, updateFailures }: {
  workspaceId: string; workflowId: string; initialContext?: AuthoringContext; updateFailures?: readonly BoardUpdateFailure[]
}) {
  const key = nextDraftKey(workspaceId, workflowId)
  return <GraphPresentationProvider key={key}><DraftLoader draftKey={key} workspaceId={workspaceId} workflowId={workflowId} initialContext={initialContext} updateFailures={updateFailures} /></GraphPresentationProvider>
}

const kindName = (kind: 'execution' | 'approval') => kind === 'approval' ? 'Approval' : 'Handoff'

function DraftLoader({ draftKey, workspaceId, workflowId, initialContext, updateFailures }: {
  draftKey: string; workspaceId: string; workflowId: string; initialContext?: AuthoringContext; updateFailures?: readonly BoardUpdateFailure[]
}) {
  const edit = useGraphDraftStore((state) => state.nextDrafts[draftKey])
  const [storageError, setStorageError] = useState<string>()
  const source = useQuery({ queryKey: boardDraftContextKey(workspaceId, workflowId),
    queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }),
    initialData: initialContext, enabled: !edit && !storageError, retry: false,
  })
  useEffect(() => {
    if (useGraphDraftStore.getState().nextDrafts[draftKey]) return
    try {
      const snapshot = readEditSnapshot(draftKey)
      if (snapshot && !initialContext && !source.isFetchedAfterMount && !source.isError) return
      const fresh = source.data && !source.isError ? source.data.draft : undefined
      // A snapshot of an older saved base is superseded when it was clean or its
      // meaning is exactly what has since been saved. Remote hydration waits for
      // its exact journal result rather than substituting current mutable Agent heads.
      // Retained Agent edits are never superseded by a newer saved workflow: they
      // belong to shared Agents, not the graph, and need explicit save or discard.
      const agentEdited = Object.keys(snapshot?.agentEdits ?? {}).length > 0 || Object.keys(snapshot?.agentForms ?? {}).length > 0
      const stale = snapshot && !snapshot.remoteEditIntent && !agentEdited && fresh && (snapshot.context.draft.baseWorkflowVersionId !== fresh.baseWorkflowVersionId
        || snapshot.context.draft.publishedRevision !== fresh.publishedRevision
        || !sameAuthoredWorkflow(snapshot.context.draft.graph, fresh.graph))
        && (!hasLocalChanges(snapshot.context, snapshot.graph) || sameAuthoredWorkflow(snapshot.graph, fresh.graph))
      const retained = stale ? undefined : snapshot
      if (retained) {
        // Retained forms keep only their own Agents; the rest of the catalog comes from the server.
        const catalog = new Map([...(source.data?.agents ?? []), ...retained.context.agents].map((record) => [record.agent.id, record]))
        useGraphDraftStore.getState().installNextDraft(draftKey, { ...retained.context, agents: [...catalog.values()] })
        useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state,
          graph: retained.graph, agentEdits: retained.agentEdits, agentForms: retained.agentForms, remoteEditIntent: retained.remoteEditIntent }))
      } else if (source.data && !source.isError) {
        useGraphDraftStore.getState().installNextDraft(draftKey, { draft: GraphDraftV3Schema.parse(source.data.draft), agents: source.data.agents, savedDraft: source.data.savedDraft })
      }
    } catch (error) { setStorageError(error instanceof Error ? error.message : 'Retained edits are unavailable.') }
  }, [draftKey, initialContext, source.data, source.isError, source.isFetchedAfterMount])
  if (edit) return <EditorForm draftKey={draftKey} edit={edit} updateFailures={updateFailures} />
  if (storageError || source.isError) return <section className="workflow-graph-state" role="alert">
    <h2>Authoring unavailable</h2><p>{storageError ?? source.error?.message}</p>
    <p>No retained command was deleted, retagged or replaced.</p>
    {!storageError ? <Button onClick={() => void source.refetch()}>Try again</Button> : null}
  </section>
  return <LoadingState label="Loading the current workflow draft…" rows={2} />
}

type Panel = 'workflow' | 'agents' | 'repeat' | null
function EditorForm({ draftKey, edit, updateFailures }: { draftKey: string; edit: NextDraftEdit; updateFailures?: readonly BoardUpdateFailure[] }) {
  const graph = edit.graph, context = edit.context, board = useWorkflowBoard()
  const editIntent = useGraphEditIntent(draftKey, edit)
  const undoScope = boardScope(graph.workspaceId, graph.id)
  useLayoutEffect(() => { publishDraftDepth(undoScope, edit.history.length) }, [undoScope, edit.history.length])
  const undoAction = useBoardUndo((state) => state.actions[undoScope]?.at(-1))
  const redoCount = useBoardUndo((state) => state.redo[undoScope]?.length ?? 0)
  const guard = useContext(UnsavedChangesContext)
  const [panel, setPanel] = useState<Panel>(null)
  const settingsPanel = useRef<HTMLElement>(null)
  const workflowName = useRef<WorkflowNameHandle>(null)
  const openSaveField = (path: (string | number)[]) => {
    flushSync(() => setPanel('workflow'))
    let field = 'limits'
    if (path[0] === 'approval') {
      field = path[1] === 'designatedOrchestratorAgentId' ? 'orchestrator' : 'approval'
    } else if (path[0] === 'entryNodeId') {
      field = 'entry'
    } else if (path[0] === 'executionPolicy' && path[1] === 'maxNodeExecutions') {
      field = 'executions'
    } else if (path[0] === 'executionPolicy' && path[1] === 'agentActiveTimeoutMs') {
      field = 'active-time'
    }
    settingsPanel.current?.querySelector<HTMLElement>(`[data-save-field="${field}"]`)?.focus()
  }
  const [openNode, setOpenNode] = useState<OpenAgentPanel>()
  const [confirm, setConfirm] = useState<'save' | 'discard' | 'reload'>()
  const runAfterSave = useRef(false)
  const runRecord = useSelectedRunRecord()
  const [message, setMessage] = useState<string>()
  const [localError, setLocalError] = useState<string>()
  const [, setGeometryPending] = useState(false)
  const reloadMutation = useMutation({ mutationFn: () => nextDraftApi.context(graph.workspaceId, graph.id, undefined, true), retry: false })
  const reloading = reloadMutation.isPending
  const layout = useDraftLayout(draftKey)
  const toast = useContext(ToastContext)
  const layoutFailure = layout.journalError ?? (layout.isError ? layout.error?.message ?? 'Layout could not be saved.' : undefined)
  const retryLayout = layout.mutate
  // Layout is presentation only: it saves silently, also during a Run; only a real failure is reported, unobtrusively.
  useEffect(() => {
    if (layoutFailure) toast?.notify({ title: 'Node layout was not saved.', description: layoutFailure, tone: 'warning',
      action: { label: 'Retry', onClick: () => retryLayout() } })
  }, [layoutFailure, toast, retryLayout])
  const preflight = useBoardStartPreflight(context.draft, { enabled: board?.authoringActive !== false })
  const access = useLocalHumanAccessQuery()
  const principal = !access.isError ? access.data?.principal : undefined
  const canStart = !!principal && Date.parse(principal.expiresAt) > Date.now()
    && canUseBoardAction(principal.grants, 'runs:start', { workspaceId: graph.workspaceId, workflowId: graph.id })
  const startOutbox = useBoardStartOutbox(draftKey)
  const storageFailed = !!startOutbox.error
  const startLock = useRef(false)
  const alive = useRef(true)
  const latestBoard = useRef(board)
  latestBoard.current = board
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const pendingStart = startOutbox.request
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(undefined), 6000)
    return () => window.clearTimeout(timer)
  }, [message])
  const workspace = useManagedWorkspaceQuery(graph.workspaceId)
  const managedWorkflow = useManagedWorkflowQuery(graph.workspaceId, graph.id)
  const approvals = useInteractionsQuery({ workspaceId: graph.workspaceId, workflowId: graph.id, status: 'pending', limit: 100 })
  const pendingApprovals = approvals.data?.items.filter((item) => item.approval.handler === 'user').length
  const queryClient = useQueryClient()
  const canvas = useRef<DraftCanvasHandle>(null)
  const presentation = useGraphPresentationStore()
  const linkedAgent = board?.selectedAgentId
  const linkedSelection = !!board?.selectDraftAgent
  useLayoutEffect(() => {
    if (!linkedSelection) return
    const node = linkedAgent ? useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.find((item) => item.kind!=='job' && item.agentId === linkedAgent) : undefined
    presentation.getState().setFocusedNodeId(node?.id)
    presentation.getState().setSelectedNodeIds(new Set(node ? [node.id] : []))
    if (node) presentation.getState().setFocusedEdgeId(undefined)
    // URL changes project selection only; neither polling nor Run selection replaces the draft.
  }, [linkedAgent, draftKey, presentation, linkedSelection])
  const agents = useMemo(() => editorAgents(edit), [edit])
  const hints = useMemo(() => authoringHints(graph, context, edit.agentEdits), [graph, context, edit.agentEdits])
  const change = useCallback((update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3) => {
    useGraphDraftStore.getState().changeNextDraft(draftKey, (value) => {
      const next = update(value)
      if (editIntent.locked && !sameAuthoredWorkflow(value, next)) {
        setLocalError('Saving is still in progress. You can move agents, but other edits wait until it finishes or you discard it.')
        return value
      }
      return next
    }); setMessage(undefined)
    clearBoardRedo(boardScope(graph.workspaceId, graph.id))
  }, [draftKey, editIntent.locked, graph.workspaceId, graph.id])
  const persistLayout = layout.mutate
  const geometry = useCallback((changes: GraphGeometryChange[]) => {
    change((value) => applyGraphGeometry(value, changes))
    // Only independent layout revisions are written. Semantic staging is untouched.
    persistLayout()
  }, [change, persistLayout])
  const report = useCallback((error: unknown) => setLocalError(draftFailure(error, false).message), [])
  const inspect = useCallback((action: () => void) => {
    void (async () => {
      if (guard && !await guard.surfaces()) return
      if (!alive.current) return
      canvas.current?.flush(); setPanel(null); action()
      const id = presentation.getState().focusedNodeId
      const selectedNode = useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.find((node) => node.id === id)
      const agentId = selectedNode?.kind!=='job'?selectedNode?.agentId:undefined
      if (latestBoard.current?.selectedAgentId !== agentId) latestBoard.current?.selectDraftAgent?.(agentId)
    })()
  }, [guard, presentation, draftKey])
  const openPanel = (next: Panel) => inspect(() => {
    presentation.getState().setFocusedNodeId(undefined); presentation.getState().setFocusedEdgeId(undefined); setPanel(next)
  })
  const discardLocal = () => {
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending || readBoardStart(draftKey)) throw new Error('Reconcile the in-flight or uncertain command first.')
    // Flush any buffered drag before restoring meaning, so independent layout survives.
    canvas.current?.flush()
    useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state, graph: discardMeaningfulChanges(state.context, state.graph),
      context: { ...state.context, draft: { ...(state.context.savedDraft ?? state.context.draft), layoutRevision: state.context.draft.layoutRevision } },
      history: [], future: [], agentEdits: undefined, agentForms: undefined, agentHistory: undefined, error: undefined, validation: undefined }))
    nextDraftApi.discardLocal(graph.workspaceId, graph.id)
    setLocalError(undefined); setMessage('Changes discarded.')
  }
  const stopAndSave = async (allowStop = false) => {
    if (readBoardStart(draftKey)) throw new Error('Reconcile the exact pending Start before Stop-and-save.')
    canvas.current?.flush(); setLocalError(undefined); setMessage(undefined)
    // Even without a local active Run, graph and shared-Agent changes must be
    // staged together. Only the authoritative saved receipt acknowledges edits.
    const result = allowStop ? await editIntent.advance(true) : await editIntent.save()
    if (!allowStop && result.canStop && !result.affectedSetChanged && result.current.some((item) => !item.settled)) setConfirm('save')
    if (result.intent?.state === 'saved') setMessage(result.intent.stops.length ? 'Saved. Stopped runs were not restarted.' : 'Saved.')
    else if (result.intent?.state === 'blocked' || result.intent?.state === 'uncertain') {
      setLocalError(result.intent.error?.message ?? 'Saving isn’t confirmed yet. Your changes are still here.')
    } else setMessage('Edits retained. Save waits for every affected Run to stop and finish cleanup.')
    return result
  }
  const discardChanges = async () => {
    canvas.current?.flush()
    if (editIntent.locked) {
      const retained = readEditOutbox(draftKey)
      const instanceId = useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId
      const result = await editIntent.discard()
      if (result.intent && result.intent.state !== 'discarded') throw new Error('This intent was not discarded. Read its persisted result before changing the form.')
      if (useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== instanceId) throw new Error('The draft instance changed while Discard was acknowledged. The new form is retained.')
      if (retained && result.intent?.stageCommandId === retained.request.commandId
        && result.intent.draftId === retained.request.draftId && result.intent.expectedRevision === retained.request.expectedRevision
        && result.intent.expectedWorkflowVersionId === retained.request.expectedWorkflowVersionId) {
        // The hook already three-way-acknowledged this exact submission. A
        // blanket local discard here would erase independently newer edits.
        setLocalError(undefined); setMessage('Changes discarded. Later edits and agent positions are kept.')
        return
      }
    }
    discardLocal()
  }
  const reload = async (confirmed = false) => {
    if (editIntent.locked) { report(new Error('The private staged payload is retained. Reconcile or discard it before reloading the shared draft.')); return }

    canvas.current?.flush()
    const before = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!before || before.busy || before.pending) return
    if (!confirmed && nextDraftDirty(before)) { setConfirm('reload'); return }
    try {
      const fresh = await reloadMutation.mutateAsync()
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current || current.instanceId !== before.instanceId) return
      if (current.graph !== before.graph || current.agentEdits !== before.agentEdits || current.busy || current.pending) throw new Error('The form changed during reload. Your edits are retained.')
      if (before.startRejectedVersionId && fresh.draft.baseWorkflowVersionId === before.startRejectedVersionId) {
        throw new Error('The saved draft still points to the rejected version. Reload after a newer version is available.')
      }
      useGraphDraftStore.getState().installNextDraft(draftKey, { draft: GraphDraftV3Schema.parse(fresh.draft), agents: fresh.agents, savedDraft: fresh.savedDraft }, true)
      setLocalError(undefined); setMessage(pendingStart ? 'Loaded the saved draft. Confirm the earlier start before starting again.' : 'Loaded the saved draft.')
    } catch (error) { report(error) }
  }
  const startMutation = useMutation({ retry: false, mutationFn: async (options?: { saveFirst?: boolean; allowStop?: boolean }) => {
    if (startLock.current) return
    const generation = sessionGeneration()
    let sent: BoardStartInput | undefined
    startLock.current = true; setLocalError(undefined)
    try {
      // Reconcile the original persisted command before considering current pins
      // or capabilities. A lost acknowledgement never becomes a second Start.
      if (!canStart) throw new Error('Start permission is unavailable for this exact workflow. No command was sent.')
      const existing = readBoardStart(draftKey)
      if (!existing && !useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.length) {
        throw new Error('Add an agent before saving and running.')
      }
      let saved = false
      if (!existing && options?.saveFirst) {
        runAfterSave.current = true
        const result = await stopAndSave(options.allowStop)
        assertSession(generation)
        saved = result.intent?.state === 'saved'
        if (!saved || !alive.current) return
        runAfterSave.current = false
      }
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current) throw new Error('The draft is no longer mounted.')
      let candidate = existing
      if (!candidate) {
        if (current.busy || current.pending || (!saved && editIntent.locked) || nextDraftDirty(current)
          || current.startRejectedVersionId === current.context.draft.baseWorkflowVersionId
          || (!saved && (preflight.isError || !preflight.data))) throw new Error('Save, reload or reconcile before creating a new Start.')
        const displayedPins = saved ? undefined : boardStartPins(current.context.draft, preflight.data!)
        const fresh = await readBoardStartPreflight(current.context.draft)
        assertSession(generation)
        if ((displayedPins && !sameBoardStartPins(displayedPins, boardStartPins(current.context.draft, fresh)))
          || useGraphDraftStore.getState().nextDrafts[draftKey] !== current) {
          throw new Error('The displayed Start pins or local form changed. Reload before starting a new Run.')
        }
        candidate = currentBoardStartRequest(current.context.draft, fresh, crypto.randomUUID())
      }
      sent = await reserveBoardStart(draftKey, candidate)
      const result = await boardStartClient.start(sent)
      assertSession(generation)
      await acknowledgeBoardStart(draftKey, sent)
      void queryClient.invalidateQueries({ queryKey: boardRunListKey(graph.workspaceId, graph.id) })
      if (!alive.current || useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== current.instanceId) return
      latestBoard.current?.selectRun(scopeForBoardRun(result.run))
      setMessage('Start acknowledged for the exact saved version. Run status is read separately.')
    } catch (error) {
      try {
        assertSession(generation)
        if (sent && await rejectBoardStart(draftKey, sent, error)) {
          const rejectedVersion = sent.workflowVersionId
          useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => ({ ...current, startRejectedVersionId: rejectedVersion }))
          setLocalError('This saved version can no longer start. Reload the saved draft before starting another Run.')
        } else report(error)
      } catch (releaseError) { report(releaseError) }
      // Navigation guards must not treat failed/uncertain Start as a successful save.
      throw error
    } finally { startLock.current = false }
  } })
  const starting = startMutation.isPending
  const start = () => startMutation.mutateAsync()
  useUnsavedChanges({ label: `${graph.name} next draft`,
    canResume: () => {
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current || current.busy || current.pending || reloading || starting || editIntent.mutation.isPending) return false
      try { storeEditSnapshot(draftKey, current); return true } catch { return false }
    },
    dirty: nextDraftDirty(edit) || edit.busy || !!pendingStart || editIntent.locked,
    busy: edit.busy || reloading || starting || editIntent.mutation.isPending, uncertain: edit.error?.uncertain || !!pendingStart || editIntent.intent?.state === 'uncertain',
    error: edit.error?.message ?? localError,
    // A generic navigation Save must not implicitly issue Stop. The board
    // exposes the explicit destructive action and the separate safe Discard.
    saveDisabled: !pendingStart && !edit.pending,
    save: () => pendingStart ? start() : edit.pending ? stopAndSave()
      : Promise.reject(new Error('Use “Save changes” on the board to review affected Runs, or Discard changes.')),
    discard: discardChanges }, (current, next) =>
    // The draft document stays mounted when authoring selection changes; dirty contextual forms
    // keep separate registrations for explicit Save/Discard and failed recovery.
    !staysOnWorkflowBoard({ ...current, search: { ...current.search, agentId: undefined } },
      { ...next, search: { ...next.search, agentId: undefined } }))
  const prepare = async (action: () => void | Promise<unknown>) => {
    if (!guard || await guard.surfaces()) await action()
  }
  const dirty = nextDraftDirty(edit)
  const needsSave = dirty || !context.draft.baseWorkflowVersionId
  const canUndo = (dirty && edit.history.length > 0) || !!undoAction
  const canRedo = (edit.future?.length ?? 0) > 0 || redoCount > 0
  const startReloadRequired = !!edit.startRejectedVersionId && edit.startRejectedVersionId === context.draft.baseWorkflowVersionId
  let preflightReason: string | undefined
  try {
    if (preflight.isError) throw preflight.error
    if (!preflight.data) throw new Error('Checking saved workflow and runtime availability…')
    boardStartPins(context.draft, preflight.data)
  } catch (error) { preflightReason = error instanceof Error ? error.message : 'Saved Start pins are unavailable.' }
  const retiredHarness = agents.some(agent => graph.nodes.some(node => node.kind !== 'job' && node.agentId === agent.id)
    && (agent.harness === 'opencode' || agent.harnessConfiguration?.harness === 'opencode'))
  const startDisabled = retiredHarness || !canStart || storageFailed || starting || reloading || (!pendingStart && (!graph.nodes.length || (!needsSave && !!preflightReason) || startReloadRequired || editIntent.locked
    || edit.busy || !!edit.pending))
  const startReason = retiredHarness ? 'Retired harness (OpenCode): read-only' : !canStart ? 'Start permission is unavailable for this workflow' : pendingStart ? 'Reconcile the exact earlier Start command' : startReloadRequired ? 'Reload after the saved version was rejected'
    : !graph.nodes.length ? 'Add an agent before saving and running' : needsSave ? 'Save and run' : preflightReason ?? 'Run the saved workflow'
  const saveBusy = edit.busy || reloading || !!edit.pending || !!pendingStart || editIntent.mutation.isPending
  // Workflow-local Run summaries cannot describe blockers of a shared-Agent edit.
  // Stage/reconcile first; ask for Stop only for that exact authoritative set.
  const affectedRuns = editIntent.query.data?.current.filter((item) => !item.settled) ?? []
  const affectedWorkflows = new Set(affectedRuns.map((item) => item.pin.workflowId)).size
  const stopBlocked = !!editIntent.query.data?.affectedSetChanged || (affectedRuns.length > 0 && !editIntent.query.data?.canStop)
  const requestSave = () => { runAfterSave.current = false; void prepare(() => stopAndSave()).catch(report) }
  const historyAction = (direction: 'undo' | 'redo') => {
    if (saveBusy || starting || editIntent.locked || board?.run) return
    void prepare(async () => {
      canvas.current?.flush()
      const store = useGraphDraftStore.getState()
      const current = store.nextDrafts[draftKey]
      if (!current) return
      // Settings saved straight to the server (schedule) interleave with draft steps in the order they happened.
      if (direction === 'undo') {
        const action = pendingBoardAction(undoScope, current.history.length)
        if (action) {
          await action.undo()
          popBoardAction(undoScope, action)
          announceBoardChange(undoScope, `Undid ${action.label}`)
          return
        }
        const previous = current.history.at(-1)
        if (!previous) return
        store.undoNextDraft(draftKey)
        pushDraftRedo(undoScope)
        announceBoardChange(undoScope, `Undid ${describeDraftChange(previous, current.graph)}`)
      } else {
        const next = popBoardRedo(undoScope)
        if (next?.kind === 'action') {
          await next.action.redo()
          announceBoardChange(undoScope, `Redid ${next.action.label}`)
          return
        }
        const target = current.future?.at(-1)
        if (!target) return
        store.redoNextDraft(draftKey)
        announceBoardChange(undoScope, `Redid ${describeDraftChange(current.graph, target.graph)}`)
      }
      layout.mutate()
    }).catch(report)
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.defaultPrevented) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      if (saveBusy || starting || editIntent.locked || board?.run) return
      event.preventDefault()
      historyAction(key === 'y' || event.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })
  const openAgent = (nodeId: string, next: AgentPanel = 'settings') => inspect(() => {
    presentation.getState().setFocusedNodeId(nodeId); presentation.getState().setFocusedEdgeId(undefined)
    setOpenNode({ nodeId, panel: next })
  })
  const panels = (nodeId: string, pinned?: PinnedPanelNode): AgentPanels => {
    const node = pinned ? {...pinned,id:nodeId} : graph.nodes.find((item) => item.id === nodeId)
    if (!node) return { chat: null, settings: null, info: null }
    if('jobDefinitionId' in node) {
      const details=<JobNodePanel workspaceId={graph.workspaceId} definitionId={node.jobDefinitionId} definitionRevision={node.jobDefinitionRevision} definitionVersionId={node.jobDefinitionVersionId} workflowExecution={pinned?.kind==='job'?pinned.workflowExecution:undefined}/>
      return {chat:details,info:details,settings:pinned?details:<fieldset disabled={edit.busy||reloading||editIntent.locked}><p>Saved job revision {node.jobDefinitionRevision}</p><Button onClick={()=>{setOpenNode(undefined);change(value=>removeNode(value,node.id))}}>Remove job node</Button><NodeWorkflowFields graph={graph} node={node} context={context} agentEdits={edit.agentEdits} change={change}/></fieldset>}
    }
    const agent = agents.find((item) => item.id === node.agentId)
    const run = runNodeView(runRecord, Boolean(board?.run), node.id, node.agentId)
    const savedGraph = (context.savedDraft ?? context.draft).graph
    const savedNode = savedGraph.nodes.some((item) =>
      item.kind !== 'job' && item.id === node.id && item.agentId === node.agentId)
    const unsavedChat = !pinned && !board?.run
      && (!context.draft.baseWorkflowVersionId || !agent?.configurationVersionId || !savedNode)
    const chat = unsavedChat ? <EmptyState icon="chat" title="Save this Agent and workflow to chat"
      description="Save the Agent settings and workflow changes, then reopen chat. Workflow alerts list any missing setup." />
      : <AgentChatPanel name={pinned?.name ?? nodeTitle(graph, node.id)} activity={run.activity} running={run.state === 'running'}
      context={{ workspaceId: graph.workspaceId, workflowId: graph.id, workflowNodeId: node.id, agentId: node.agentId,
        ...(board?.run ? { runId: board.run.runId } : {}) }}
      onNewConversation={() => {
        // Navigation only. Never replace/resume a missing native session under the old key.
        if (board?.run) {
          board.selectRun()
          if (graph.nodes.some((item) => item.id === node.id && item.kind!=='job' && item.agentId === node.agentId)) setOpenNode({ nodeId: node.id, panel: 'chat' })
          else { setOpenNode(undefined); setPanel('agents') }
        } else { setOpenNode(undefined); setPanel('agents') }
      }} />
    if (pinned) return { chat,
      settings: <p className="agent-panel-note">This is a saved Run Agent. Return to the draft to edit settings for future work. Chat does not change this Run.</p>,
      info: <AgentInfoTabs scope={board?.run} agentId={node.agentId} details={<AgentFacts items={[{ label: 'Status', value: run.activity ? `${run.label} · ${run.activity}` : run.label },
        { label: 'Node', value: node.id, mono: true }, { label: 'Agent', value: node.agentId, mono: true },
        { label: 'Run', value: board?.run?.runId, mono: true }]} />} /> }
    const role = roleEvidence(context, node.agentId, edit.agentEdits)
    return {
      chat,
      settings: <fieldset className="board-popover-fields" disabled={edit.busy || reloading || editIntent.locked}>
        <p className="agent-panel-note">Executable changes require every affected Run to stop and finish cleanup before Save. Use Stop-and-save or discard the edits. Moving Agents on the Board does not require Stop.</p>
        <BoardAgentSettings draftKey={draftKey} edit={edit} nodeId={node.id} close={() => setOpenNode(undefined)}
          remove={() => { setOpenNode(undefined); change((value) => removeNode(value, node.id)) }} />
        <NodeWorkflowFields graph={graph} node={graph.nodes.find((item) => item.id === node.id)!} context={context} agentEdits={edit.agentEdits} change={change} />
      </fieldset>,
      info: <AgentInfoTabs scope={board?.run} agentId={node.agentId} details={<>
        <AgentFacts items={[
          { label: 'Status', value: run.activity ? `${run.label} · ${run.activity}` : run.label },
          { label: 'Role', value: role.role === 'orchestrator' ? 'Orchestrator' : role.role === 'coder' ? 'Worker' : 'Unknown' },
          { label: 'Starts workflow', value: graph.entryNodeId === node.id ? 'Yes' : 'No' },
          ...(agent ? agentSettingRows(agent) : []),
        ]} />
        <fieldset className="board-popover-fields" disabled={edit.busy || reloading || editIntent.locked}>
          <NodeConnections graph={graph} nodeId={node.id} change={change} report={report} />
        </fieldset>
        <details className="next-draft-details"><summary>Identifiers</summary>
          <AgentFacts items={[{ label: 'Node', value: node.id, mono: true }, { label: 'Agent', value: node.agentId, mono: true },
            ...(role.configurationVersionId ? [{ label: 'Configuration', value: role.configurationVersionId, mono: true }] : [])]} />
        </details>
      </>} />,
    }
  }
  const rawErrorText = edit.error ? edit.error.message : startOutbox.error ?? localError
  // The save alert already shows the edit-intent failure; do not repeat it.
  const errorText = rawErrorText && rawErrorText === editIntent.mutation.error?.message ? undefined : rawErrorText
  const panelTitle = panel === 'workflow' ? 'Workflow settings' : panel === 'agents' ? 'Add node' : ''
  return <section className="workflow-graph board-typed-editor" aria-label="Workflow authoring">
    <div className="workflow-graph-canvas">
      <DraftCanvas ref={canvas} draftKey={draftKey} graph={graph} agents={agents} kind="execution"
        baseGraph={edit.context.savedDraft?.graph ?? edit.context.draft.graph}
        semanticLocked={edit.busy || reloading || editIntent.locked || starting || !!edit.pending || !!pendingStart}
        change={change} geometry={geometry} pending={setGeometryPending} report={report} inspect={inspect}
        removalDisabled={edit.busy || reloading || editIntent.locked}
        open={openNode} setOpen={setOpenNode} panels={panels} />
      {!graph.nodes.length ? <div className="board-empty"><EmptyState icon="bot" title="Add your first agent"
        description="Start with an orchestrator that plans the work, or a worker that does it."
        action={<Button variant="primary" leading={<Icon name="plus" size={15} />} onClick={() => openPanel('agents')}>Add node</Button>} /></div> : null}
      <header className="board-topbar">
        <div className="board-title">
          <WorkflowName ref={workflowName} name={graph.name} disabled={saveBusy || starting || editIntent.locked}
            onRename={(name) => change((current) => ({ ...current, name }))} />
          <WorkflowWorktreeField workspaceId={graph.workspaceId} value={graph.defaultWorktree}
            savedValue={(edit.context.savedDraft ?? edit.context.draft).graph.defaultWorktree}
            disabled={edit.busy || reloading || editIntent.locked || starting || !!edit.pending || !!pendingStart}
            onChange={defaultWorktree => change(current => {
              const updated = { ...current }
              if (defaultWorktree) updated.defaultWorktree = defaultWorktree
              else delete updated.defaultWorktree
              return updated
            })} />
        </div>
        <div className="board-control-cluster">
          {needsSave || edit.pending || editIntent.locked || canUndo || canRedo ? <Toolbar label="Draft actions">
            {canUndo ? <IconButton label="Undo" variant="ghost" disabled={saveBusy || starting || editIntent.locked}
              onClick={() => historyAction('undo')}><Undo2 aria-hidden="true" size={16} /></IconButton> : null}
            {canRedo ? <IconButton label="Redo" variant="ghost" disabled={saveBusy || starting || editIntent.locked}
              onClick={() => historyAction('redo')}><Redo2 aria-hidden="true" size={16} /></IconButton> : null}
            {dirty ? <IconButton label="Discard changes" variant="ghost" disabled={saveBusy || starting} onClick={() => setConfirm('discard')}><Icon name="close" size={22} /></IconButton> : null}
            {needsSave || edit.pending || editIntent.locked ? <>
            {edit.pending ? <Button disabled={saveBusy || starting} onClick={requestSave}>Retry save</Button> : null}
            {editIntent.locked ? <Button disabled={saveBusy || starting || !!editIntent.storageError || stopBlocked} onClick={requestSave}>
              {affectedRuns.length ? 'Stop affected Runs and save' : 'Reconcile Save'}</Button>
              : <IconButton label="Save changes" disabled={saveBusy || starting || !!editIntent.storageError} onClick={requestSave}><Save aria-hidden="true" size={16} /></IconButton>}
            </> : null}
          </Toolbar> : null}
        {board?.navigationControls}
        <Toolbar label="Workflow controls">
          <RemoveWorkflowButton workspaceId={graph.workspaceId} workflowId={graph.id} name={graph.name}
            revision={managedWorkflow.data?.revision ?? context.draft.publishedRevision}
            renderTrigger={(remove) => <ActionMenu label="Workflow actions" icon="gear" width={220} disabled={saveBusy || starting || editIntent.locked} items={[
              { id: 'rename', label: 'Rename', onSelect: () => workflowName.current?.begin() },
              { id: 'remove', label: 'Remove workflow', icon: 'trash', danger: true, disabled: !managedWorkflow.isSuccess || dirty,
                description: dirty ? 'Save or discard draft changes first.' : undefined,
                onSelect: () => void prepare(remove) },
            ]} />} />
          <IconButton label="Add agent or job to graph" onClick={() => openPanel('agents')}><Icon name="plus" size={16} /></IconButton>
          <IconButton label="Workflow settings" onClick={() => openPanel('workflow')}><Icon name="settings" size={16} /></IconButton>
          <Button variant="secondary" className="n-icon-button workflow-approval-inbox" aria-label={`Open human approval inbox${pendingApprovals ? `, ${pendingApprovals} pending` : ''}`}
            title="Approval inbox" onClick={() => useApprovalInboxStore.getState().openInbox({ workspaceId: graph.workspaceId, workflowId: graph.id })}><Inbox aria-hidden="true" size={16} />
            {pendingApprovals ? <span className="workflow-approval-inbox-badge" aria-hidden="true">{pendingApprovals}</span> : null}</Button>
          {!graph.handoffs ? <Button size="sm" variant="ghost" onClick={() => openPanel('repeat')}>Repeats</Button> : null}
          {board ? <IconButton label="Activities" onClick={board.openRuns}><Icon name="history" size={16} /></IconButton> : null}
          <Button variant="primary" leading={<Icon name="play" size={14} />} aria-label={pendingStart ? 'Reconcile Start' : needsSave ? 'Save and run' : 'Start saved version'}
            title={startReason} disabled={startDisabled} loading={starting} onClick={() => void (pendingStart ? start() : prepare(() => needsSave ? startMutation.mutateAsync({ saveFirst: true }) : start())).catch(report)}>{pendingStart ? 'Confirm start' : needsSave ? 'Save and run' : 'Run'}</Button>
        </Toolbar>
        </div>
      </header>
      <BoardUndoNotice scope={undoScope} />
      <BoardAlerts scope={draftKey} hints={hints} validation={edit.validation} error={editIntent.mutation.error ?? undefined} updateFailures={updateFailures}
        pending={editIntent.mutation.isPending} openField={openSaveField} openIssue={(issue) => {
          if (issue.nodeId) openAgent(issue.nodeId)
          else if (issue.relationshipId) inspect(() => presentation.getState().setFocusedEdgeId(issue.relationshipId))
          else openPanel(issue.code === 'ENTRY_REQUIRED' && !graph.nodes.length ? 'agents' : 'workflow')
        }} />
      <div className="board-notices" aria-live="polite">
        {!pendingStart && workspace.data && workspace.data.locationValidation.status !== 'ready' ? <BoardNotice tone="warning" title="Choose an execution folder to run this workflow."
          action={<Button size="sm" onClick={board?.openLocation}>Choose folder</Button>} /> : null}
        {pendingStart ? <BoardNotice tone="warning" title="An earlier start may have gone through."
          action={<Button size="sm" onClick={() => void (pendingStart ? start() : prepare(start)).catch(report)}>Check again</Button>}>Confirm it before starting another run.</BoardNotice> : null}
        {startReloadRequired ? <BoardNotice tone="warning" title="Reload the saved draft before starting another Run."
          action={<Button size="sm" disabled={reloading} onClick={() => void reload()}>Reload saved draft</Button>}>
          The previous Start was rejected because its saved version is no longer supported.</BoardNotice> : null}
        {message ? <BoardNotice tone="success" title={message} /> : null}
        {editIntent.storageError ? <BoardNotice tone="danger" live title="Changes can’t be kept in this browser.">{editIntent.storageError}</BoardNotice> : null}
        {editIntent.query.error ? <BoardNotice tone="warning" title="Couldn’t check the status of your last save.">Your changes are still here. {editIntent.query.error.message}</BoardNotice> : null}
        {editIntent.mutation.error ? <WorkflowSaveError error={editIntent.mutation.error} pending={editIntent.outboxPending || !!editIntent.intent && !['saved', 'discarded'].includes(editIntent.intent.state)} openField={openSaveField} /> : null}
        {editIntent.locked && !editIntent.sameDisplayedPayload ? <BoardNotice tone="warning" title="You made more edits after saving started.">They stay here and won’t be overwritten.</BoardNotice> : null}
        {editIntent.query.data?.intent && !['saved', 'discarded'].includes(editIntent.query.data.intent.state) ? <EditIntentStatus data={editIntent.query.data} /> : null}
        {errorText ? <BoardNotice noticeKey={errorText} tone="danger" live title={edit.error?.uncertain ? 'We couldn’t confirm whether that worked.' : 'Something went wrong.'}>
          {errorText}{edit.error?.issues?.length ? <ul>{edit.error.issues.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul> : null}
        </BoardNotice> : null}
      </div>
      <aside className="board-side-panel" hidden={panel !== 'repeat'} style={panel === 'repeat' ? undefined : { display: 'none' }} aria-label="Business repeats">
        <header><h2>Business repeats</h2><IconButton variant="ghost" label="Close panel" onClick={() => openPanel(null)}><Icon name="close" size={16} /></IconButton></header>
        <RepeatEditor graph={graph} change={change} disabled={edit.busy || reloading || editIntent.locked || !!edit.pending || !!pendingStart} />
      </aside>
      {panel === 'agents' ? <AgentPickerPanel close={() => openPanel(null)}>
        {graph.handoffs?<section><h3>Saved jobs</h3><p>This workflow uses work handoffs, which job nodes can’t join. Switch to one-pass dependencies to add a job; the change is saved as a new version with the usual Stop-and-save checks.</p><Button disabled={edit.busy || reloading || editIntent.locked || starting} onClick={()=>change(value=>{const next={...value};delete next.handoffs;return next})}>Use one-pass dependencies</Button></section>:null}
        {!graph.handoffs?<JobNodePicker workspaceId={graph.workspaceId} onChoose={definition=>{change(value=>attachJob(value,definition,`node-${crypto.randomUUID()}`));openPanel(null)}}/>:null}
        <fieldset disabled={edit.busy || reloading || editIntent.locked || starting}>
          <NewBoardAgent draftKey={draftKey} edit={edit} report={report} />
          <AttachAgentField graph={graph} context={context} change={change} report={report} />
        </fieldset>
      </AgentPickerPanel> : null}
      {panel && panel !== 'repeat' && panel !== 'agents' ? <aside ref={settingsPanel} className="board-side-panel" aria-label={panelTitle || 'Board controls'}>
        <header><h2>{panelTitle}</h2><IconButton variant="ghost" label="Close panel" onClick={() => openPanel(null)}><Icon name="close" size={16} /></IconButton></header>
        <fieldset disabled={edit.busy || reloading || editIntent.locked}>
          {panel === 'workflow' ? <>
            {graph.handoffs ? <p className="next-draft-hint">Set each work connection’s Run-wide handoff limit on its line. The Board keeps these edits as a draft until Save.</p> : null}
            <EntryFields graph={graph} context={context} agentEdits={edit.agentEdits} change={change} />
            <ApprovalFields graph={graph} context={context} agentEdits={edit.agentEdits} change={change} report={report} />
            <section className="next-draft-section" aria-label="Execution bounds"><h3>Limits</h3>
              {graph.executionPolicy ? <AgentActiveTimeField policy={graph.executionPolicy}
                defaultMs={preflight.data?.capabilities.agentActiveTimeBudget.defaultMs}
                onChange={(executionPolicy) => change((item) => ({ ...item, executionPolicy }))} /> : null}
              {graph.executionPolicy ? <div className="next-draft-inline">
                <TextField data-save-field="limits" label="Maximum parallelism" hint="Agents running at once" type="number" min={1} max={100} value={Number.isFinite(graph.executionPolicy.maxParallelism) ? graph.executionPolicy.maxParallelism : ''} onChange={(event) => { const value = event.target.valueAsNumber; change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxParallelism: value } })) }} />
                <TextField data-save-field="executions" label="Maximum node executions" hint="Agent turns per run" type="number" min={1} max={10000} value={Number.isFinite(graph.executionPolicy.maxNodeExecutions) ? graph.executionPolicy.maxNodeExecutions : ''} onChange={(event) => { const value = event.target.valueAsNumber; change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxNodeExecutions: value } })) }} />
              </div> : <Button data-save-field="limits" size="sm" onClick={() => change((item) => ({ ...item, executionPolicy: { maxParallelism: Number.NaN, maxNodeExecutions: Number.NaN } }))}>Set limits</Button>}
              {graph.requiredAgentCount !== undefined ? <div className="next-draft-inline">
                <TextField label="Required Agent count" type="number" min={0} max={10000} value={Number.isFinite(graph.requiredAgentCount) ? graph.requiredAgentCount : ''} onChange={(event) => { const requiredAgentCount = event.target.valueAsNumber; change((item) => ({ ...item, requiredAgentCount })) }} />
                <Button size="sm" variant="ghost" onClick={() => change((item) => { const next = { ...item }; delete next.requiredAgentCount; return next })}>Remove fixed Agent count</Button>
              </div> : null}
            </section>
            <section className="next-draft-section"><h3>Execution folder</h3>
              <p className="next-draft-hint">{workspace.data?.locationValidation.status === 'ready' ? 'Runs work in this workspace’s folder.' : 'No usable folder is set yet.'}</p>
              <Button size="sm" onClick={board?.openLocation}>Change folder</Button>
            </section>
            <section className="next-draft-section"><h3>Draft</h3>
              <p className="next-draft-hint">{context.draft.baseWorkflowVersionId ? <>Based on saved version <code>{context.draft.baseWorkflowVersionId}</code>.</> : 'This workflow hasn’t been saved yet.'}</p>
              <Button size="sm" disabled={!!edit.pending} onClick={() => {
                if (nextDraftDirty(edit)) setConfirm('reload'); else void reload()
              }}>Reload saved draft</Button>
            </section>
          </> : null}
        </fieldset>
      </aside> : null}
      <nav className="board-keyboard-list" aria-label="Agents and connections">
        {graph.nodes.map((node) => <Button size="sm" variant="ghost" key={node.id} onClick={() => openAgent(node.id)}>
          {graph.entryNodeId === node.id ? 'Entry · ' : ''}{nodeTitle(graph, node.id)}</Button>)}
        {graph.edges.map((edge) => <Button size="sm" variant="ghost" key={edge.id}
          disabled={edit.busy || reloading || editIntent.locked}
          onClick={() => change((value) => removeRelationship(value, edge.id))}>
          Remove {kindName(edge.kind)} · {nodeTitle(graph, edge.source)} → {nodeTitle(graph, edge.target)}</Button>)}
      </nav>
    </div>
    <ConfirmDialog open={confirm === 'save' && affectedRuns.length > 0 && !stopBlocked} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Stop running work and save?"
      description={`${affectedRuns.length} affected ${affectedRuns.length === 1 ? 'Run requires' : 'Runs require'} Stop or cleanup across ${affectedWorkflows} ${affectedWorkflows === 1 ? 'workflow' : 'workflows'}.${affectedRuns.some((item) => item.pin.workflowId !== graph.id) ? ' This includes shared-Agent work in another workflow.' : ''} Stop-and-save stops every affected Run and waits for full cleanup before saving. Stopped runs are not restarted.`}
      confirmLabel="Stop runs and save" onConfirm={() => { setConfirm(undefined); void prepare(() => runAfterSave.current ? startMutation.mutateAsync({ saveFirst: true, allowStop: true }) : stopAndSave(true)).catch(report) }} />
    <ConfirmDialog open={confirm === 'discard'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Discard your changes?"
      description="Your unsaved edits are removed. Agent positions on the board are kept. Running work isn’t affected."
      confirmLabel="Discard changes" onConfirm={() => { setConfirm(undefined); void prepare(discardChanges).catch(report) }} />
    <ConfirmDialog open={confirm === 'reload'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Reload the saved draft?"
      description="Your unsaved edits are replaced by the latest saved draft."
      confirmLabel="Reload saved draft" onConfirm={() => { setConfirm(undefined); void reload(true) }} />
  </section>
}
