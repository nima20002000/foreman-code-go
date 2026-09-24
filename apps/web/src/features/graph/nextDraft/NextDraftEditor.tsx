import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Inbox } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { GraphDraftV2Schema, staysOnWorkflowBoard, sameExecutableWorkflow, type WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { AgentFacts, Alert, Badge, Button, ConfirmDialog, EmptyState, Icon, IconButton, LoadingState, TextField, Toolbar, type AgentPanel } from '../../../shared/ui/nocturne'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphPresentation, useGraphPresentationStore } from '../useGraphPresentation'
import { applyGraphGeometry, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { UnsavedChangesContext, useUnsavedChanges } from '../../../shared/ui/unsavedChanges'
import { authoringHints, discardMeaningfulChanges, hasLocalChanges, nodeTitle, removeNode, roleEvidence } from './model'
import { editorAgents, hasAgentEdits } from './agentEdits'
import { nextDraftDirty, nextDraftKey, type NextDraftEdit } from './state'
import { nextDraftApi, type AuthoringContext } from './transport'
import { nextDraftWriter, promoteNextDraft } from './managed'
import { readEditOutbox, readEditSnapshot } from './editIntentStorage'
import { useGraphEditIntent } from './useGraphEditIntent'
import { EditIntentStatus } from './EditIntentStatus'
import { draftFailure } from './writer'
import { useInteractionsQuery, useManagedWorkspaceQuery } from '../../../shared/api/query'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { ApprovalFields, AttachAgentField, EntryFields, NodeConnections, NodeWorkflowFields, RelationshipFields } from './AuthoringFields'
import { DraftCanvas, type AgentPanels, type DraftCanvasHandle, type OpenAgentPanel } from './DraftCanvas'
import { AgentChatPanel } from '../AgentPanels'
import { agentSettingRows } from '../signalEdge'
import { runNodeView, useSelectedRunRecord } from '../../workflow-board/runFacts'
import { useWorkflowBoard } from '../../workflow-board/context'
import { BoardAgentSettings, NewBoardAgent } from '../../workflow-board/AgentControls'
import { boardDraftContextKey, boardRunListKey } from '../../workflow-board/keys'
import { useApprovalInboxStore } from '../../approvals'
import '../graph.css'
import './nextDraft.css'

/** Authoring adapter within the workspace board. Selected Run is NOT an editor key. */
export function NextDraftEditor({ workspaceId, workflowId, initialContext }: {
  workspaceId: string; workflowId: string; initialContext?: AuthoringContext
}) {
  const key = nextDraftKey(workspaceId, workflowId)
  return <GraphPresentationProvider key={key}><DraftLoader draftKey={key} workspaceId={workspaceId} workflowId={workflowId} initialContext={initialContext} /></GraphPresentationProvider>
}

const kindName = (kind: 'execution' | 'approval') => kind === 'approval' ? 'Approval' : 'Handoff'

function DraftLoader({ draftKey, workspaceId, workflowId, initialContext }: {
  draftKey: string; workspaceId: string; workflowId: string; initialContext?: AuthoringContext
}) {
  const edit = useGraphDraftStore((state) => state.nextDrafts[draftKey])
  const promotion = useGraphDraftStore((state) => state.nextDraftPromotions[draftKey])
  const [source, setSource] = useState<AuthoringContext>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const board = useWorkflowBoard()
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    if (!useGraphDraftStore.getState().nextDrafts[draftKey]) {
      try {
        const retained = readEditSnapshot(draftKey)
        if (retained && !useGraphDraftStore.getState().nextDraftPromotions[draftKey]) {
          useGraphDraftStore.getState().installNextDraft(draftKey, retained.context)
          useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state,
            graph: retained.graph, agentEdits: retained.agentEdits }))
          return () => { active = false; controller.abort() }
        }
      } catch (reason) {
        // Invalid/out-of-scope storage is not deleted or silently overwritten.
        setError(reason instanceof Error ? reason.message : 'The retained edit cannot be recovered.')
        return () => { active = false; controller.abort() }
      }
      void (initialContext ? Promise.resolve(initialContext) : nextDraftApi.context(workspaceId, workflowId, { signal: controller.signal })).then((context) => {
        if (!active) return
        setError(undefined)
        const parsed = GraphDraftV2Schema.safeParse(context.draft)
        if (parsed.success && !useGraphDraftStore.getState().nextDraftPromotions[draftKey]) {
          useGraphDraftStore.getState().installNextDraft(draftKey, { draft: parsed.data, agents: context.agents })
        } else setSource(context)
      }).catch((reason: unknown) => { if (active) setError(draftFailure(reason, false).message) })
    }
    return () => { active = false; controller.abort() }
  }, [draftKey, workspaceId, workflowId, initialContext, retry])
  useUnsavedChanges({ label: 'Draft conversion', dirty: !!promotion, busy: promotion?.busy,
    uncertain: promotion?.error?.uncertain, saveDisabled: !source,
    save: async () => { if (source) await promoteNextDraft(draftKey, source) },
    discard: () => { if (promotion) throw new Error('Reconcile the conversion before leaving.') } })
  if (edit && !promotion) return <EditorForm draftKey={draftKey} edit={edit} />
  return <section className="workflow-graph-state board-convert" aria-label="Enable parallel execution">
    <EmptyState icon="workflow" title={promotion ? 'Finish turning on parallel runs' : 'Run agents in parallel'}
      description={promotion ? 'The last attempt didn’t confirm. Try again to finish it before making other edits.'
        : 'Agents can hand work to several others at once, and you choose which one starts. Saved versions and past runs stay as they are.'} />
    {error ? <Alert tone="danger" live title="Couldn’t turn on parallel runs.">{error}</Alert> : null}
    {promotion?.error ? <Alert tone="danger" live title="Couldn’t turn on parallel runs.">{promotion.error.message}</Alert> : null}
    {source ? <>
      <p className="next-draft-hint">Conditional or repeating routes from the old editor can’t be converted and will be reported.</p>
      <div className="n-actions">
        {!promotion && board ? <Button onClick={board.closeConversion}>Keep legacy authoring</Button> : null}
        <Button variant="primary" loading={promotion?.busy} onClick={() => void promoteNextDraft(draftKey, source).catch((reason: unknown) => setError(draftFailure(reason, true).message))}>
          {promotion?.busy ? 'Converting draft…' : promotion ? 'Reconcile conversion' : 'Convert editable draft'}</Button>
      </div>
    </> : error ? <Button onClick={() => setRetry((value) => value + 1)}>Try again</Button> : <LoadingState label="Loading the draft…" rows={2} />}
  </section>
}

