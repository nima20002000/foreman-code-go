import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Background, ConnectionMode, MarkerType, MiniMap, ReactFlow,
  type Connection, type IsValidConnection, type NodeChange, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AgentMinimapDot, AgentNode, HandoffEdge } from './GraphElements'
import { GraphGeometryContext } from './graphContexts'
import { createGraphGeometryAdapter, type GraphGeometryChange } from './geometry'
import { AGENT_HANDOFF_EDGE_TYPE } from './mapper'
import { useGraphPresentation } from './useGraphPresentation'
import { useGraphEvent } from './useGraphEvent'
import type { GraphNode, GraphEdge, GraphProjection } from './types'

const nodeTypes = { agent: AgentNode }
const edgeTypes = { [AGENT_HANDOFF_EDGE_TYPE]: HandoffEdge }
const fitViewOptions = { padding: 0.2, minZoom: 0.7, maxZoom: 1.1 }
const proOptions = { hideAttribution: true }
const defaultEdgeOptions = {
  type: AGENT_HANDOFF_EDGE_TYPE, selectable: false, focusable: false,
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--n-border-strong)' },
}
const minimapClass = (node: { selected?: boolean }) => node.selected ? 'workflow-graph-minimap-node-selected' : 'workflow-graph-minimap-node'

export type GraphCanvasHandle = {
  flush: () => void
  cancel: () => void
  hasPending: () => boolean
  getNodes: () => GraphNode[]
}

export type GraphCanvasProps = {
  topology: GraphProjection
  departing: GraphProjection
  theme: string
  geometryRef?: Ref<GraphCanvasHandle>
  readOnly?: boolean
  onGeometryStart: (dirty: boolean) => void
  onGeometryCommit: (changes: readonly GraphGeometryChange[]) => void
  onGeometryCancel: () => void
  onConnect?: (connection: Connection) => void
  isValidConnection?: IsValidConnection
  onPaneClick?: () => void
  onInit?: (instance: ReactFlowInstance<GraphNode, GraphEdge>) => void
}

/**
 * Stable canvas / future read-only Run mount. No requests, Run data, draft writes,
 * animation clocks, or workflow scheduling here. Geometry stays local until flush.
 */
