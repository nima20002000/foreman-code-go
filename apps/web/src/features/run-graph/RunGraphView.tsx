import { memo, useMemo, useState } from 'react'
import {
  Background, BaseEdge, Controls, Handle, Position, ReactFlow, getSmoothStepPath,
  type NodeProps, type EdgeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { RunGraphScope } from '@graphql/contracts/wave25'
import { Button, WorkflowNodeCard } from '../../shared/ui/nocturne'
import { GraphPresentationProvider } from '../graph/GraphPresentation'
import { useGraphPresentation, useGraphPresentationStore } from '../graph/useGraphPresentation'
import { RunGraphProvider } from './RunGraphProvider'
import { useRunGraphContext } from './context'
import { useRunGraphNode, useRunGraphSelection } from './hooks'
import {
  selectGraphTopology, selectGraphRun, selectGraphReader, selectGraphTransport, selectGraphExchanges,
  selectLegacyRun,
} from './cache'
import { presentRunGraphNode } from './presentation'
import { createRunViewTopologyProjector, type RunViewNode, type RunViewEdge } from './topology'
import './runGraph.css'

const RunFactNode = memo(function RunFactNode({ data }: NodeProps<RunViewNode>) {
  const fact = useRunGraphNode(data.workflowNodeId)
  const view = presentRunGraphNode(fact)
  const presentation = useGraphPresentationStore()
  const selected = useGraphPresentation((state) => state.selectedNodeIds.has(data.workflowNodeId))
  const role = data.productRole === 'unknown' ? 'Role unavailable' : data.productRole === 'orchestrator' ? 'Orchestrator' : 'Worker'
  return <article className={`run-graph-node${selected ? ' run-graph-node-selected' : ''}`}>
    <Handle id="in" type="target" position={Position.Left} isConnectable={false} />
    <WorkflowNodeCard className="run-graph-node-select" title={data.workflowNodeId}
      subtitle={`${data.isEntry ? 'Entry · ' : ''}${role}`} statusLabel={view.lifecycle} tone={view.tone}
      icon={data.productRole === 'orchestrator' ? 'workflow' : 'bot'} meta={view.activity}
      selected={selected} working={false} ariaLabel={`Inspect node ${data.workflowNodeId}`}
      onSelect={() => { presentation.getState().setSelectedNodeIds(new Set([data.workflowNodeId])); presentation.getState().setFocusedEdgeId(undefined) }} />
    {fact && (fact.attention.pendingInteractionCount > 0 || fact.attention.unsettledReviewCount > 0 || fact.attention.cleanupPending)
      ? <small className="run-graph-attention">{fact.attention.pendingInteractionCount} pending · {fact.attention.unsettledReviewCount} unsettled reviews{fact.attention.cleanupPending ? ' · Cleanup pending' : ''}</small> : null}
    <Handle id="out" type="source" position={Position.Right} isConnectable={false} />
  </article>
})
const RunRelationship = memo(function RunRelationship(props: EdgeProps<RunViewEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX: props.sourceX, sourceY: props.sourceY,
    targetX: props.targetX, targetY: props.targetY, sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition, offset: props.data?.kind === 'approval' ? 45 : 20 })
  return <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} labelX={labelX} labelY={labelY}
    label={props.data?.kind === 'approval' ? 'Approval' : 'Execution'}
    style={{ strokeDasharray: props.data?.kind === 'approval' ? '5 4' : undefined }} />
})
const nodeTypes = { 'run-fact': RunFactNode }
const edgeTypes = { 'run-relationship': RunRelationship }
const fitViewOptions = { padding: 0.2 }

const ImmutableCanvas = memo(function ImmutableCanvas() {
  const topology = useRunGraphSelection(selectGraphTopology)
  const [project] = useState(createRunViewTopologyProjector)
  const graph = useMemo(() => topology ? project(topology) : undefined, [topology, project])
  const presentation = useGraphPresentationStore()
  if (!graph) return null
  return <div className="run-graph-canvas" data-testid="immutable-run-canvas">
    <ReactFlow<RunViewNode, RunViewEdge> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      fitView fitViewOptions={fitViewOptions} aria-label="Immutable Run graph"
      onPaneClick={() => { presentation.getState().setSelectedNodeIds(new Set()); presentation.getState().setFocusedEdgeId(undefined) }}
      onEdgeClick={(_event, edge) => { presentation.getState().setFocusedEdgeId(edge.id); presentation.getState().setSelectedNodeIds(new Set()) }}>
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>
})