type Panel = 'workflow' | 'agents' | 'readiness' | null
function EditorForm({ draftKey, edit }: { draftKey: string; edit: NextDraftEdit }) {
  const graph = edit.graph, context = edit.context, board = useWorkflowBoard()
  const editIntent = useGraphEditIntent(draftKey, edit)
  const guard = useContext(UnsavedChangesContext)
  const [panel, setPanel] = useState<Panel>(null)
  const [openNode, setOpenNode] = useState<OpenAgentPanel>()
  const [confirm, setConfirm] = useState<'save' | 'discard' | 'reload'>()
  const runRecord = useSelectedRunRecord()
  const [message, setMessage] = useState<string>()
  const [localError, setLocalError] = useState<string>()
  const [geometryPending, setGeometryPending] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [storageFailed, setStorageFailed] = useState(false)
  const startLock = useRef(false)
  const alive = useRef(true)
  const latestBoard = useRef(board)
  latestBoard.current = board
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const pendingStart = useGraphDraftStore((state) => state.pendingRunStarts[draftKey])
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(undefined), 6000)
    return () => window.clearTimeout(timer)
  }, [message])
  const workspace = useManagedWorkspaceQuery(graph.workspaceId)
  const approvals = useInteractionsQuery({ workspaceId: graph.workspaceId, workflowId: graph.id, status: 'pending', limit: 100 })
  const pendingApprovals = approvals.data?.items.filter((item) => item.approval.handler === 'user').length
  const queryClient = useQueryClient()
  useEffect(() => {
    try { useGraphDraftStore.getState().loadPendingRunStart(draftKey); setStorageFailed(false) }
    catch (error) { setStorageFailed(true); setLocalError(error instanceof Error ? error.message : 'Pending Start storage is unavailable.') }
  }, [draftKey])
  const canvas = useRef<DraftCanvasHandle>(null)
  const presentation = useGraphPresentationStore()
  const edgeId = useGraphPresentation((state) => state.focusedEdgeId)
  const linkedAgent = board?.selectedAgentId
  const linkedSelection = !!board?.selectDraftAgent
  useLayoutEffect(() => {
    if (!linkedSelection) return
    const node = linkedAgent ? useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.find((item) => item.agentId === linkedAgent) : undefined
    presentation.getState().setFocusedNodeId(node?.id)
    presentation.getState().setSelectedNodeIds(new Set(node ? [node.id] : []))
    if (node) presentation.getState().setFocusedEdgeId(undefined)
    // URL changes project selection only; neither polling nor Run selection replaces the draft.
  }, [linkedAgent, draftKey, presentation, linkedSelection])
  const agents = useMemo(() => editorAgents(edit), [edit])
  const hints = useMemo(() => authoringHints(graph, context, edit.agentEdits), [graph, context, edit.agentEdits])
  const selectedEdge = graph.edges.find((edge) => edge.id === edgeId)
  const change = useCallback((update: (graph: WorkflowDefinitionV2) => WorkflowDefinitionV2) => {
    useGraphDraftStore.getState().changeNextDraft(draftKey, (value) => {
      const next = update(value)
      if (editIntent.locked && !sameExecutableWorkflow(value, next)) {
        setLocalError('Saving is still in progress. You can move agents, but other edits wait until it finishes or you discard it.')
        return value
      }
      return next
    }); setMessage(undefined)
  }, [draftKey, editIntent.locked])
  const geometry = useCallback((changes: GraphGeometryChange[]) => change((value) => applyGraphGeometry(value, changes) as WorkflowDefinitionV2), [change])
  const report = useCallback((error: unknown) => setLocalError(draftFailure(error, false).message), [])
  const inspect = useCallback((action: () => void) => {
    void (async () => {
      if (guard && !await guard.surfaces()) return
      if (!alive.current) return
      canvas.current?.flush(); setPanel(null); action()
      const id = presentation.getState().focusedNodeId
      const agentId = useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.find((node) => node.id === id)?.agentId
      if (latestBoard.current?.selectedAgentId !== agentId) latestBoard.current?.selectDraftAgent?.(agentId)
    })()
  }, [guard, presentation, draftKey])
  const openPanel = (next: Panel) => inspect(() => {
    presentation.getState().setFocusedNodeId(undefined); presentation.getState().setFocusedEdgeId(undefined); setPanel(next)
  })
  const save = async (publish: boolean) => {
    if (editIntent.locked) throw new Error('Reconcile the retained Stop-and-save intent first.')
    canvas.current?.flush(); setLocalError(undefined); setMessage(undefined)
    const result = await nextDraftWriter.write(draftKey, publish)
    void queryClient.invalidateQueries({ queryKey: boardDraftContextKey(graph.workspaceId, graph.id) })
    setMessage(result.published ? 'Saved. Runs that already started are unchanged.' : 'Draft saved. Check what to fix before running.')
    if (result.newerLocalEdits) throw new Error('The submitted snapshot was saved, but newer local edits remain. Save them before leaving.')
    if (publish && !result.published) throw new Error('The earlier command was reconciled. Save the current draft as a version before leaving.')
  }
  const discardLocal = () => {
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending || useGraphDraftStore.getState().pendingRunStarts[draftKey]) throw new Error('Reconcile the in-flight or uncertain command first.')
    // Flush any buffered drag before restoring meaning, so independent layout survives.
    canvas.current?.flush()
    useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state, graph: discardMeaningfulChanges(state.context, state.graph),
      history: [], agentEdits: undefined, agentHistory: undefined, error: undefined, validation: undefined }))
    setLocalError(undefined); setMessage('Changes discarded.')
  }
  const stopAndSave = async () => {
    canvas.current?.flush(); setLocalError(undefined); setMessage(undefined)
    const result = await editIntent.advance()
    if (result.intent?.state === 'saved') setMessage(result.intent.stops.length ? 'Saved. Stopped runs were not restarted.' : 'Saved.')
    else if (result.intent?.state === 'blocked' || result.intent?.state === 'uncertain') {
      setLocalError(result.intent.error?.message ?? 'Saving isn’t confirmed yet. Your changes are still here.')
    } else setMessage('Saving once the affected runs have stopped.')
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
    if (!confirmed && (hasLocalChanges(before.context, before.graph) || hasAgentEdits(before))) { setConfirm('reload'); return }
    setReloading(true)
    try {
      const fresh = await nextDraftApi.context(graph.workspaceId, graph.id)
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current || current.instanceId !== before.instanceId) return
      if (current.graph !== before.graph || current.agentEdits !== before.agentEdits || current.busy || current.pending) throw new Error('The form changed during reload. Your edits are retained.')
      useGraphDraftStore.getState().installNextDraft(draftKey, { draft: GraphDraftV2Schema.parse(fresh.draft), agents: fresh.agents }, true)
      setLocalError(undefined); setMessage(pendingStart ? 'Loaded the saved draft. Confirm the earlier start before starting again.' : 'Loaded the saved draft.')
    } catch (error) { report(error) } finally { setReloading(false) }
  }
  const start = async () => {
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending || startLock.current || editIntent.locked) return
    const existing = useGraphDraftStore.getState().pendingRunStarts[draftKey]
    if (!existing && (nextDraftDirty(current) || geometryPending || !current.context.draft.baseWorkflowVersionId || workspace.data?.locationValidation.status !== 'ready')) return
    startLock.current = true; setStarting(true); setLocalError(undefined)
    try {
      const request = useGraphDraftStore.getState().reserveRunStart(draftKey, existing ?? {
        executionSemanticsVersion: 2, workspaceId: graph.workspaceId, workflowId: graph.id,
        workflowVersionId: current.context.draft.baseWorkflowVersionId!, draftId: current.context.draft.id,
        expectedDraftRevision: current.context.draft.revision, expectedLocationRevision: workspace.data!.locationRevision,
        commandId: crypto.randomUUID(), input: {},
      })
      const generation = sessionGeneration()
      const result = await nextDraftApi.start(request)
      assertSession(generation)
      useGraphDraftStore.getState().acknowledgeRunStart(draftKey, request.commandId)
      void queryClient.invalidateQueries({ queryKey: boardRunListKey(graph.workspaceId, graph.id) })
      // Client-side selection keeps this editor and its buffered/unsent changes mounted.
      if (!alive.current || useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== current.instanceId) return
      latestBoard.current?.selectRun({ workspaceId: result.run.workspaceId, workflowId: result.run.workflowId,
        runId: result.run.id, workflowVersionId: result.run.workflowVersionId, executionSemanticsVersion: 2 })
      setMessage('Run started from the saved workflow.')
    } catch (error) { report(error) } finally { startLock.current = false; setStarting(false) }
  }
  useUnsavedChanges({ label: `${graph.name} next draft`,
    dirty: hasLocalChanges(context, graph) || hasAgentEdits(edit) || !!edit.pending || edit.busy || !!pendingStart || editIntent.locked,
    busy: edit.busy || reloading || starting || editIntent.mutation.isPending, uncertain: edit.error?.uncertain || !!pendingStart || editIntent.intent?.state === 'uncertain',
    error: edit.error?.message ?? localError,
    // A generic navigation Save must not implicitly issue Stop. The board
    // exposes the explicit destructive action and the separate safe Discard.
    saveDisabled: !pendingStart && !edit.pending,
    save: () => pendingStart ? start() : edit.pending ? save(true)
      : Promise.reject(new Error('Use “Stop current Run and save edits” on the board, or Discard changes.')),
    discard: discardChanges }, (current, next) =>
    // The draft document stays mounted when authoring selection changes; dirty contextual forms
    // keep their separate surface registrations and still require a decision before unmounting.
    !staysOnWorkflowBoard({ ...current, search: { ...current.search, agentId: undefined } },
      { ...next, search: { ...next.search, agentId: undefined } }))
  const prepare = async (action: () => void | Promise<unknown>) => {
    if (!guard || await guard.surfaces()) await action()
  }
  const dirty = nextDraftDirty(edit)
  const startDisabled = storageFailed || starting || editIntent.locked || edit.busy || !!edit.pending || (!pendingStart
    && (dirty || !context.draft.baseWorkflowVersionId || workspace.data?.locationValidation.status !== 'ready'))
  const startReason = pendingStart ? 'Confirm whether the earlier start went through' : dirty ? 'Save your changes before starting a run'
    : !context.draft.baseWorkflowVersionId ? 'Save the workflow before starting a run'
      : workspace.data?.locationValidation.status !== 'ready' ? 'Choose an execution folder first' : 'Start a run of the saved workflow'
  const saveBusy = edit.busy || reloading || !!edit.pending || !!pendingStart || editIntent.mutation.isPending
  const requestSave = () => { if (board?.activeRuns) setConfirm('save'); else void prepare(stopAndSave).catch(report) }
  const openAgent = (nodeId: string, next: AgentPanel = 'settings') => inspect(() => {
    presentation.getState().setFocusedNodeId(nodeId); presentation.getState().setFocusedEdgeId(undefined)
    setOpenNode({ nodeId, panel: next })
  })
  const panels = (nodeId: string): AgentPanels => {
    const node = graph.nodes.find((item) => item.id === nodeId)
    if (!node) return { chat: null, settings: null, info: null }
    const agent = agents.find((item) => item.id === node.agentId)
    const run = runNodeView(runRecord, Boolean(board?.run), node.id, node.agentId)
    const role = roleEvidence(context, node.agentId, edit.agentEdits)
    return {
      chat: <AgentChatPanel name={nodeTitle(graph, node.id)} activity={run.activity} running={run.state === 'running'} />,
      settings: <fieldset className="board-popover-fields" disabled={edit.busy || reloading || editIntent.locked}>
        <p className="agent-panel-note">Saved changes apply to the next run. A run that already started keeps its settings.</p>
        <BoardAgentSettings draftKey={draftKey} edit={edit} nodeId={node.id} close={() => setOpenNode(undefined)}
          remove={() => { setOpenNode(undefined); change((value) => removeNode(value, node.id)) }} />
        <NodeWorkflowFields graph={graph} node={node} context={context} agentEdits={edit.agentEdits} change={change} />
      </fieldset>,
      info: <>
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
      </>,
    }
  }
  const errorText = edit.error ? edit.error.message : localError
  const panelTitle = panel === 'workflow' ? 'Workflow settings' : panel === 'agents' ? 'Add agent' : panel === 'readiness' ? 'Before you run' : selectedEdge ? kindName(selectedEdge.kind) : ''
  return <section className="workflow-graph board-typed-editor" aria-label="Workflow authoring">
    <div className="workflow-graph-canvas">
      <DraftCanvas ref={canvas} draftKey={draftKey} graph={graph} agents={agents} kind="execution"
        change={change} geometry={geometry} pending={setGeometryPending} report={report} inspect={inspect}
        open={openNode} setOpen={setOpenNode} panels={panels} />
      {!graph.nodes.length ? <div className="board-empty"><EmptyState icon="bot" title="Add your first agent"
        description="Start with an orchestrator that plans the work, or a worker that does it."
        action={<Button variant="primary" leading={<Icon name="plus" size={15} />} onClick={() => openPanel('agents')}>Add agent</Button>} /></div> : null}
      <header className="board-topbar">
        <div className="board-title">
          <h2>{graph.name}</h2>
          <Badge tone={dirty ? 'warning' : 'neutral'} dot>{dirty ? 'Unsaved changes' : context.draft.baseWorkflowVersionId ? 'Saved' : 'Not saved yet'}</Badge>
          {hints.length ? <Button size="sm" variant="ghost" leading={<Icon name="warning" size={14} />} onClick={() => openPanel('readiness')}>
            {hints.length} {hints.length === 1 ? 'thing' : 'things'} to fix</Button> : null}
        </div>
        <Toolbar label="Workflow controls">
          <IconButton label="Add agent to graph" onClick={() => openPanel('agents')}><Icon name="plus" size={16} /></IconButton>
          <IconButton label="Workflow settings" onClick={() => openPanel('workflow')}><Icon name="settings" size={16} /></IconButton>
          <Button variant="secondary" className="n-icon-button workflow-approval-inbox" aria-label={`Open human approval inbox${pendingApprovals ? `, ${pendingApprovals} pending` : ''}`}
            title="Approval inbox" onClick={() => useApprovalInboxStore.getState().openInbox({ workspaceId: graph.workspaceId, workflowId: graph.id })}><Inbox aria-hidden="true" size={16} />
            {pendingApprovals ? <span className="workflow-approval-inbox-badge" aria-hidden="true">{pendingApprovals}</span> : null}</Button>
          {board ? <IconButton label="Runs" onClick={board.openRuns}><Icon name="history" size={16} /></IconButton> : null}
          <Button variant="primary" leading={<Icon name="play" size={14} />} aria-label={pendingStart ? 'Reconcile Start' : 'Start saved version'}
            title={startReason} disabled={startDisabled} loading={starting} onClick={() => void prepare(start).catch(report)}>{pendingStart ? 'Confirm start' : 'Start run'}</Button>
        </Toolbar>
      </header>
      <div className="board-notices" aria-live="polite">
        {!pendingStart && workspace.data && workspace.data.locationValidation.status !== 'ready' ? <Alert tone="warning" title="Choose an execution folder to run this workflow."
          action={<Button size="sm" onClick={board?.openLocation}>Choose folder</Button>} /> : null}
        {pendingStart ? <Alert tone="warning" title="An earlier start may have gone through."
          action={<Button size="sm" onClick={() => void prepare(start).catch(report)}>Check again</Button>}>Confirm it before starting another run.</Alert> : null}
        {message ? <Alert tone="success" title={message} action={<IconButton size="sm" variant="ghost" label="Dismiss" onClick={() => setMessage(undefined)}><Icon name="close" size={14} /></IconButton>} /> : null}
        {editIntent.storageError ? <Alert tone="danger" live title="Changes can’t be kept in this browser.">{editIntent.storageError}</Alert> : null}
        {editIntent.query.error ? <Alert tone="warning" title="Couldn’t check the status of your last save.">Your changes are still here. {editIntent.query.error.message}</Alert> : null}
        {editIntent.mutation.error ? <Alert tone="danger" live title="Changes were not saved.">{editIntent.mutation.error.message} Your edits are still here.</Alert> : null}
        {editIntent.locked && !editIntent.sameDisplayedPayload ? <Alert tone="warning" title="You made more edits after saving started.">They stay here and won’t be overwritten.</Alert> : null}
        {editIntent.query.data?.intent && !['saved', 'discarded'].includes(editIntent.query.data.intent.state) ? <EditIntentStatus data={editIntent.query.data} /> : null}
        {errorText ? <Alert tone="danger" live title={edit.error?.uncertain ? 'We couldn’t confirm whether that worked.' : 'Something went wrong.'}
          action={<IconButton size="sm" variant="ghost" label="Dismiss" onClick={() => setLocalError(undefined)}><Icon name="close" size={14} /></IconButton>}>
          {errorText}{edit.error?.issues?.length ? <ul>{edit.error.issues.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul> : null}
        </Alert> : null}
      </div>
      {panel || selectedEdge ? <aside className="board-side-panel" aria-label={panelTitle || 'Board controls'}>
        <header><h2>{panelTitle}</h2><IconButton variant="ghost" label="Close panel" onClick={() => openPanel(null)}><Icon name="close" size={16} /></IconButton></header>
        <fieldset disabled={edit.busy || reloading || editIntent.locked}>
          {selectedEdge && !panel ? <RelationshipFields graph={graph} relationship={selectedEdge} change={change} report={report} /> : null}
          {panel === 'agents' ? <><NewBoardAgent draftKey={draftKey} edit={edit} report={report} added={() => setPanel(null)} /><AttachAgentField graph={graph} context={context} change={change} report={report} /></> : null}
          {panel === 'workflow' ? <>
            <EntryFields graph={graph} context={context} agentEdits={edit.agentEdits} change={change} />
            <ApprovalFields graph={graph} context={context} agentEdits={edit.agentEdits} change={change} report={report} />
            <section className="next-draft-section" aria-label="Execution bounds"><h3>Limits</h3>
              {graph.executionPolicy ? <div className="next-draft-inline">
                <TextField label="Maximum parallelism" hint="Agents running at once" type="number" min={1} max={100} value={Number.isFinite(graph.executionPolicy.maxParallelism) ? graph.executionPolicy.maxParallelism : ''} onChange={(event) => { const value = event.target.valueAsNumber; change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxParallelism: value } })) }} />
                <TextField label="Maximum node executions" hint="Agent turns per run" type="number" min={1} max={10000} value={Number.isFinite(graph.executionPolicy.maxNodeExecutions) ? graph.executionPolicy.maxNodeExecutions : ''} onChange={(event) => { const value = event.target.valueAsNumber; change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxNodeExecutions: value } })) }} />
              </div> : <Button size="sm" onClick={() => change((item) => ({ ...item, executionPolicy: { maxParallelism: Number.NaN, maxNodeExecutions: Number.NaN } }))}>Set limits</Button>}
              {graph.requiredAgentCount !== undefined ? <div className="next-draft-inline">
                <TextField label="Required Agent count" type="number" min={1} max={10000} value={Number.isFinite(graph.requiredAgentCount) ? graph.requiredAgentCount : ''} onChange={(event) => { const requiredAgentCount = event.target.valueAsNumber; change((item) => ({ ...item, requiredAgentCount })) }} />
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
                if (hasLocalChanges(context, graph) || hasAgentEdits(edit)) setConfirm('reload'); else void reload()
              }}>Reload saved draft</Button>
            </section>
          </> : null}
          {panel === 'readiness' ? <section className="next-draft-section" aria-label="Validation">
            {hints.length ? <ul className="board-hints">{hints.map((issue, i) => <li key={i}><Icon name="warning" size={14} />{issue.message}</li>)}</ul>
              : <p>Nothing to fix here. Saving runs the full check.</p>}
            {hints.length ? <Button size="sm" onClick={() => setPanel('workflow')}>Open workflow settings</Button> : null}
            {edit.validation ? <Alert tone={edit.validation.valid ? 'success' : 'warning'} title={edit.validation.valid ? 'The last save passed all checks.' : 'The last save needs a few fixes.'}>
              {edit.validation.issues.length ? <ul>{edit.validation.issues.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul> : null}</Alert> : null}
          </section> : null}
        </fieldset>
      </aside> : null}
      {dirty || edit.pending || editIntent.locked ? <div className="board-save-bar" role="region" aria-label="Unsaved changes">
        <span><span className="n-dirty-dot" aria-hidden="true" />{editIntent.locked ? 'Saving after affected runs stop…' : edit.busy ? 'Saving…' : 'You have unsaved changes'}</span>
        <div className="n-actions">
          <Button variant="ghost" leading={<Icon name="history" size={14} />} disabled={edit.busy || editIntent.locked || !edit.history.length}
            onClick={() => void prepare(() => { canvas.current?.flush(); useGraphDraftStore.getState().undoNextDraft(draftKey) })}>Undo</Button>
          <Button disabled={saveBusy} onClick={() => setConfirm('discard')}>Discard changes</Button>
          {edit.pending ? <Button disabled={edit.busy || editIntent.locked} onClick={() => void prepare(() => save(true)).catch(report)}>Retry save</Button> : null}
          <Button variant="primary" loading={editIntent.mutation.isPending} disabled={saveBusy || !!editIntent.storageError} onClick={requestSave}>
            Save changes</Button>
        </div>
      </div> : null}
      <nav className="board-keyboard-list" aria-label="Agents and connections">
        {graph.nodes.map((node) => <Button size="sm" variant="ghost" key={node.id} onClick={() => openAgent(node.id)}>
          {graph.entryNodeId === node.id ? 'Entry · ' : ''}{nodeTitle(graph, node.id)}</Button>)}
        {graph.edges.map((edge) => <Button size="sm" variant="ghost" key={edge.id} onClick={() => inspect(() => {
          setOpenNode(undefined); presentation.getState().setFocusedEdgeId(edge.id); presentation.getState().setFocusedNodeId(undefined)
        })}>{kindName(edge.kind)} · {nodeTitle(graph, edge.source)} → {nodeTitle(graph, edge.target)}</Button>)}
      </nav>
    </div>
    <ConfirmDialog open={confirm === 'save'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Stop running work and save?"
      description={`${board?.activeRuns ?? 0} ${board?.activeRuns === 1 ? 'run is' : 'runs are'} active in this workspace. Saving stops every run that uses these agents. Stopped runs are not restarted.`}
      confirmLabel="Stop runs and save" onConfirm={() => { setConfirm(undefined); void prepare(stopAndSave).catch(report) }} />
    <ConfirmDialog open={confirm === 'discard'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Discard your changes?"
      description="Your unsaved edits are removed. Agent positions on the board are kept. Running work isn’t affected."
      confirmLabel="Discard changes" onConfirm={() => { setConfirm(undefined); void prepare(discardChanges).catch(report) }} />
    <ConfirmDialog open={confirm === 'reload'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Reload the saved draft?"
      description="Your unsaved edits are replaced by the latest saved draft."
      confirmLabel="Reload saved draft" onConfirm={() => { setConfirm(undefined); void reload(true) }} />
  </section>
}
