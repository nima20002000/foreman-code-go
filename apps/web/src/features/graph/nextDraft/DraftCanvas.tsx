import { createContext, forwardRef, memo, useContext, useImperativeHandle, useLayoutEffect, useMemo, useState } from 'react'
import { Background, BaseEdge, ConnectionMode, Controls, Handle, MarkerType, MiniMap, NodeResizer, Position, ReactFlow,
  type Edge, type EdgeProps, type NodeChange, type NodeProps } from '@xyflow/react'
import { WorkflowRelationshipSchema, type WorkflowDefinitionV2, type WorkflowRelationship } from '@graphql/contracts/wave25'
import type { Agent } from '@graphql/contracts'
import { WorkflowNodeCard } from '../../../shared/ui/nocturne'
import { createGraphTopologyProjector } from '../topology'
import { GRAPH_NODE_MIN_WIDTH, GRAPH_NODE_MAX_WIDTH, GRAPH_NODE_MIN_HEIGHT, GRAPH_NODE_MAX_HEIGHT } from '../mapper'
import { createGraphGeometryAdapter, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { useGraphPresentation, useGraphPresentationStore } from '../useGraphPresentation'
import type { GraphNode } from '../types'
import { nodeTitle, putRelationship } from './model'
import type { EditGraph } from './AuthoringFields'
import { DraftRunBadge } from '../../workflow-board/DraftRunBadge'
import '@xyflow/react/dist/style.css'

const DraftKey = createContext('')
const Inspect = createContext<(action: () => void) => void>((action) => action())
const handlePositions = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }
const DraftCard = memo(function DraftCard({ id, data, selected }: NodeProps<GraphNode>) {
  const key = useContext(DraftKey), inspect = useContext(Inspect)
  const entry = useGraphDraftStore((state) => state.nextDrafts[key]?.graph.entryNodeId === id)
  const presentation = useGraphPresentationStore()
  return <div className="workflow-agent-node board-draft-node">
    <NodeResizer isVisible={selected} minWidth={GRAPH_NODE_MIN_WIDTH} maxWidth={GRAPH_NODE_MAX_WIDTH} minHeight={GRAPH_NODE_MIN_HEIGHT} maxHeight={GRAPH_NODE_MAX_HEIGHT} handleClassName="workflow-agent-node-resize-handle nodrag" lineClassName="workflow-agent-node-resize-line" />
    {Object.entries(handlePositions).map(([name, position]) => <Handle key={name} id={name} type="source" position={position} />)}
    <WorkflowNodeCard className="workflow-agent-node-button" title={data.label} subtitle={`${entry ? 'Entry · ' : ''}${data.agent.productRole === 'orchestrator' ? 'Orchestrator' : data.agent.productRole === 'coder' ? 'Worker' : 'Role unavailable'}`}
      statusLabel="Draft" icon={data.agent.productRole === 'orchestrator' ? 'workflow' : 'bot'} harness={data.agent.harness ?? data.agent.harnessConfiguration?.harness} selected={selected} working={false}
      meta="Next draft · edits do not change existing Runs" ariaLabel={`Edit node ${data.label}${entry ? ', entry' : ''}`}
      onSelect={() => inspect(() => { presentation.getState().setFocusedNodeId(id); presentation.getState().setFocusedEdgeId(undefined) })} />
    <DraftRunBadge nodeId={id} agentId={data.agent.id} />
  </div>
})

type DraftEdge = Edge<{ kind: WorkflowRelationship['kind']; offset: number; label: string }>
const TypedEdge = memo(function TypedEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps<DraftEdge>) {
  const dx = targetX - sourceX, dy = targetY - sourceY, length = Math.max(1, Math.hypot(dx, dy))
  const offset = data?.offset ?? 0, cx = (sourceX + targetX) / 2 - dy / length * offset, cy = (sourceY + targetY) / 2 + dx / length * offset
  const path = `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`
  return <g className={`next-draft-edge next-draft-edge-${data?.kind ?? 'execution'}`}>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={28} style={{ strokeDasharray: data?.kind === 'approval' ? '5 4' : undefined }} />
    <text x={(sourceX + 2 * cx + targetX) / 4} y={(sourceY + 2 * cy + targetY) / 4 - 6} textAnchor="middle">{data?.label}</text>
  </g>
})
const nodeTypes = { agent: DraftCard }, edgeTypes = { typed: TypedEdge }
export type DraftCanvasHandle = { flush(): void; cancel(): void }

