import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GraphDraftV2Schema, type WorkflowDefinitionV2, type WorkflowRelationship } from '@graphql/contracts/wave25'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphPresentation, useGraphPresentationStore } from '../useGraphPresentation'
import { applyGraphGeometry, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { useUnsavedChanges } from '../../../shared/ui/unsavedChanges'
import { authoringHints, draftAgents, hasLocalChanges, nodeTitle, relationshipPairs } from './model'
import { nextDraftDirty, nextDraftKey, type NextDraftEdit } from './state'
import { nextDraftApi, type AuthoringContext } from './transport'
import { nextDraftWriter, promoteNextDraft } from './managed'
import { draftFailure } from './writer'
import { ApprovalFields, AttachAgentField, ConnectionFields, EntryFields, Field, NodeFields, RelationshipFields } from './AuthoringFields'
import { DraftCanvas, type DraftCanvasHandle } from './DraftCanvas'
import './nextDraft.css'

/** Route entry for the editable next draft, never a view of the current Run. */
export function NextDraftEditor({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const key = nextDraftKey(workspaceId, workflowId)
  return <GraphPresentationProvider key={key}><DraftLoader draftKey={key} workspaceId={workspaceId} workflowId={workflowId} /></GraphPresentationProvider>
}

function DraftLoader({ draftKey, workspaceId, workflowId }: { draftKey: string; workspaceId: string; workflowId: string }) {
  const edit = useGraphDraftStore((state) => state.nextDrafts[draftKey])
  const promotion = useGraphDraftStore((state) => state.nextDraftPromotions[draftKey])
  const [source, setSource] = useState<AuthoringContext>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    if (!useGraphDraftStore.getState().nextDrafts[draftKey]) {
      void nextDraftApi.context(workspaceId, workflowId, { signal: controller.signal }).then((context) => {
        if (!active) return
        setError(undefined)
        const parsed = GraphDraftV2Schema.safeParse(context.draft)
        if (parsed.success && !useGraphDraftStore.getState().nextDraftPromotions[draftKey]) useGraphDraftStore.getState().installNextDraft(draftKey, { draft: parsed.data, agents: context.agents })
        else setSource(context) // The transport already rejected unknown execution semantics.
      }).catch((reason: unknown) => { if (active) setError(draftFailure(reason, false).message) })
    }
    return () => { active = false; controller.abort() }
  }, [draftKey, workspaceId, workflowId, retry])
  useUnsavedChanges({ label: 'Draft conversion', dirty: !!promotion, busy: promotion?.busy,
    uncertain: promotion?.error?.uncertain, saveDisabled: !source,
    save: async () => { if (source) await promoteNextDraft(draftKey, source) },
    discard: () => { if (promotion) throw new Error('Reconcile the conversion before leaving.') } })
  if (edit && !promotion) return <EditorSurface draftKey={draftKey} />
  return <section className="next-draft n-theme" aria-label="Open next draft">
    <h1>Next draft</h1>
    {error ? <p role="alert">{error}</p> : null}
    {promotion?.error ? <p role="alert">{promotion.error.code}: {promotion.error.message}</p> : null}
    {source ? <>
      <p>{promotion ? 'A draft conversion is awaiting confirmation. Reconcile the same command before making other edits.' : 'This workflow uses legacy execution semantics. Convert only its editable draft to explicit entry and typed relationships. Saved versions and Runs remain unchanged.'}</p>
      <p>After conversion, use this v2 editor. The legacy draft editor cannot read typed v2 records; terminal integration must qualify the remaining workflow readers before exposing this route.</p>
      <p>S2 preserves the saved entry identity and rejects unsupported legacy conditional or repeating routes. New Run admission remains disabled.</p>
      <button type="button" disabled={promotion?.busy} onClick={() => {
        void promoteNextDraft(draftKey, source).catch((reason: unknown) => setError(draftFailure(reason, true).message))
      }}>{promotion?.busy ? 'Converting draft…' : promotion ? 'Reconcile conversion' : 'Convert editable draft'}</button>
    </> : error ? <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry draft request</button> : <p role="status">Loading the managed draft…</p>}
  </section>
}

function EditorSurface({ draftKey }: { draftKey: string }) {
  const edit = useGraphDraftStore((state) => state.nextDrafts[draftKey])
  return edit ? <EditorForm draftKey={draftKey} edit={edit} /> : null
}

