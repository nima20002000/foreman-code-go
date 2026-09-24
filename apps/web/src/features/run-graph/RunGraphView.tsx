import { memo, useCallback, useMemo, useRef, useState } from 'react'
import {
  Background, BaseEdge, Controls, Handle, Position, ReactFlow, getSmoothStepPath,
  type NodeProps, type EdgeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { RunGraphScope } from '@graphql/contracts/wave25'
import { Button, Select, WorkflowNodeCard } from '../../shared/ui/nocturne'
import { GraphPresentationProvider } from '../graph/GraphPresentation'
import { useGraphPresentation, useGraphPresentationStore } from '../graph/useGraphPresentation'
import { RunGraphProvider } from './RunGraphProvider'
import { useRunGraphContext } from './context'
import { useRunGraphNode, useRunGraphSelection } from './hooks'
import {
  selectGraphTopology, selectGraphRun, selectGraphReader, selectGraphTransport,
  selectLegacyRun,
} from './cache'
import { presentRunGraphNode } from './presentation'
import { createRunViewTopologyProjector, type RunViewNode, type RunViewEdge } from './topology'
import { RunAttentionAnnouncement, RunAttentionTools, RunExchangeInspector } from './RunAttention'
import { RunVisualEffects } from './RunVisualEffects'
import { selectRelationshipSummary, selectVisualStale, selectVisualStopped } from './exchangePresentation'
import { useStopManagedRunMutation } from '../../shared/api/query'
import type { RunGraphRecord } from './types'
import { RunHistory } from '../workflow-board/RunHistory'
import { RunBoardSelection } from '../workflow-board/RunBoardSelection'
import './runGraph.css'

const RunFactNode = memo(function RunFactNode({ data }: NodeProps<RunViewNode>) {
  const fact = useRunGraphNode(data.workflowNodeId)
  const stale = useRunGraphSelection(selectVisualStale)
  const stopped = useRunGraphSelection(selectVisualStopped)
  const view = presentRunGraphNode(fact, { stale, stopped })
  const presentation = useGraphPresentationStore()
  const selected = useGraphPresentation((state) => state.selectedNodeIds.has(data.workflowNodeId))
  const role = data.productRole === 'unknown' ? 'Role unavailable' : data.productRole === 'orchestrator' ? 'Orchestrator' : 'Worker'
  return <article className={`run-graph-node${selected ? ' run-graph-node-selected' : ''}`}>
    <Handle id="in" type="target" position={Position.Left} isConnectable={false} />
    <WorkflowNodeCard className="run-graph-node-select" title={data.workflowNodeId}
      subtitle={`${data.isEntry ? 'Entry · ' : ''}${role}`} statusLabel={view.lifecycle} tone={view.tone}
      icon={data.productRole === 'orchestrator' ? 'workflow' : 'bot'} meta={view.activity}
      selected={selected} working={false} ariaLabel={`Inspect node ${data.workflowNodeId}: ${view.lifecycle}; ${view.activity}`}
      onSelect={() => { presentation.getState().setSelectedNodeIds(new Set([data.workflowNodeId])); presentation.getState().setFocusedEdgeId(undefined); presentation.getState().setFocusedExchangeKey(undefined) }} />
    {fact && (fact.attention.pendingInteractionCount > 0 || fact.attention.unsettledReviewCount > 0 || fact.attention.cleanupPending)
      ? <small className="run-graph-attention">{fact.attention.pendingInteractionCount} pending · {fact.attention.unsettledReviewCount} unsettled reviews{fact.attention.cleanupPending ? ' · Cleanup pending' : ''}</small> : null}
    <Handle id="out" type="source" position={Position.Right} isConnectable={false} />
  </article>
})
const RunRelationship = memo(function RunRelationship(props: EdgeProps<RunViewEdge>) {
  const summary = useRunGraphSelection(useCallback((record: RunGraphRecord) => selectRelationshipSummary(record, props.id), [props.id]))
  const cue = useGraphPresentation((state) => state.exchangeCues.find((item) => item.relationshipId === props.id))
  const kind = props.data?.kind === 'approval' ? 'Approval' : 'Execution'
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX: props.sourceX, sourceY: props.sourceY,
    targetX: props.targetX, targetY: props.targetY, sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition, offset: props.data?.kind === 'approval' ? 45 : 20 })
  return <g data-run-relationship={props.id}><title>{kind}: {props.source} → {props.target}{summary ? `. ${summary}` : ''}</title>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} labelX={labelX} labelY={labelY}
    label={summary ? `${kind} · ${summary}` : kind}
    style={{ strokeDasharray: props.data?.kind === 'approval' ? '5 4' : undefined }} />
    {cue ? <g key={cue.token} className="run-graph-cue" aria-hidden="true" pointerEvents="none">
      <path d={path} className="run-graph-cue-line" />
      <text x={labelX} y={labelY - 18} textAnchor="middle" className="run-graph-cue-caption">{cue.caption}</text>
    </g> : null}
  </g>
})
const nodeTypes = { 'run-fact': RunFactNode }
const edgeTypes = { 'run-relationship': RunRelationship }
const fitViewOptions = { padding: 0.2 }