/** Draft geometry and typed records only. Run badges are separate cache observers. */
export const DraftCanvas = forwardRef<DraftCanvasHandle, {
  draftKey: string; graph: WorkflowDefinitionV2; agents: readonly Agent[]; kind: WorkflowRelationship['kind']
  change: EditGraph; geometry: (changes: GraphGeometryChange[]) => void; pending: (pending: boolean) => void
  report: (error: unknown) => void; inspect?: (action: () => void) => void
}>(function DraftCanvas({ draftKey, graph, agents, kind, change, geometry, pending, report, inspect = (action) => action() }, ref) {
  const [project] = useState(() => createGraphTopologyProjector())
  const topology = useMemo(() => project(graph, agents), [project, graph, agents])
  const [adapter] = useState(() => createGraphGeometryAdapter(topology.nodes))
  const [nodes, setNodes] = useState(topology.nodes)
  const selectedIds = useGraphPresentation((state) => state.selectedNodeIds)
  const presentation = useGraphPresentationStore()
  useLayoutEffect(() => { setNodes(adapter.reconcile(topology.nodes, selectedIds)) }, [adapter, topology.nodes, selectedIds])
  const flush = () => {
    const changes = adapter.flush()
    if (changes.length) geometry(changes)
    pending(false)
  }
  useImperativeHandle(ref, () => ({ flush, cancel: () => { setNodes(adapter.cancel()); pending(false) } }))
  const edges = useMemo<DraftEdge[]>(() => {
    const counts = new Map<string, number>()
    return graph.edges.map((edge) => {
      const pair = JSON.stringify([edge.source, edge.target].sort()), count = counts.get(pair) ?? 0
      const offset = (count % 2 ? 48 : -48) * Math.ceil(count / 2) * (edge.source < edge.target ? 1 : -1)
      counts.set(pair, count + 1)
      return { ...edge, type: 'typed', markerEnd: { type: MarkerType.ArrowClosed },
        ariaLabel: `${edge.kind}: ${nodeTitle(graph, edge.source)} to ${nodeTitle(graph, edge.target)}, record ${edge.id}`,
        data: { kind: edge.kind, offset, label: `${edge.kind === 'approval' ? 'Approval' : 'Execution'}${edge.label ? ` · ${edge.label}` : ''}` } }
    })
  }, [graph])
  const onNodesChange = (changes: NodeChange<GraphNode>[]) => {
    const nextSelection = new Set(presentation.getState().selectedNodeIds)
    for (const item of changes) if (item.type === 'select') {
      if (item.selected) nextSelection.add(item.id); else nextSelection.delete(item.id)
    }
    presentation.getState().setSelectedNodeIds(nextSelection)
    const result = adapter.update(changes)
    setNodes(result.nodes); pending(result.pending)
    if (result.finished) flush()
  }
  return <DraftKey.Provider value={draftKey}><Inspect.Provider value={inspect}>
    <div className="next-draft-canvas board-draft-canvas" aria-label="Editable workflow graph">
      <ReactFlow<GraphNode, DraftEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} connectionMode={ConnectionMode.Loose} deleteKeyCode={null} fitView
        onNodeClick={(_, node) => inspect(() => { presentation.getState().setFocusedNodeId(node.id); presentation.getState().setFocusedEdgeId(undefined) })}
        onEdgeClick={(_, edge) => inspect(() => { presentation.getState().setFocusedEdgeId(edge.id); presentation.getState().setFocusedNodeId(undefined) })}
        onPaneClick={() => inspect(() => { presentation.getState().setFocusedNodeId(undefined); presentation.getState().setFocusedEdgeId(undefined) })}
        onConnect={(connection) => {
          try { change((value) => putRelationship(value, WorkflowRelationshipSchema.parse({ ...connection, id: `relationship-${crypto.randomUUID()}`, kind }))) }
          catch (error) { report(error) }
        }}>
        <Background /><Controls showInteractive={false} /><MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  </Inspect.Provider></DraftKey.Provider>
})
