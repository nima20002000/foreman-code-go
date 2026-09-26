import { createContext, forwardRef, memo, useContext, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Background, ConnectionMode, Controls, ReactFlow, type Edge, type EdgeProps, type NodeChange, type NodeProps } from '@xyflow/react'
import { WorkflowRelationshipSchema, type WorkflowDefinitionV3, type WorkflowRelationship } from '@graphql/contracts/wave25'
import type { Agent } from '@graphql/contracts'
import { AgentNodeView, AgentPopover, type AgentPanel } from '../../../shared/ui/nocturne'
import { createGraphTopologyProjector } from '../topology'
import { createGraphGeometryAdapter, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { useGraphPresentation, useGraphPresentationStore } from '../useGraphPresentation'
import { AgentHandles } from '../AgentHandles'
import { agentNodeFacts, edgeBend, useFloatingCurve } from '../signalEdge'
import { SignalEdgeShape } from '../SignalEdgeShape'
import type { GraphNode } from '../types'
import { nodeTitle, putRelationship } from './model'
import type { EditGraph } from './AuthoringFields'
import { useWorkflowBoard } from '../../workflow-board/context'
import { SelectedRunCanvas } from '../../workflow-board/inspect/SelectedRunCanvas'
import '@xyflow/react/dist/style.css'

export type OpenAgentPanel = { nodeId: string; panel: AgentPanel }
export type AgentPanels = { chat: ReactNode; settings: ReactNode; info: ReactNode }
type Canvas = {
  draftKey: string
  inspect: (action: () => void) => void
  open?: OpenAgentPanel
  setOpen: (next?: OpenAgentPanel) => void
  panels: (nodeId: string) => AgentPanels
}
const CanvasContext = createContext<Canvas>({ draftKey: '', inspect: (action) => action(), setOpen: () => undefined,
  panels: () => ({ chat: null, settings: null, info: null }) })

const DraftAgent = memo(function DraftAgent({ id, data, selected }: NodeProps<GraphNode>) {
  const { draftKey, inspect, open, setOpen, panels } = useContext(CanvasContext)
  const entry = useGraphDraftStore((state) => state.nextDrafts[draftKey]?.graph.entryNodeId === id)
  const presentation = useGraphPresentationStore()
  const runSelected = Boolean(useWorkflowBoard()?.run)
  const run = { label: 'Idle', state: 'idle' as const }
  const facts = agentNodeFacts(data.agent)
  const core = useRef<HTMLButtonElement>(null)
  const panel = open?.nodeId === id ? open.panel : undefined
  const select = () => inspect(() => { presentation.getState().setFocusedNodeId(id); presentation.getState().setFocusedEdgeId(undefined) })
  return <>
    <AgentNodeView ref={core} name={data.label} harness={facts.harness} harnessLabel={facts.harnessLabel} model={facts.model}
      icon={facts.icon} statusLabel={run.label} state={run.state} meta={facts.meta} entry={entry} selected={selected} openPanel={panel}
      ariaLabel={`${data.label}, ${facts.roleLabel}${entry ? ', starts the workflow' : ''}, ${facts.harnessLabel}, ${run.label}`}
      onSelect={select}
      onAction={(next) => inspect(() => {
        presentation.getState().setFocusedNodeId(id); presentation.getState().setFocusedEdgeId(undefined)
        setOpen(panel === next ? undefined : { nodeId: id, panel: next })
      })}>
      <AgentHandles name={data.label} />
    </AgentNodeView>
    {panel && !runSelected ? <AgentPopover open anchor={core} title={data.label} subtitle={`${facts.roleLabel} · ${facts.harnessLabel}${facts.model ? ` · ${facts.model}` : ''}`}
      icon={facts.icon} harness={facts.harness} panel={panel} onPanelChange={(next) => setOpen({ nodeId: id, panel: next })}
      onClose={() => inspect(() => setOpen(undefined))} {...panels(id)} /> : null}
  </>
})

type DraftEdge = Edge<{ kind: WorkflowRelationship['kind']; bend: number; label: string; explicit: boolean }>
const TypedEdge = memo(function TypedEdge({ id, source, target, data, selected }: EdgeProps<DraftEdge>) {
  const curve = useFloatingCurve(source, target, data?.bend ?? 28)
  const [hovered, setHovered] = useState(false)
  if (!curve) return null
  return <g onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
    <SignalEdgeShape id={id} curve={curve} kind={data?.kind}
      label={data?.label} showLabel={hovered || selected || data?.explicit} />
  </g>
})
const nodeTypes = { agent: DraftAgent }, edgeTypes = { typed: TypedEdge }
const fitViewOptions = { padding: 0.25, minZoom: 0.5, maxZoom: 1 }
const proOptions = { hideAttribution: true }
export type DraftCanvasHandle = { flush(): void; cancel(): void }

/** The draft remains mounted with its geometry buffer while the selected Run
 * renders its immutable topology. Hidden draft nodes do not subscribe to live
 * Run state or repeatedly scan execution history. */
export const DraftCanvas = forwardRef<DraftCanvasHandle, {
  draftKey: string; graph: WorkflowDefinitionV3; agents: readonly Agent[]; kind: WorkflowRelationship['kind']
  change: EditGraph; geometry: (changes: GraphGeometryChange[]) => void; pending: (pending: boolean) => void
  report: (error: unknown) => void; inspect?: (action: () => void) => void
  open?: OpenAgentPanel; setOpen?: (next?: OpenAgentPanel) => void; panels?: (nodeId: string) => AgentPanels
  children?: ReactNode
}>(function DraftCanvas({ draftKey, graph, agents, kind, change, geometry, pending, report, inspect = (action) => action(),
  open, setOpen = () => undefined, panels = () => ({ chat: null, settings: null, info: null }), children }, ref) {
  const selectedRun = useWorkflowBoard()?.run
  const [project] = useState(() => createGraphTopologyProjector())
  const topology = useMemo(() => project(graph, agents), [project, graph, agents])
  const [adapter] = useState(() => createGraphGeometryAdapter(topology.nodes))
  const [nodes, setNodes] = useState(topology.nodes)
  const [connecting, setConnecting] = useState(false)
  const selectedIds = useGraphPresentation((state) => state.selectedNodeIds)
  const focusedEdge = useGraphPresentation((state) => state.focusedEdgeId)
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
      counts.set(pair, count + 1)
      const kindLabel = edge.kind === 'approval' ? 'Approval' : 'Handoff'
      return { ...edge, type: 'typed', selected: edge.id === focusedEdge,
        ariaLabel: `${kindLabel} from ${nodeTitle(graph, edge.source)} to ${nodeTitle(graph, edge.target)}${edge.label ? `: ${edge.label}` : ''}`,
        data: { kind: edge.kind, bend: edgeBend(count, edge.source < edge.target), label: edge.label || kindLabel, explicit: Boolean(edge.label) } }
    })
  }, [graph, focusedEdge])
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
  const context = useMemo(() => ({ draftKey, inspect, open, setOpen, panels }), [draftKey, inspect, open, setOpen, panels])
  return <CanvasContext.Provider value={context}>
    <div className={`next-draft-canvas board-draft-canvas${connecting ? ' is-connecting' : ''}`} style={selectedRun ? { display: 'none' } : undefined} aria-hidden={!!selectedRun} inert={!!selectedRun} aria-label="Editable workflow graph">
      <ReactFlow<GraphNode, DraftEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} connectionMode={ConnectionMode.Loose} connectionRadius={120} deleteKeyCode={null}
        fitView fitViewOptions={fitViewOptions} proOptions={proOptions} minZoom={0.3} maxZoom={1.6}
        isValidConnection={(connection) => connection.source !== connection.target}
        onConnectStart={() => setConnecting(true)} onConnectEnd={() => setConnecting(false)}
        onClickConnectStart={() => setConnecting(true)} onClickConnectEnd={() => setConnecting(false)}
        onNodeClick={(_, node) => inspect(() => { presentation.getState().setFocusedNodeId(node.id); presentation.getState().setFocusedEdgeId(undefined) })}
        onEdgeClick={(_, edge) => inspect(() => { setOpen(undefined); presentation.getState().setFocusedEdgeId(edge.id); presentation.getState().setFocusedNodeId(undefined) })}
        onPaneClick={() => inspect(() => { setOpen(undefined); presentation.getState().setFocusedNodeId(undefined); presentation.getState().setFocusedEdgeId(undefined) })}
        onConnect={(connection) => {
          try { change((value) => value.edges.some((edge) => edge.kind === kind && edge.source === connection.source && edge.target === connection.target) ? value
            : putRelationship(value, WorkflowRelationshipSchema.parse({ id: `relationship-${crypto.randomUUID()}`, kind, source: connection.source, target: connection.target }))) }
          catch (error) { report(error) }
        }}>
        <Background color="var(--border)" gap={24} size={1} />
        <Controls position="bottom-left" showInteractive={false} fitViewOptions={fitViewOptions} />
      </ReactFlow>
      {children}
    </div>
    {selectedRun ? <SelectedRunCanvas key={JSON.stringify(selectedRun)} scope={selectedRun} /> : null}
  </CanvasContext.Provider>
})