const ImmutableCanvas = memo(function ImmutableCanvas() {
  const canvas = useRef<HTMLDivElement>(null)
  const updateDetail = useCallback((_event: unknown, viewport: { zoom: number }) => {
    const level = viewport.zoom < 0.6 ? 'coarse' : 'normal'
    if (canvas.current && canvas.current.dataset.detail !== level) canvas.current.dataset.detail = level
  }, [])
  const topology = useRunGraphSelection(selectGraphTopology)
  const [project] = useState(createRunViewTopologyProjector)
  const graph = useMemo(() => topology ? project(topology) : undefined, [topology, project])
  const presentation = useGraphPresentationStore()
  if (!graph) return null
  return <div ref={canvas} className="run-graph-canvas" data-testid="immutable-run-canvas">
    <ReactFlow<RunViewNode, RunViewEdge> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      onMove={updateDetail} onMoveEnd={updateDetail} fitView fitViewOptions={fitViewOptions} aria-label="Immutable Run graph"
      onPaneClick={() => { presentation.getState().setSelectedNodeIds(new Set()); presentation.getState().setFocusedEdgeId(undefined); presentation.getState().setFocusedExchangeKey(undefined) }}
      onEdgeClick={(_event, edge) => { presentation.getState().setFocusedEdgeId(edge.id); presentation.getState().setSelectedNodeIds(new Set()); presentation.getState().setFocusedExchangeKey(undefined) }}>
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>
})

function GraphStatus() {
  const { scope, retry } = useRunGraphContext()
  const stop = useStopManagedRunMutation()
  const transport = useRunGraphSelection(selectGraphTransport)
  const graphRun = useRunGraphSelection(selectGraphRun)
  const legacy = useRunGraphSelection(selectLegacyRun)
  const run = graphRun ?? (legacy?.kind === 'legacy-run-current' ? { ...legacy.run, cleanupPending: legacy.cleanupPending, stopRequested: null } : undefined)
  const phase = transport?.phase ?? 'loading'
  return <header className="run-graph-header">
    <div><h2>Run status</h2><p>Immutable version <code>{scope.workflowVersionId}</code></p></div>
    <div>
      {run ? <p>{run.executionState} · {run.outcome}{run.stopRequested ? ' · Stop requested' : ''}
        {run.cleanupPending ? ' · Cleanup pending' : ''}</p> : null}
      <p>{phase === 'live' ? 'Synchronized' : phase === 'loading' ? 'Loading confirmed facts…'
        : phase === 'catching-up' ? 'Synchronizing; showing last confirmed facts'
          : phase === 'resetting' ? 'Resetting synchronization; showing last confirmed facts'
            : phase === 'denied' ? 'Run access unavailable' : 'Updates unavailable; showing last confirmed facts'}</p>
      {transport?.reason ? <small>{transport.reason}</small> : null}
      {phase === 'error' || phase === 'stale' ? <Button variant="secondary" onClick={retry}>Retry synchronization</Button> : null}
      {run && (run.executionState !== 'completed' || run.cleanupPending)
        ? <Button variant="secondary" disabled={stop.isPending} onClick={() => stop.mutate({
          workspaceId: scope.workspaceId, runId: scope.runId, commandId: crypto.randomUUID(),
        })}>{stop.isPending ? 'Requesting Stop…' : 'Stop Run'}</Button> : null}
      {stop.isSuccess ? <small>{run?.executionState === 'completed' && !run.cleanupPending
        ? 'Run completed; cleanup settled.' : `Stop ${stop.data.status}. Native process exit is not yet verified.`}</small> : null}
      {stop.isError ? <small role="alert">Stop failed: {stop.error.message}</small> : null}
    </div>
  </header>
}

function RunNodeSelector() {
  const topology = useRunGraphSelection(selectGraphTopology)
  const selected = useGraphPresentation((state) => state.selectedNodeIds.values().next().value as string | undefined)
  const presentation = useGraphPresentationStore()
  return <Select className="run-graph-field" label="Inspect any pinned node" value={selected ?? ''} options={[
    { value: '', label: 'Select a node' },
    ...(selected && !topology?.nodes.some((node) => node.workflowNodeId === selected) ? [{ value: selected, label: `Selected node unavailable: ${selected}` }] : []),
    ...(topology?.nodes.map((node) => ({ value: node.workflowNodeId, label: `${node.workflowNodeId}${node.workflowNodeId === topology.entryNodeId ? ' · Entry' : ''}` })) ?? []),
  ]} onChange={(event) => {
    presentation.getState().setSelectedNodeIds(new Set(event.target.value ? [event.target.value] : []))
    presentation.getState().setFocusedEdgeId(undefined); presentation.getState().setFocusedExchangeKey(undefined)
  }} />
}

