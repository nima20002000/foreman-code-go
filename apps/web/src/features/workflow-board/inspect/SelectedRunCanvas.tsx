import { memo, useCallback, useMemo } from 'react'
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import type { RepeatGraphScopeV3 } from '@graphql/contracts/wave25'
import { Alert, Button } from '../../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../auth/useProtectedAccessError'
import { useWorkflowBoard } from '../context'
import { useSelectedRunRecord } from '../runFacts'
import { useRunVersionQuery } from './queries'
import { pinnedNodeStates, pinnedTopology } from './pinnedTopology'
import './inspection.css'

type RunNode = Node<{
  label: string; agentId: string; configurationId: string; entry: boolean
  blockId?: string; recorded: string; selected: boolean; inspect(): void
}, 'pinnedRunNode'>
const PinnedRunNode = memo(function PinnedRunNode({ data }: NodeProps<RunNode>) {
  return <div className={`pinned-run-node${data.selected ? ' is-selected' : ''}`}>
    <Handle type="target" position={Position.Left} id="in" isConnectable={false} />
    <button type="button" className="nodrag nopan" aria-pressed={data.selected}
      aria-label={`Inspect Run node ${data.label}`} onClick={data.inspect}>
      <strong>{data.label}</strong>
      <span>{data.entry ? 'Entry · ' : ''}{data.blockId ? `Repeat block ${data.blockId}` : 'Saved Run node'}</span>
      <span>{data.recorded}</span>
    </button>
    <Handle type="source" position={Position.Right} id="out" isConnectable={false} />
  </div>
})
const nodeTypes = { pinnedRunNode: PinnedRunNode }
const fitViewOptions = { padding: 0.25, minZoom: 0.3, maxZoom: 1 }
const proOptions = { hideAttribution: true }

/** Mounted in the EXISTING canvas region. The editor owner and buffered draft
 * stay mounted beside it, but neither draft nodes nor current Agent settings
 * enter this read-only topology. URL pins are verified by the /version service. */
export function SelectedRunCanvas({ scope }: { scope: RepeatGraphScopeV3 }) {
  const board = useWorkflowBoard()!
  const query = useRunVersionQuery(scope)
  const denied = useProtectedAccessError(query)
  const version = query.isError || denied ? undefined : query.data?.version
  const record = useSelectedRunRecord()
  const topology = useMemo(() => version ? pinnedTopology(version) : undefined, [version])
  const states = useMemo(() => pinnedNodeStates(record), [record])
  const inspectNode = useCallback((nodeId: string) => {
    board.selectInspection({ runNodeId: nodeId }); board.openRuns()
  }, [board.selectInspection, board.openRuns])
  const nodes = useMemo<RunNode[]>(() => topology?.nodes.map((node) => {
    const state = states.get(node.id)
    return { id: node.id, type: 'pinnedRunNode', position: node.position,
      data: { ...node, selected: board.inspection.runNodeId === node.id, inspect: () => inspectNode(node.id),
        recorded: !record ? 'Current status unavailable' : !state ? 'No activation in the bounded current cut' :
          `${state.label}${state.occurrenceIndex ? ` · repetition ${state.occurrenceIndex}` : ''}${state.attempt ? ` · attempt ${state.attempt}` : ''}` } }
  }) ?? [], [topology, states, record, board.inspection.runNodeId, inspectNode])
  const edges = useMemo<Edge[]>(() => topology?.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, sourceHandle: 'out', targetHandle: 'in',
    type: 'smoothstep', label: edge.label || (edge.kind === 'approval' ? 'Approval' : 'Handoff'),
    selected: edge.id === board.inspection.runRelationshipId,
    ariaLabel: `${edge.kind} relationship ${edge.id} from ${edge.source} to ${edge.target}`,
    markerEnd: { type: MarkerType.ArrowClosed },
    ...(edge.kind === 'approval' ? { style: { strokeDasharray: '5 4' } } : {}),
  })) ?? [], [topology, board.inspection.runRelationshipId])
  const missingNode = !!version && !!board.inspection.runNodeId
    && !version.definition.nodes.some((node) => node.id === board.inspection.runNodeId)
  return <section className="next-draft-canvas board-draft-canvas pinned-run-canvas" aria-label="Selected Run pinned topology">
    <header className="pinned-run-heading">
      <strong>{version?.definition.name ?? 'Selected Run'} · immutable saved topology</strong>
      <span>Run <code>{scope.runId}</code> · version <code>{scope.workflowVersionId}</code> · read only</span>
      <Button size="sm" variant="ghost" onClick={() => board.openRuns()}>Inspect Run</Button>
      <Button size="sm" variant="ghost" onClick={() => board.selectRun()}>Return to draft</Button>
    </header>
    {query.isPaused ? <p role="status">Pinned topology refresh is paused. Any retained topology is a previously verified saved version.</p>
      : query.isPending ? <p role="status">Loading this Run’s exact saved topology…</p> : null}
    {query.isError || denied ? <Alert tone="warning" title="The selected Run topology is unavailable.">
      The current draft is not shown as historical fact.
      {!denied ? <Button size="sm" onClick={() => void query.refetch()}>Retry pinned topology</Button> : null}
    </Alert> : null}
    {missingNode ? <Alert tone="warning" title="The linked node is not in this Run’s saved version.">
      <Button size="sm" onClick={() => board.selectInspection({})}>Clear missing node selection</Button>
    </Alert> : null}
    {version ? <div className="pinned-run-flow">
      <ReactFlow<RunNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable
        elementsSelectable deleteKeyCode={null} onlyRenderVisibleElements
        onEdgeClick={(_, edge) => { board.selectInspection({ runRelationshipId: edge.id }); board.openRuns() }}
        fitView fitViewOptions={fitViewOptions} proOptions={proOptions} minZoom={0.1} maxZoom={1.6}
        aria-label="Run graph canvas">
        <Background color="var(--border)" gap={24} size={1} />
        <Controls position="bottom-left" showInteractive={false} fitViewOptions={fitViewOptions} />
      </ReactFlow>
    </div> : null}
    {version ? <p className="pinned-run-footnote">{version.definition.repeat
      ? 'Configured repeat blocks belong to this saved version. Node badges show the bounded current cut; inspect a repetition for its recorded facts.'
      : 'No repeat block is configured in this saved version. Inspect execution attempts without synthetic repetition rounds.'}</p> : null}
  </section>
}
