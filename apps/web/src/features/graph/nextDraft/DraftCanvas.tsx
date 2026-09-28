import { createContext, forwardRef, memo, useContext, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Background, ConnectionMode, ReactFlow, type Edge, type EdgeProps, type NodeChange, type NodeProps } from '@xyflow/react'
import { WorkflowRelationshipSchema, type WorkflowDefinitionV3, type WorkflowRelationship } from '@graphql/contracts/wave25'
import type { Agent } from '@graphql/contracts'
import { AgentNodeView, AgentPopover, IconButton, Icon, type AgentPanel } from '../../../shared/ui/nocturne'
import { createGraphTopologyProjector } from '../topology'
import { createGraphGeometryAdapter, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { useGraphPresentation, useGraphPresentationStore } from '../useGraphPresentation'
import { AgentHandles } from '../AgentHandles'
import { agentNodeFacts, edgeBend, relationshipLines, useFloatingCurve } from '../signalEdge'
import { SignalEdgeShape } from '../SignalEdgeShape'
import type { GraphNode } from '../types'
import { nodeTitle, putRelationship, removeRelationship, setWorkConnectionLimit } from './model'
import { WorkConnectionLimitEditor } from './WorkConnectionLimitEditor'
import type { EditGraph } from './AuthoringFields'
import { useWorkflowBoard } from '../../workflow-board/context'
import { SelectedRunCanvas } from '../../workflow-board/inspect/SelectedRunCanvas'
import '@xyflow/react/dist/style.css'

export type OpenAgentPanel = { nodeId: string; panel: AgentPanel }
export type AgentPanels = { chat: ReactNode; settings: ReactNode; info: ReactNode }
/** A selected Run supplies its pinned identity, including nodes no longer present in the draft. */
export type AgentPanelRenderer = (nodeId: string, pinned?: { agentId: string; name: string }) => AgentPanels
type Canvas = {
  draftKey: string
  inspect: (action: () => void) => void
  open?: OpenAgentPanel
  setOpen: (next?: OpenAgentPanel) => void
  panels: AgentPanelRenderer
  selectNode?: (nodeId: string) => void
}
const CanvasContext = createContext<Canvas>({ draftKey: '', inspect: (action) => action(), setOpen: () => undefined,
  panels: () => ({ chat: null, settings: null, info: null }) })

const DraftAgent = memo(function DraftAgent({ id, data, selected }: NodeProps<GraphNode>) {
  const { draftKey, inspect, open, setOpen, panels, selectNode } = useContext(CanvasContext)
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
      onSelect={(event) => { event.stopPropagation(); if (selectNode) selectNode(id); else select() }}
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

type DraftEdge = Edge<{ kind: WorkflowRelationship['kind']; bend: number; label: string; explicit: boolean;
  remove: () => void; removeLabel: string; removalDisabled: boolean;
  workPolicy: boolean; maxWorkHandoffsPerRun?: number; draftChanged: boolean; disabled: boolean;
  onApplyLimit?: (value?: number) => void }>
const TypedEdge = memo(function TypedEdge({ id, source, target, data }: EdgeProps<DraftEdge>) {
  const curve = useFloatingCurve(source, target, data?.bend ?? 28)
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  if (!curve) return null
  const offset = data?.explicit ? (data.label.length * 7.2 + 24) / 2 + 8 : 0
  const limit = data?.maxWorkHandoffsPerRun
  return <g onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
    <SignalEdgeShape id={id} curve={curve} kind={data?.kind}
      label={data?.label} showLabel={data?.explicit && hovered} />
    {hovered ? <foreignObject className="board-edge-remove nodrag nopan" x={curve.mid.x + offset - 18} y={curve.mid.y - 36} width={36} height={36}>
      <IconButton size="sm" variant="ghost" label={data?.removeLabel ?? `Remove connection from ${source} to ${target}`}
        disabled={data?.removalDisabled} onClick={(event) => { event.stopPropagation(); data?.remove() }}><Icon name="close" size={14} /></IconButton>
    </foreignObject> : null}
    {data?.workPolicy ? <foreignObject className="work-connection-limit-object"
      x={curve.mid.x - (editing ? 132 : 54)} y={curve.mid.y + 12}
      width={editing ? 264 : 108} height={editing ? 208 : 42}>
      <div className="work-connection-limit-control nodrag nopan nowheel"
        onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        {editing ? <WorkConnectionLimitEditor compact value={limit} disabled={data.disabled}
          onCancel={() => setEditing(false)} onApply={(value) => { data.onApplyLimit?.(value); setEditing(false) }} />
          : <button type="button" className="work-connection-limit-pill" data-testid={`work-limit-${id}`}
            disabled={data.disabled} title="Edit the work handoff limit on this connection"
            aria-label={`Maximum work handoffs per Run: ${limit ?? 'unlimited'}${data.draftChanged ? ', draft change' : ''}. Edit connection limit.`}
            onClick={(event) => { event.stopPropagation(); setEditing(true) }}>
            <span>{limit ?? '∞'}</span>{data.draftChanged ? <small>Draft</small> : null}
          </button>}
      </div>
    </foreignObject> : null}
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
  baseGraph?: WorkflowDefinitionV3; semanticLocked?: boolean
  change: EditGraph; geometry: (changes: GraphGeometryChange[]) => void; pending: (pending: boolean) => void
  report: (error: unknown) => void; inspect?: (action: () => void) => void; removalDisabled?: boolean
  open?: OpenAgentPanel; setOpen?: (next?: OpenAgentPanel) => void; panels?: AgentPanelRenderer
  children?: ReactNode
}>(function DraftCanvas({ draftKey, graph, agents, kind, baseGraph, semanticLocked = false,
  change, geometry, pending, report, inspect = (action) => action(), removalDisabled = false,
  open, setOpen = () => undefined, panels = () => ({ chat: null, settings: null, info: null }), children }, ref) {
  const selectedRun = useWorkflowBoard()?.run
  const [project] = useState(() => createGraphTopologyProjector())
  const topology = useMemo(() => project(graph, agents), [project, graph, agents])
  const [adapter] = useState(() => createGraphGeometryAdapter(topology.nodes))
  const [nodes, setNodes] = useState(topology.nodes)
  const [connecting, setConnecting] = useState(false)
  const connectionSource = useRef<string | undefined>(undefined)
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
    // One line per agent pair: an approval beside a handoff is drawn on the handoff's line.
    return relationshipLines(graph.edges).lines.map(({ members, ...edge }) => {
      const pair = JSON.stringify([edge.source, edge.target].sort()), count = counts.get(pair) ?? 0
      counts.set(pair, count + 1)
      const kindLabel = members.length > 1 ? 'Handoff · approval' : edge.kind === 'approval' ? 'Approval' : 'Handoff'
      return { ...edge, type: 'typed', sourceHandle: 'right', targetHandle: 'left',
        ariaLabel: `${kindLabel} from ${nodeTitle(graph, edge.source)} to ${nodeTitle(graph, edge.target)}${edge.label ? `: ${edge.label}` : ''}`,
        data: { kind: edge.kind, bend: edgeBend(count, edge.source < edge.target), label: edge.label || kindLabel, explicit: Boolean(edge.label),
          remove: () => change((value) => removeRelationship(value, edge.id)),
          removeLabel: `Remove ${edge.kind === 'approval' ? 'approval' : 'handoff'} from ${nodeTitle(graph, edge.source)} to ${nodeTitle(graph, edge.target)}`,
          removalDisabled, workPolicy: Boolean(graph.handoffs && edge.kind === 'execution'),
          maxWorkHandoffsPerRun: edge.maxWorkHandoffsPerRun,
          draftChanged: edge.maxWorkHandoffsPerRun !== baseGraph?.edges.find((item) => item.id === edge.id)?.maxWorkHandoffsPerRun,
          disabled: semanticLocked,
          onApplyLimit: (limit?: number) => {
            try { change((value) => setWorkConnectionLimit(value, edge.id, limit)) }
            catch (error) { report(error) }
          } } }
    })
  }, [graph, baseGraph, semanticLocked, change, report, removalDisabled])
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
  const connectNodes = (source: string, target: string) => {
    try { change((value) => value.edges.some((edge) => edge.kind === kind && edge.source === source && edge.target === target) ? value
      : putRelationship(value, WorkflowRelationshipSchema.parse({ id: `relationship-${crypto.randomUUID()}`, kind, source, target }))) }
    catch (error) { report(error) }
  }
  const selectNode = (nodeId: string) => inspect(() => {
    const source = connectionSource.current
    if (source && source !== nodeId && graph.nodes.some((node) => node.id === source)) {
      connectNodes(source, nodeId)
      connectionSource.current = undefined
    } else connectionSource.current = source === nodeId ? undefined : nodeId
    presentation.getState().setFocusedNodeId(nodeId)
    presentation.getState().setSelectedNodeIds(new Set([nodeId]))
    presentation.getState().setFocusedEdgeId(undefined)
  })
  const context = { draftKey, inspect, open, setOpen, panels, selectNode }
  return <CanvasContext.Provider value={context}>
    <div className={`next-draft-canvas board-draft-canvas${connecting ? ' is-connecting' : ''}`} style={selectedRun ? { display: 'none' } : undefined} aria-hidden={!!selectedRun} inert={!!selectedRun} aria-label="Editable workflow graph">
      {/* While a Run is shown, the draft's data stays mounted but its flow does not: a hidden
          flow measures a zero-size box and would come back empty on Return to draft. */}
      {selectedRun ? null : <ReactFlow<GraphNode, DraftEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} connectionMode={ConnectionMode.Loose} connectionRadius={120} deleteKeyCode={null}
        fitView fitViewOptions={fitViewOptions} proOptions={proOptions} minZoom={0.3} maxZoom={1.6}
        isValidConnection={(connection) => connection.source !== connection.target}
        onConnectStart={() => setConnecting(true)} onConnectEnd={() => setConnecting(false)}
        onClickConnectStart={() => setConnecting(true)} onClickConnectEnd={() => setConnecting(false)}
        onNodeClick={(_, node) => selectNode(node.id)}
        onPaneClick={() => inspect(() => { connectionSource.current = undefined; setOpen(undefined); presentation.getState().setFocusedNodeId(undefined); presentation.getState().setFocusedEdgeId(undefined) })}
        onConnect={(connection) => {
          connectionSource.current = undefined
          connectNodes(connection.source, connection.target)
        }}>
        <Background color="var(--border)" gap={24} size={1} />
      </ReactFlow>}
      {children}
    </div>
    {selectedRun ? <SelectedRunCanvas key={JSON.stringify(selectedRun)} scope={selectedRun} panels={panels} /> : null}
  </CanvasContext.Provider>
})
