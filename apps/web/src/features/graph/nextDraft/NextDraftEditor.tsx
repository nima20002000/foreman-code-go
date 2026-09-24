import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Inbox } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { GraphDraftV2Schema, staysOnWorkflowBoard, sameExecutableWorkflow, type WorkflowDefinitionV2, type WorkflowRelationship } from '@graphql/contracts/wave25'
import { Button, Icon, Toolbar } from '../../../shared/ui/nocturne'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphPresentation, useGraphPresentationStore } from '../useGraphPresentation'
import { applyGraphGeometry, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { UnsavedChangesContext, useUnsavedChanges } from '../../../shared/ui/unsavedChanges'
import { authoringHints, discardMeaningfulChanges, hasLocalChanges, nodeTitle } from './model'
import { editorAgents, hasAgentEdits } from './agentEdits'
import { nextDraftDirty, nextDraftKey, type NextDraftEdit } from './state'
import { nextDraftApi, type AuthoringContext } from './transport'
import { nextDraftWriter, promoteNextDraft } from './managed'
import { readEditSnapshot } from './editIntentStorage'
import { useGraphEditIntent } from './useGraphEditIntent'
import { EditIntentStatus } from './EditIntentStatus'
import { draftFailure } from './writer'
import { useInteractionsQuery, useManagedWorkspaceQuery } from '../../../shared/api/query'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { ApprovalFields, AttachAgentField, ConnectionFields, EntryFields, Field, NodeFields, RelationshipFields } from './AuthoringFields'
import { DraftCanvas, type DraftCanvasHandle } from './DraftCanvas'
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
  return <section className="workflow-graph-state n-theme" aria-label="Enable parallel execution">
    <h2>Enable parallel execution</h2>
    {error ? <p role="alert">{error}</p> : null}
    {promotion?.error ? <p role="alert">{promotion.error.code}: {promotion.error.message}</p> : null}
    {source ? <>
      <p>{promotion ? 'Reconcile the exact conversion command before making other edits.' : 'Convert only the editable draft to explicit entry and typed connections. Saved versions and existing Runs remain unchanged.'}</p>
      <p>Unsupported legacy conditional or repeating routes are rejected, not silently converted.</p>
      <Button disabled={promotion?.busy} onClick={() => void promoteNextDraft(draftKey, source).catch((reason: unknown) => setError(draftFailure(reason, true).message))}>
        {promotion?.busy ? 'Converting draft…' : promotion ? 'Reconcile conversion' : 'Convert editable draft'}</Button>
      {!promotion && board ? <Button variant="secondary" onClick={board.closeConversion}>Keep legacy authoring</Button> : null}
    </> : error ? <Button onClick={() => setRetry((value) => value + 1)}>Retry draft request</Button> : <p role="status">Loading the managed draft…</p>}
  </section>
}

