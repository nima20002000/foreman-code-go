import { memo, useMemo } from 'react'
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, type EdgeProps, type NodeProps } from '@xyflow/react'
import { AgentNodeView } from '../../shared/ui/nocturne/Canvas'
import { SignalEdgeShape } from '../graph/SignalEdgeShape'
import { savedEdgeCurve } from './curve'
import { projectRunBoard, READ_ONLY_FLOW_PROPS, type AvailableRunBoardSnapshot, type SavedBoardEdge, type SavedBoardNode } from './model'
import '@xyflow/react/dist/style.css'
import '../../shared/ui/nocturne/canvas.css'
import './runBoard.css'

const sides = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const
const SavedAgent = memo(function SavedAgent({ data }: NodeProps<SavedBoardNode>) {
  return <>
    {/* AgentNodeView has a button core. This static rendering has one accessible
        React Flow image wrapper instead of a misleading, focusable no-op button. */}
    <div className="run-board-node-visual" aria-hidden="true" inert>
      <AgentNodeView className="run-board-agent" name={data.snapshot.name} harnessLabel="" statusLabel="Saved" />
    </div>
    {/* Unlike the authoring AgentHandles, every saved target side must resolve. */}
    {sides.flatMap((side) => (['source', 'target'] as const).map((type) =>
      <Handle key={`${type}:${side}`} id={side} type={type} position={side} isConnectable={false}
        className="run-board-handle" aria-hidden="true" />))}
  </>
})
const SavedConnection = memo(function SavedConnection(props: EdgeProps<SavedBoardEdge>) {
  const edge = props.data?.snapshot
  if (!edge) return null
  const curve = savedEdgeCurve({ ...props, lane: props.data?.lane ?? 0, loop: props.source === props.target })
  return <g>
    <title>{edge.label || (edge.kind === 'approval' ? 'Approval' : 'Handoff')}</title>
    <SignalEdgeShape id={props.id} curve={curve} kind={edge.kind} label={edge.label} showLabel={Boolean(edge.label)} />
  </g>
})
const nodeTypes = { savedBoardNode: SavedAgent }, edgeTypes = { savedBoardEdge: SavedConnection }
const fitViewOptions = { padding: 0.2, minZoom: 0.02, maxZoom: 1 }
const proOptions = { hideAttribution: true }

/** A private React Flow store, even when mounted beneath an editor's provider. */
export function RunBoardCanvas({ snapshot }: { snapshot: AvailableRunBoardSnapshot }) {
  const { nodes, edges } = useMemo(() => projectRunBoard(snapshot), [snapshot])
  return <div className="run-board-canvas" data-testid="run-board-canvas" onKeyDown={(event) => {
    // History keystrokes must not bubble into an ancestor's authoring shortcuts.
    event.stopPropagation()
    if (event.key === 'Delete' || event.key === 'Backspace' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) event.preventDefault()
  }}>
    <ReactFlowProvider>
      <ReactFlow<SavedBoardNode, SavedBoardEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        {...READ_ONLY_FLOW_PROPS} fitView fitViewOptions={fitViewOptions} minZoom={0.02} maxZoom={2}
        proOptions={proOptions} preventScrolling={false} aria-label="Saved Run graph"
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Saved agent, read only.', 'edge.a11yDescription.default': 'Saved connection, read only.' }}>
        <Background color="var(--border)" gap={24} size={1} />
        <Controls showInteractive={false} fitViewOptions={fitViewOptions} aria-label="Run view controls" />
      </ReactFlow>
    </ReactFlowProvider>
  </div>
}