function GraphStatus() {
  const { scope, retry } = useRunGraphContext()
  const transport = useRunGraphSelection(selectGraphTransport)
  const run = useRunGraphSelection(selectGraphRun)
  const phase = transport?.phase ?? 'loading'
  return <header className="run-graph-header">
    <div><h2>Run graph</h2><p>Immutable version <code>{scope.workflowVersionId}</code></p></div>
    <div role="status" aria-live="polite">
      {run ? <p>{run.executionState} · {run.outcome}{run.stopRequested ? ' · Stop requested' : ''}
        {run.cleanupPending ? ' · Cleanup pending' : ''}</p> : null}
      <p>{phase === 'live' ? 'Synchronized' : phase === 'loading' ? 'Loading confirmed facts…'
        : phase === 'catching-up' ? 'Synchronizing; showing last confirmed facts'
          : phase === 'resetting' ? 'Resetting synchronization; showing last confirmed facts'
            : phase === 'denied' ? 'Run access unavailable' : 'Updates unavailable; showing last confirmed facts'}</p>
      {transport?.reason ? <small>{transport.reason}</small> : null}
      {phase === 'error' || phase === 'stale' ? <Button variant="secondary" onClick={retry}>Retry synchronization</Button> : null}
    </div>
  </header>
}

function RunInspector() {
  const id = useGraphPresentation((state) => state.selectedNodeIds.values().next().value as string | undefined)
  const edgeId = useGraphPresentation((state) => state.focusedEdgeId)
  const node = useRunGraphNode(id ?? '')
  const topology = useRunGraphSelection(selectGraphTopology)
  const exchanges = useRunGraphSelection(selectGraphExchanges)
  const metadata = topology?.nodes.find((item) => item.workflowNodeId === id)
  const edge = topology?.relationships.find((item) => item.relationshipId === edgeId)
  const view = presentRunGraphNode(node)
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
      {node?.resolution ? <><dt>Resolution</dt><dd>{node.resolution.resolution}</dd></> : null}
    </dl></> : edge ? <dl><dt>ID</dt><dd>{edge.relationshipId}</dd><dt>Kind</dt><dd>{edge.kind}</dd>
      <dt>From</dt><dd>{edge.source}</dd><dt>To</dt><dd>{edge.target}</dd></dl>
      : <p>Select a node or relationship to inspect its confirmed facts.</p>}
    <h3>Exchanges</h3>
    {exchanges?.interactions.filter((item) => !id || item.requester.workflowNodeId === id || item.reviewer?.workflowNodeId === id)
      .map((item) => <details key={item.interactionId}><summary>{item.interactionId} · {item.status}</summary>
        <dl><dt>Decision</dt><dd>{item.decision ?? 'Not decided'}</dd><dt>Native delivery</dt><dd>{item.deliveryState}</dd>
          <dt>Worker resumption</dt><dd>{item.resumeState}</dd></dl></details>)}
    {exchanges?.reviews.filter((item) => !id || item.requester.workflowNodeId === id || item.reviewer.workflowNodeId === id)
      .map((item) => <details key={item.reviewJobId}><summary>{item.reviewJobId} · {item.state}</summary>
        <dl><dt>Native cleanup</dt><dd>{item.nativeCleanup}</dd><dt>Credential cleanup</dt><dd>{item.credentialCleanup}</dd></dl></details>)}
    <h3>Accepted input receipts</h3>
    {exchanges?.inputBindings.filter((item) => !id || item.recipient.workflowNodeId === id || item.sender.workflowNodeId === id)
      .map((item) => <details key={item.bindingId}><summary>{item.relationshipId} · Input {item.inputOrdinal + 1}</summary>
        <dl><dt>Sender</dt><dd>{item.sender.executionId}</dd><dt>Recipient</dt><dd>{item.recipient.executionId}</dd>
          <dt>Accepted result digest</dt><dd>{item.acceptedResultDigest}</dd><dt>Input digest</dt><dd>{item.recipientInputDigest}</dd></dl></details>)}
  </aside>
}

function LegacyFacts() {
  const response = useRunGraphSelection(selectLegacyRun)
  if (!response) return null
  return <section className="run-graph-legacy" aria-label="Legacy Run facts">
    <p>Legacy reader · {response.run.executionState} · {response.run.outcome}</p>
    <p>The legacy read contract does not expose pinned topology. The current draft is not substituted.</p>
    <table><thead><tr><th>Node</th><th>Execution</th><th>State</th></tr></thead><tbody>
      {response.executions.map((execution) => <tr key={execution.id}><td>{execution.workflowNodeId}</td><td>{execution.id}</td><td>{execution.state}</td></tr>)}
    </tbody></table>
  </section>
}
function RunGraphContent() {
  const reader = useRunGraphSelection(selectGraphReader)
  return <section className="n-theme run-graph-view" aria-label="Read-only Run view">
    <GraphStatus />
    {reader === 'graph' ? <div className="run-graph-body"><ImmutableCanvas /><RunInspector /></div>
      : reader === 'legacy' ? <LegacyFacts /> : null}
  </section>
}

/** No draft, Agent settings, commands or edit callbacks are accepted at this boundary. */
export function RunGraphView({ scope }: { scope: RunGraphScope }) {
  const key = JSON.stringify([scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId, scope.executionSemanticsVersion])
  return <RunGraphProvider key={key} scope={scope}><GraphPresentationProvider><RunGraphContent /></GraphPresentationProvider></RunGraphProvider>
}