export const GraphCanvas = memo(function GraphCanvas({
  topology, departing, theme, geometryRef, readOnly = false,
  onGeometryStart, onGeometryCommit, onGeometryCancel, onConnect, isValidConnection, onPaneClick, onInit,
}: GraphCanvasProps) {
  const selectedIds = useGraphPresentation((state) => state.selectedNodeIds)
  const [adapter] = useState(() => createGraphGeometryAdapter(topology.nodes))
  const [nodes, setNodes] = useState(topology.nodes)
  const gesturing = useRef(false)
  const dirtyNotified = useRef(false)
  const cancelled = useRef(false)

  const begin = useGraphEvent((dirty = false) => {
    if (readOnly || cancelled.current) return
    if (!gesturing.current) {
      gesturing.current = true
      onGeometryStart(false)
    }
    if (dirty && !dirtyNotified.current) {
      dirtyNotified.current = true
      onGeometryStart(true)
    }
  })
  const startDrag = useCallback(() => { cancelled.current = false; begin() }, [begin])
  const flush = useGraphEvent(() => {
    const changes = adapter.flush()
    if (!gesturing.current && changes.length === 0) return
    gesturing.current = false
    dirtyNotified.current = false
    if (changes.length > 0 && !readOnly) onGeometryCommit(changes)
    else onGeometryCancel()
  })
  const cancel = useGraphEvent(() => {
    const wasGesturing = gesturing.current
    if (wasGesturing) cancelled.current = true
    gesturing.current = false
    dirtyNotified.current = false
    setNodes(adapter.cancel())
    if (wasGesturing) onGeometryCancel()
  })
  useImperativeHandle(geometryRef, () => ({ flush, cancel,
    hasPending: adapter.hasPending, getNodes: adapter.getNodes }), [adapter, flush, cancel])

  useLayoutEffect(() => {
    setNodes(adapter.reconcile(topology.nodes, selectedIds))
  }, [adapter, topology.nodes, selectedIds])

  useEffect(() => {
    // Local-only flush: never perform a network save during navigation or teardown.
    const finish = () => flush()
    window.addEventListener('pagehide', finish)
    window.addEventListener('beforeunload', finish)
    return () => {
      window.removeEventListener('pagehide', finish)
      window.removeEventListener('beforeunload', finish)
      flush()
    }
  }, [flush])

  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => {
    const accepted = readOnly || cancelled.current ? changes.filter((change) => change.type === 'dimensions' && change.resizing === undefined) : changes
    const result = adapter.update(accepted)
    if (result.pending) begin(true)
    setNodes(result.nodes)
    if (result.finished) flush()
  }, [adapter, begin, flush, readOnly])
  const geometry = useMemo(() => ({
    readOnly,
    beginResize: () => { cancelled.current = false; begin(); adapter.beginResize() },
    finishResize: (id: string, width: number, height: number, position?: { x: number; y: number }) => {
      if (readOnly || cancelled.current) return
      begin()
      setNodes(adapter.finishResize(id, width, height, position))
      if (adapter.hasPending()) begin(true)
      flush()
    },
  }), [adapter, begin, flush, readOnly])
  const visibleNodes = useMemo(() => {
    if (departing.nodes.length === 0) return nodes
    const ids = new Set(nodes.map((node) => node.id))
    return [...nodes, ...departing.nodes.filter((node) => !ids.has(node.id))]
  }, [nodes, departing.nodes])
  const visibleEdges = useMemo(() => {
    if (departing.edges.length === 0) return topology.edges
    const ids = new Set(topology.edges.map((edge) => edge.id))
    return [...topology.edges, ...departing.edges.filter((edge) => !ids.has(edge.id))]
  }, [topology.edges, departing.edges])
  const nodeColor = useCallback((node: { selected?: boolean }) => node.selected
    ? theme === 'dark' ? '#bfdbfe' : '#1d4ed8' : theme === 'dark' ? '#60a5fa' : '#2563eb', [theme])
  const nodeStrokeColor = useCallback(() => theme === 'dark' ? '#22272a' : '#f2f2ef', [theme])
  const onDragStop = useCallback((_event: unknown, node: GraphNode, draggedNodes: GraphNode[]) => {
    if (readOnly || cancelled.current) return
    const moved = draggedNodes?.length ? draggedNodes : [node]
    const result = adapter.update(moved.map((item) => ({ type: 'position', id: item.id, position: item.position, dragging: false })))
    if (result.pending) begin(true)
    setNodes(result.nodes)
    flush()
  }, [adapter, begin, flush, readOnly])

  return <div className="graph-render-adapter" style={{ position: 'absolute', inset: 0 }}
    onPointerDownCapture={() => { if (!gesturing.current) cancelled.current = false }}
    onPointerCancel={() => { flush(); cancelled.current = true }}
    onKeyDownCapture={(event) => {
      if (event.key === 'Escape' && gesturing.current) { event.preventDefault(); event.stopPropagation(); cancel() }
      else if (!gesturing.current && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) cancelled.current = false
    }}>
    <GraphGeometryContext.Provider value={geometry}>
      <ReactFlow<GraphNode, GraphEdge>
        nodes={visibleNodes} edges={visibleEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose} onNodesChange={onNodesChange}
        onNodeDragStart={startDrag} onNodeDragStop={onDragStop}
        onConnect={onConnect} onPaneClick={onPaneClick} isValidConnection={isValidConnection}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
        panOnDrag zoomOnScroll deleteKeyCode={null} fitView fitViewOptions={fitViewOptions}
        defaultEdgeOptions={defaultEdgeOptions} proOptions={proOptions}
        aria-label={readOnly ? 'Run graph canvas' : 'Workflow editor canvas'} onInit={onInit}>
        <Background color={theme === 'dark' ? '#3e474c' : '#deded9'} gap={24} size={1} />
        <MiniMap position="bottom-right" pannable zoomable ariaLabel="Workflow overview"
          nodeComponent={AgentMinimapDot} nodeClassName={minimapClass} nodeColor={nodeColor}
          nodeStrokeColor={nodeStrokeColor} nodeStrokeWidth={2}
          bgColor={theme === 'dark' ? '#22272a' : '#f2f2ef'}
          maskColor={theme === 'dark' ? 'rgba(17, 20, 22, 0.78)' : 'rgba(255, 255, 255, 0.72)'} />
      </ReactFlow>
    </GraphGeometryContext.Provider>
  </div>
})