function RunInspector() {
  const id = useGraphPresentation((state) => state.selectedNodeIds.values().next().value as string | undefined)
  const edgeId = useGraphPresentation((state) => state.focusedEdgeId)
  const node = useRunGraphNode(id ?? '')
  const topology = useRunGraphSelection(selectGraphTopology)
  const metadata = topology?.nodes.find((item) => item.workflowNodeId === id)
  const edge = topology?.relationships.find((item) => item.relationshipId === edgeId)
  const stale = useRunGraphSelection(selectVisualStale)
  const stopped = useRunGraphSelection(selectVisualStopped)
  const view = presentRunGraphNode(node, { stale, stopped })
  return <aside className="run-graph-inspector" aria-label="Run fact inspector">
    <h3>{id ? 'Node facts' : edge ? 'Relationship' : 'Run facts'}</h3>
    {metadata ? <><dl>
      <dt>Node</dt><dd>{metadata.workflowNodeId}</dd><dt>Agent</dt><dd>{metadata.agentId}</dd>
      <dt>Pinned configuration</dt><dd>{metadata.agentConfigurationVersionId}</dd>
      <dt>Entry</dt><dd>{topology?.entryNodeId === id ? 'Yes' : 'No'}</dd>
      <dt>Lifecycle</dt><dd>{view.lifecycle}</dd><dt>Current activity</dt><dd>{view.activity}</dd>
      <dt>Attention telemetry</dt><dd>{node?.attention.telemetry ?? 'unknown'}</dd>
      <dt>Cleanup</dt><dd>{node ? node.attention.cleanupPending ? 'Pending' : 'No pending cleanup' : 'Unavailable'}</dd>
      {node?.state.execution ? <><dt>Execution</dt><dd>{node.state.execution.executionId}</dd></> : null}
      {node?.resolution ? <><dt>Resolution</dt><dd>{node.resolution.resolution}</dd>
        <dt>Declared outcome</dt><dd>{node.resolution.outcome ?? 'No outcome recorded'}</dd>
        <dt>Branch ended</dt><dd>{node.resolution.branchEnded ? 'Yes' : 'No'}</dd>
        <dt>Selected execution records</dt><dd>{node.resolution.selectedRelationshipIds.join(', ') || 'None'}</dd>
        <dt>Unselected execution records</dt><dd>{node.resolution.unselectedRelationshipIds.join(', ') || 'None'}</dd></> : null}
    </dl></> : edge ? <dl><dt>ID</dt><dd>{edge.relationshipId}</dd><dt>Kind</dt><dd>{edge.kind}</dd>
      <dt>From</dt><dd>{edge.source}</dd><dt>To</dt><dd>{edge.target}</dd></dl>
      : <p>Select a node or relationship to inspect its confirmed facts.</p>}
    <RunExchangeInspector nodeId={id} relationshipId={edgeId} />
  </aside>
}

function LegacyFacts() {
  const response = useRunGraphSelection(selectLegacyRun)
  if (!response || response.kind !== 'legacy-run-current') return null
  return <section className="run-graph-legacy" aria-label="Legacy Run facts">
    <p>Legacy reader · {response.run.executionState} · {response.run.outcome}</p>
    <p>The legacy read contract does not expose pinned topology. The current draft is not substituted.</p>
    <p>{response.cleanupPending ? 'Cleanup pending.' : 'No pending Run cleanup intent.'} Approval and native settlement remain unconfirmed; current-state checks continue while this view is open.</p>
    <p>Historical activity is not loaded by this view.</p>
    <table><caption>Latest execution attempt per saved node</caption><thead><tr><th>Node</th><th>Execution</th><th>State</th></tr></thead><tbody>
      {response.executions.map((execution) => <tr key={execution.id}><td>{execution.workflowNodeId}</td><td>{execution.id}</td><td>{execution.state}</td></tr>)}
    </tbody></table>
  </section>
}
export function RunGraphContent({ embedded = false }: { embedded?: boolean } = {}) {
  const { scope } = useRunGraphContext()
  const root = useRef<HTMLElement>(null)
  const stale = useRunGraphSelection(selectVisualStale)
  const reader = useRunGraphSelection(selectGraphReader)
  return <section ref={root} data-stale={stale || undefined} className={`run-graph-view${embedded ? ' board-run-facts' : ''}`} aria-label={embedded ? 'Selected Run facts' : 'Read-only Run view'}>
    {embedded ? <RunBoardSelection /> : null}
    <RunVisualEffects root={root} />
    <RunAttentionAnnouncement />
    <GraphStatus />
    {reader === 'graph' ? <RunAttentionTools /> : null}
    {reader === 'graph' ? <div className="run-graph-body">{embedded ? <RunNodeSelector /> : <ImmutableCanvas />}<RunInspector /></div>
      : reader === 'legacy' ? <LegacyFacts /> : null}
    {embedded && reader ? <RunHistory scope={scope} /> : null}
  </section>
}

/** No draft, Agent settings, commands or edit callbacks are accepted at this boundary. */
export function RunGraphView({ scope, embedded = false }: { scope: RunGraphScope; embedded?: boolean }) {
  const key = JSON.stringify([scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId, scope.executionSemanticsVersion])
  return <RunGraphProvider key={key} scope={scope}><GraphPresentationProvider><RunGraphContent embedded={embedded} /></GraphPresentationProvider></RunGraphProvider>
}