type Panel = 'workflow' | 'agents' | 'connection' | 'readiness' | null
function EditorForm({ draftKey, edit }: { draftKey: string; edit: NextDraftEdit }) {
  const graph = edit.graph, context = edit.context, board = useWorkflowBoard()
  const editIntent = useGraphEditIntent(draftKey, edit)
  const guard = useContext(UnsavedChangesContext)
  const [panel, setPanel] = useState<Panel>(null)
  const [agentSettings, setAgentSettings] = useState(false)
  const [kind, setKind] = useState<WorkflowRelationship['kind']>('execution')
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
  const nodeId = useGraphPresentation((state) => state.focusedNodeId)
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
  const hints = useMemo(() => authoringHints(graph, context), [graph, context])
  const selectedNode = graph.nodes.find((node) => node.id === nodeId)
  const selectedEdge = graph.edges.find((edge) => edge.id === edgeId)
  const change = useCallback((update: (graph: WorkflowDefinitionV2) => WorkflowDefinitionV2) => {
    useGraphDraftStore.getState().changeNextDraft(draftKey, (value) => {
      const next = update(value)
      if (editIntent.locked && !sameExecutableWorkflow(value, next)) {
        setLocalError('The exact staged payload is retained. Reconcile or discard it before changing meaning; layout remains editable.')
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
      canvas.current?.flush(); setAgentSettings(false); setPanel(null); action()
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
    setMessage(result.published ? 'Immutable version saved. Existing Runs are unchanged.' : 'Draft persisted; server validation is shown in Readiness.')
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
    setLocalError(undefined); setMessage('Local edits discarded. The shared server draft is unchanged.')
  }
  const stopAndSave = async () => {
    canvas.current?.flush(); setLocalError(undefined); setMessage(undefined)
    const result = await editIntent.advance()
    if (result.intent?.state === 'saved') setMessage('The exact edits were saved once. No Run was restarted.')
    else if (result.intent?.state === 'blocked' || result.intent?.state === 'uncertain') {
      setLocalError(result.intent.error?.message ?? 'The intent is retained; publication is not confirmed.')
    } else setMessage('The exact edit intent is retained. Publication waits for authoritative settlement of all affected Runs.')
  }
  const discardChanges = async () => {
    canvas.current?.flush()
    if (editIntent.locked) {
      const result = await editIntent.discard()
      if (result.intent && result.intent.state !== 'discarded') throw new Error('This intent was not discarded. Read its persisted result before changing the form.')
    }
    discardLocal()
  }
  const reload = async () => {
    if (editIntent.locked) { report(new Error('The private staged payload is retained. Reconcile or discard it before reloading the shared draft.')); return }

    canvas.current?.flush()
    const before = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!before || before.busy || before.pending) return
    if ((hasLocalChanges(before.context, before.graph) || hasAgentEdits(before)) && !window.confirm('Discard local edits and load the current shared draft?')) return
    setReloading(true)
    try {
      const fresh = await nextDraftApi.context(graph.workspaceId, graph.id)
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current || current.instanceId !== before.instanceId) return
      if (current.graph !== before.graph || current.agentEdits !== before.agentEdits || current.busy || current.pending) throw new Error('The form changed during reload. Your edits are retained.')
      useGraphDraftStore.getState().installNextDraft(draftKey, { draft: GraphDraftV2Schema.parse(fresh.draft), agents: fresh.agents }, true)
      setLocalError(undefined); setMessage(pendingStart ? 'Loaded the shared draft. Reconcile the earlier Start before starting again.' : 'Loaded the current shared draft.')
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
      setMessage(`Run ${result.run.id} started from the saved version. Later draft edits are retained.`)
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
  return <section className="workflow-graph board-typed-editor n-theme" aria-label="Workflow authoring">
      <div className="board-draft-notices">
        {pendingStart ? <p role="status">An earlier Start may have been accepted for version <code>{pendingStart.workflowVersionId}</code>. Reconcile Start before a new admission.</p> : null}
        {!pendingStart && workspace.data?.locationValidation.status !== 'ready' ? <p role="status">A valid workspace execution folder is required to Start. <button type="button" onClick={board?.openLocation}>Set execution folder</button></p> : null}
        {message ? <p role="status">{message}</p> : null}
        {editIntent.storageError ? <p role="alert">{editIntent.storageError}</p> : null}
        {editIntent.query.error ? <p role="alert">Retained-intent readback is unavailable: {editIntent.query.error.message}. No read error proves that a Stop or save failed.</p> : null}
        {editIntent.mutation.error ? <p role="alert">{editIntent.mutation.error.message} The retained payload and exact command identities have not been replaced.</p> : null}
        {editIntent.outboxPending ? <p role="status">An exact Stage command is retained for reply reconciliation. Retrying does not allocate a new command.</p> : null}
        {editIntent.locked && !editIntent.sameDisplayedPayload ? <p role="alert">This tab has independent local edits. The action reconciles only the recorded payload below; newer local edits will not be overwritten.</p> : null}
        {editIntent.query.data?.intent ? <EditIntentStatus data={editIntent.query.data} /> : null}
        {localError ? <p role="alert">{localError}</p> : null}
        {edit.error ? <div role="alert"><strong>{edit.error.code}</strong>: {edit.error.message}
          {edit.error.uncertain ? <p>Reconcile the exact command before discarding or replacing it.</p> : <p>The local form is retained.</p>}
          {edit.error.issues?.map((issue, i) => <p key={i}>{issue.code}: {issue.message}</p>)}
        </div> : null}
      </div>
    <div className="workflow-graph-canvas">
      <DraftCanvas ref={canvas} draftKey={draftKey} graph={graph} agents={agents} kind={kind}
        change={change} geometry={geometry} pending={setGeometryPending} report={report} inspect={inspect} />
      <div className="workflow-graph-primary-actions"><Toolbar label="Workflow controls">
        <Button variant="secondary" className="n-icon-button workflow-graph-add-agent" aria-label="Workflow settings" title="Workflow settings" onClick={() => openPanel('workflow')}><Icon name="settings" size={16} /></Button>
        <Button variant="secondary" className="n-icon-button workflow-graph-add-agent workflow-approval-inbox" aria-label={`Open human approval inbox${pendingApprovals ? `, ${pendingApprovals} pending` : ''}`}
          title="Human approval inbox" onClick={() => useApprovalInboxStore.getState().openInbox({ workspaceId: graph.workspaceId, workflowId: graph.id })}><Inbox aria-hidden="true" size={16} />
          {pendingApprovals ? <span className="workflow-approval-inbox-badge" aria-hidden="true">{pendingApprovals}</span> : null}</Button>
        <Button variant="secondary" className="n-icon-button workflow-graph-run" aria-label={pendingStart ? 'Reconcile Start' : 'Start saved version'}
          title={pendingStart ? 'Reconcile the exact earlier Start' : 'Start saved version'} disabled={startDisabled} onClick={() => void prepare(start).catch(report)}><Icon name="play" size={16} /></Button>
        <Button variant="secondary" className="n-icon-button workflow-graph-add-agent" aria-label="Add agent to graph" title="Add agent to graph" onClick={() => openPanel('agents')}><Icon name="plus" size={17} /></Button>
        <Button variant="secondary" onClick={() => openPanel('connection')}>Connections</Button>
      </Toolbar></div>
      <header className="board-draft-caption"><strong>{graph.name}</strong>
        <span>Editing next draft · revision {context.draft.revision} · {dirty ? 'Unpublished edits' : 'Published version'}</span>
        <button type="button" onClick={() => openPanel('readiness')}>Readiness{hints.length ? ` · ${hints.length} checks` : ''}</button>
      </header>
      <div className="workflow-graph-actions"><p>Saving meaningful edits stops every affected unsettled workflow or shared-Agent Run, not only the Run selected on this board. It never restarts a Run.</p><Toolbar label="Graph actions">
        <Button variant="secondary" disabled={edit.busy || editIntent.locked || !edit.history.length} onClick={() => void prepare(() => { canvas.current?.flush(); useGraphDraftStore.getState().undoNextDraft(draftKey) })}>Undo</Button>
        <Button variant="primary" disabled={edit.busy || reloading || !!edit.pending || !!pendingStart || editIntent.mutation.isPending || !!editIntent.storageError}
          onClick={() => void prepare(stopAndSave).catch(report)}>Stop current Run and save edits</Button>
        <Button variant="secondary" disabled={edit.busy || reloading || !!edit.pending || !!pendingStart || editIntent.mutation.isPending}
          onClick={() => void prepare(discardChanges).catch(report)}>Discard changes</Button>
        {edit.pending ? <Button variant="secondary" disabled={edit.busy || editIntent.locked} onClick={() => void prepare(() => save(true)).catch(report)}>Reconcile pending command</Button> : null}
      </Toolbar></div>
      {panel || selectedNode || selectedEdge ? <aside className="board-authoring-inspector" aria-label="Board controls">
        <Button variant="secondary" onClick={() => openPanel(null)}>Close controls</Button>
        <fieldset disabled={edit.busy || reloading || editIntent.locked}>
          {selectedNode ? <>
            <NodeFields graph={graph} node={selectedNode} context={context} change={change} />
            <Button variant="secondary" onClick={() => setAgentSettings(true)}>Agent configuration</Button>
            {agentSettings ? <BoardAgentSettings draftKey={draftKey} edit={edit} nodeId={selectedNode.id} close={() => setAgentSettings(false)} /> : null}
          </> : null}
          {selectedEdge ? <RelationshipFields graph={graph} relationship={selectedEdge} change={change} report={report} /> : null}
          {panel === 'agents' ? <><NewBoardAgent draftKey={draftKey} edit={edit} report={report} /><AttachAgentField graph={graph} context={context} change={change} report={report} /></> : null}
          {panel === 'connection' ? <ConnectionFields graph={graph} kind={kind} setKind={setKind} change={change} report={report} /> : null}
          {panel === 'workflow' ? <>
            <EntryFields graph={graph} context={context} change={change} />
            <ApprovalFields graph={graph} context={context} change={change} report={report} />
            <section className="next-draft-section" aria-label="Execution bounds"><h2>Execution bounds</h2>
              {graph.executionPolicy ? <>
                <Field label="Maximum parallelism"><input type="number" min={1} max={100} value={Number.isFinite(graph.executionPolicy.maxParallelism) ? graph.executionPolicy.maxParallelism : ''} onChange={(event) => { const value = event.target.valueAsNumber; change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxParallelism: value } })) }} /></Field>
                <Field label="Maximum node executions"><input type="number" min={1} max={10000} value={Number.isFinite(graph.executionPolicy.maxNodeExecutions) ? graph.executionPolicy.maxNodeExecutions : ''} onChange={(event) => { const value = event.target.valueAsNumber; change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxNodeExecutions: value } })) }} /></Field>
              </> : <Button onClick={() => change((item) => ({ ...item, executionPolicy: { maxParallelism: Number.NaN, maxNodeExecutions: Number.NaN } }))}>Set execution bounds</Button>}
              {graph.requiredAgentCount !== undefined ? <>
                <Field label="Required Agent count"><input type="number" min={1} max={10000} value={Number.isFinite(graph.requiredAgentCount) ? graph.requiredAgentCount : ''} onChange={(event) => { const requiredAgentCount = event.target.valueAsNumber; change((item) => ({ ...item, requiredAgentCount })) }} /></Field>
                <Button variant="secondary" onClick={() => change((item) => { const next = { ...item }; delete next.requiredAgentCount; return next })}>Remove fixed Agent count</Button>
              </> : <p>No fixed Agent count is authored.</p>}
            </section>
            <section className="next-draft-section"><h2>Draft actions</h2>
              <Button variant="secondary" disabled={!!edit.pending} onClick={() => void reload()}>Reload shared draft</Button>
              <Button variant="secondary" disabled={!!edit.pending || !!pendingStart} onClick={() => {
                if (window.confirm('Discard changes without issuing Stop? Independent layout is retained.')) {
                  void discardChanges().catch(report)
                }
              }}>Discard local edits</Button>
              <p>Base version: <code>{context.draft.baseWorkflowVersionId ?? 'Not published'}</code>. Save version does not retarget existing Runs.</p>
            </section>
          </> : null}
          {panel === 'readiness' ? <section className="next-draft-section" aria-label="Validation"><h2>Readiness</h2>
            {hints.length ? hints.map((issue, i) => <p key={i}>{issue.code}: {issue.message}</p>) : <p>No local hints. Executability still requires server acceptance.</p>}
            {edit.validation ? <div role="status"><strong>Server validation at draft revision {edit.validation.revision}: {edit.validation.valid ? 'valid' : 'needs correction'}</strong>
              {edit.validation.issues.map((issue, i) => <p key={i}>{issue.code}: {issue.message}</p>)}</div> : null}
            <p>Save validates exact roles, configuration pins, routing, approval authority and native compatibility.</p>
          </section> : null}
        </fieldset>
      </aside> : null}
      <div className="board-accessible-selection"><details><summary>Select a board node or connection</summary>
        {graph.nodes.map((node) => <button type="button" key={node.id} onClick={() => inspect(() => {
          presentation.getState().setFocusedNodeId(node.id); presentation.getState().setFocusedEdgeId(undefined)
        })}>{graph.entryNodeId === node.id ? 'Entry · ' : ''}{nodeTitle(graph, node.id)}</button>)}
        {graph.edges.map((edge) => <button type="button" key={edge.id} onClick={() => inspect(() => {
          presentation.getState().setFocusedEdgeId(edge.id); presentation.getState().setFocusedNodeId(undefined)
        })}>{edge.kind} · {nodeTitle(graph, edge.source)} → {nodeTitle(graph, edge.target)} · {edge.id}</button>)}
      </details></div>
    </div>
  </section>
}