function EditorForm({ draftKey, edit }: { draftKey: string; edit: NextDraftEdit }) {
  const graph = edit.graph, context = edit.context
  const [kind, setKind] = useState<WorkflowRelationship['kind']>('execution')
  const [message, setMessage] = useState<string>()
  const [localError, setLocalError] = useState<string>()
  const [geometryPending, setGeometryPending] = useState(false)
  const [reloading, setReloading] = useState(false)
  const canvas = useRef<DraftCanvasHandle>(null)
  const presentation = useGraphPresentationStore()
  const nodeId = useGraphPresentation((state) => state.focusedNodeId)
  const edgeId = useGraphPresentation((state) => state.focusedEdgeId)
  const agents = useMemo(() => draftAgents(context), [context])
  const hints = useMemo(() => authoringHints(graph, context), [graph, context])
  const selectedNode = graph.nodes.find((node) => node.id === nodeId)
  const selectedEdge = graph.edges.find((edge) => edge.id === edgeId)
  const change = useCallback((update: (graph: WorkflowDefinitionV2) => WorkflowDefinitionV2) => {
    useGraphDraftStore.getState().changeNextDraft(draftKey, update)
    setMessage(undefined)
  }, [draftKey])
  const geometry = useCallback((changes: GraphGeometryChange[]) => change((value) => {
    // Agent 2's helper only spreads the definition and patches node geometry.
    // Its legacy return annotation is narrower than the unchanged v2 content.
    return applyGraphGeometry(value, changes) as WorkflowDefinitionV2
  }), [change])
  const report = useCallback((error: unknown) => setLocalError(draftFailure(error, false).message), [])
  const save = async (publish: boolean) => {
    canvas.current?.flush()
    setLocalError(undefined); setMessage(undefined)
    const result = await nextDraftWriter.write(draftKey, publish)
    setMessage(result.published ? 'Immutable version saved. Existing Runs are unchanged.' : 'Draft persisted; see server validation below.')
    if (result.newerLocalEdits) throw new Error('The submitted snapshot was saved, but newer local edits remain. Save them before leaving.')
    if (publish && !result.published) throw new Error('The earlier draft command was reconciled. Save the current draft as an immutable version before leaving.')
  }
  const discardLocal = () => {
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending) throw new Error('An in-flight or uncertain command must be reconciled first.')
    canvas.current?.cancel()
    useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state, graph: state.context.draft.graph, history: [], error: undefined, validation: undefined }))
    setLocalError(undefined); setMessage('Local edits discarded. The shared server draft is unchanged.')
  }
  useUnsavedChanges({ label: `${graph.name} next draft`, dirty: hasLocalChanges(context, graph) || geometryPending || !!edit.pending || edit.busy,
    busy: edit.busy || reloading, uncertain: edit.error?.uncertain, error: edit.error?.message ?? localError,
    save: () => save(true), discard: discardLocal })
  const reload = async () => {
    canvas.current?.flush()
    const before = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!before || before.busy || before.pending) return
    if (hasLocalChanges(before.context, before.graph) && !window.confirm('Discard local edits and load the current shared draft?')) return
    setReloading(true)
    try {
      const fresh = await nextDraftApi.context(graph.workspaceId, graph.id)
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current || current.instanceId !== before.instanceId) return
      if (current.graph !== before.graph || current.busy || current.pending) throw new Error('The form changed during reload. Your edits are retained; reload again when ready.')
      useGraphDraftStore.getState().installNextDraft(draftKey, { draft: GraphDraftV2Schema.parse(fresh.draft), agents: fresh.agents }, true)
      setLocalError(undefined); setMessage('Loaded the current shared draft.')
    } catch (error) { report(error) } finally { setReloading(false) }
  }
  return <section className="next-draft n-theme" aria-label="Next-draft authoring">
    <header className="next-draft-header"><div><h1>{graph.name} <span>Next draft</span></h1>
      <p>Revision {context.draft.revision} · {nextDraftDirty(edit) || geometryPending ? 'Unpublished edits' : 'Published version'} · v2 execution semantics</p>
      <small>Base version: <code>{context.draft.baseWorkflowVersionId ?? 'Not published'}</code></small></div>
      <div className="next-draft-actions">
        <button type="button" disabled={edit.busy || !edit.history.length} onClick={() => { canvas.current?.flush(); useGraphDraftStore.getState().undoNextDraft(draftKey) }}>Undo</button>
        <button type="button" disabled={edit.busy || !!edit.pending || reloading} onClick={() => void reload()}>Reload shared draft</button>
        <button type="button" disabled={edit.busy || !!edit.pending} onClick={() => { try { discardLocal() } catch (error) { report(error) } }}>Discard local edits</button>
        <button type="button" disabled={edit.busy || !!edit.pending} onClick={() => void save(false).catch(report)}>Persist draft &amp; validate</button>
        <button type="button" className="next-draft-primary" disabled={edit.busy} onClick={() => void save(true).catch(report)}>
          {edit.busy ? 'Saving…' : edit.pending ? 'Reconcile pending command' : 'Save immutable version'}</button>
      </div>
    </header>
    <p className="next-draft-notice">This editor changes only the next draft. Run facts and saved versions are separate. New v2 Run admission remains rollout-disabled.</p>
    {message ? <p role="status">{message}</p> : null}
    {localError ? <p role="alert">{localError}</p> : null}
    {edit.error ? <div role="alert"><strong>{edit.error.code}</strong>: {edit.error.message}
      {edit.error.uncertain ? <p>The server may have committed the command. Reconcile that exact command before discarding or starting a replacement.</p> : <p>Your form is retained. Correct validation issues, or explicitly reload after a revision or source-pin conflict.</p>}
      {edit.error.issues?.map((issue, i) => <p key={i}>{issue.code}: {issue.message}</p>)}
    </div> : null}
    <div className="next-draft-layout"><div className="next-draft-main">
      <DraftCanvas ref={canvas} draftKey={draftKey} graph={graph} agents={agents} kind={kind} change={change} geometry={geometry} pending={setGeometryPending} report={report} />
      <section className="next-draft-section" aria-label="Nodes and relationships"><h2>Inspect the board</h2>
        <div className="next-draft-records">{graph.nodes.map((node) => <button key={node.id} type="button" aria-pressed={nodeId === node.id} onClick={() => {
          presentation.getState().setFocusedNodeId(node.id); presentation.getState().setFocusedEdgeId(undefined)
        }}>{graph.entryNodeId === node.id ? 'Entry · ' : ''}{nodeTitle(graph, node.id)}<code>{node.id}</code></button>)}</div>
        {relationshipPairs(graph).map((pair) => <fieldset key={JSON.stringify([pair[0]!.source, pair[0]!.target].sort())}><legend>{pair.length} semantic {pair.length === 1 ? 'record' : 'records'}</legend>
          {pair.map((edge) => <button key={edge.id} type="button" aria-pressed={edgeId === edge.id} onClick={() => {
            presentation.getState().setFocusedEdgeId(edge.id); presentation.getState().setFocusedNodeId(undefined)
          }}>{edge.kind} · {nodeTitle(graph, edge.source)} → {nodeTitle(graph, edge.target)}<code>{edge.id}</code></button>)}
        </fieldset>)}
      </section>
      {selectedNode ? <NodeFields graph={graph} node={selectedNode} context={context} change={change} /> : null}
      {selectedEdge ? <RelationshipFields graph={graph} relationship={selectedEdge} change={change} report={report} /> : null}
      {(nodeId && !selectedNode) || (edgeId && !selectedEdge) ? <p role="status">The selected record was removed. Choose another record or Undo.</p> : null}
    </div><aside aria-label="Authoring settings">
      <EntryFields graph={graph} context={context} change={change} />
      <ApprovalFields graph={graph} context={context} change={change} report={report} />
      <ConnectionFields graph={graph} kind={kind} setKind={setKind} change={change} report={report} />
      <AttachAgentField graph={graph} context={context} change={change} report={report} />
      <section className="next-draft-section" aria-label="Execution bounds"><h2>Execution bounds</h2>
        {graph.executionPolicy ? <>
          <Field label="Maximum parallelism"><input type="number" min={1} max={100} value={Number.isFinite(graph.executionPolicy.maxParallelism) ? graph.executionPolicy.maxParallelism : ''} onChange={(event) => {
            const value = event.target.valueAsNumber
            change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxParallelism: value } }))
          }} /></Field>
          <Field label="Maximum node executions"><input type="number" min={1} max={10000} value={Number.isFinite(graph.executionPolicy.maxNodeExecutions) ? graph.executionPolicy.maxNodeExecutions : ''} onChange={(event) => {
            const value = event.target.valueAsNumber
            change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxNodeExecutions: value } }))
          }} /></Field>
        </> : <><p>No execution policy is set. Enter both bounds explicitly before executable save.</p>
          <button type="button" onClick={() => change((item) => ({ ...item, executionPolicy: { maxParallelism: Number.NaN, maxNodeExecutions: Number.NaN } }))}>Set execution bounds</button></>}
        {graph.requiredAgentCount !== undefined ? <>
          <Field label="Required Agent count"><input type="number" min={1} max={10000} value={Number.isFinite(graph.requiredAgentCount) ? graph.requiredAgentCount : ''}
            onChange={(event) => { const requiredAgentCount = event.target.valueAsNumber; change((item) => ({ ...item, requiredAgentCount })) }} /></Field>
          <button type="button" onClick={() => change((item) => { const next = { ...item }; delete next.requiredAgentCount; return next })}>Remove fixed Agent count</button>
        </> : <p>No fixed Agent count is authored.</p>}
      </section>
    </aside></div>
    <section className="next-draft-section" aria-label="Validation"><h2>Readiness</h2>
      {hints.length ? hints.map((issue, i) => <p key={i}>{issue.code}: {issue.message}{issue.relationshipId ? <> <code>{issue.relationshipId}</code></> : null}</p>) : <p>No local authoring hints. This is not executable acceptance.</p>}
      {edit.validation ? <div role="status"><strong>Server validation at draft revision {edit.validation.revision}: {edit.validation.valid ? 'valid' : 'needs correction'}</strong>
        {edit.validation.issues.map((issue, i) => <p key={i}>{issue.code}: {issue.message}</p>)}</div> : null}
      <p>Executable save validates pinned roles, graph acyclicity, routing completeness, reviewer bootstrap, permissions and native compatibility through the shared application service.</p>
    </section>
  </section>
}
