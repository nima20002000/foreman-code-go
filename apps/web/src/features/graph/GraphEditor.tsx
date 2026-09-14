import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { MoreHorizontal, Play, Plus, X } from 'lucide-react'

import {
  addEdge,
  Background,
  BaseEdge,
  ConnectionMode,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  applyNodeChanges,
  getSmoothStepPath,
  type Connection,
  type EdgeProps,
  type IsValidConnection,
  type MiniMapNodeProps,
  type NodeChange,
  type NodePositionChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useQueryClient } from '@tanstack/react-query'

import type {
  Agent,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowRunSummary,
  WorkspaceDetailsResponse,
} from '@graphql/contracts'

import {
  useAgentsQuery,
  useSaveGraphMutation,
  useWorkspaceDetailsQuery,
  useWorkflowQuery,
  queryKeys,
} from '../../shared/api/query'
import { motionEnabled, usePresence } from '../../shared/ui/usePresence'
import { useDismissableSurface, type SurfaceDismissReason } from '../../shared/ui/useDismissableSurface'
import { useTheme } from '../theme'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import {
  readDeletedAgentIds,
  readLocalAgents,
} from '../agents/localAgents'

import {
  AGENT_HANDOFF_EDGE_TYPE,
  graphToWorkflow,
  findOpenNodePosition,
  hasConnection,
  makeSequentialHandoffEdge,
  GRAPH_NODE_MAX_HEIGHT,
  GRAPH_NODE_MAX_WIDTH,
  GRAPH_NODE_MIN_HEIGHT,
  GRAPH_NODE_MIN_WIDTH,
  resizeWorkflowNode,
  sameWorkflow,
  withoutAgentReferences,
  workflowToGraph,
} from './mapper'
import {
  getGraphDraft,
  useGraphDraftStore,
  workflowDraftKey,
} from './store'
import type { GraphEdge, GraphHandleSide, GraphNode } from './types'
import './graph.css'

export interface WorkflowGraphProps {
  workspaceId: string
  workflowId: string
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
  onClearAgent?: () => void
}

export interface GraphEditorProps {
  workspaceId: string
  workflow: WorkflowDefinition
  agents: readonly Agent[]
  runFacts?: readonly WorkflowRunSummary[]
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
  onClearAgent?: () => void
  /**
   * When provided, saving writes the graph into the caller's session-local
   * store instead of the workspace backend. Used by session-created drafts.
   */
  onSaveSession?: (workflow: WorkflowDefinition) => void
}

const DEPARTURE_MOTION_MS = 200
const NODE_ENTRY_MOTION_MS = 420
const CONNECT_MOTION_MS = 480
const NOTICE_DISMISS_MS = 4_000
const ERROR_NOTICE_DISMISS_MS = 8_000
const EDGE_CONTROL_SIZE = 26
const MINIMAP_DOT_COLOR = { light: '#2563eb', dark: '#60a5fa' }
const MINIMAP_DOT_SELECTED_COLOR = { light: '#1d4ed8', dark: '#bfdbfe' }

const HANDLE_SIDES: GraphHandleSide[] = ['top', 'right', 'bottom', 'left']

function makeWorkflowHandoffEdge(source: string, target: string): WorkflowEdge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
    label: 'Sequential output handoff',
  }
}

const HANDLE_POSITIONS: Record<GraphHandleSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

type NodeMenuContextValue = {
  openMenuNodeId?: string
  setOpenMenuNodeId: (nodeId?: string) => void
}

/**
 * Coordinates the per-node three-dots menus so only one anchored menu can be
 * open at a time, no matter which node owns it.
 */
const NodeMenuContext = createContext<NodeMenuContextValue | undefined>(undefined)

function AgentNode({ data, selected, isConnectable }: NodeProps<GraphNode>) {
  const nodeMenu = useContext(NodeMenuContext)
  const [localMenuOpen, setLocalMenuOpen] = useState(false)
  const menuOpen = nodeMenu ? nodeMenu.openMenuNodeId === data.workflowNodeId : localMenuOpen
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const setMenuOpen = useCallback((nextOpen: boolean) => {
    if (nodeMenu) nodeMenu.setOpenMenuNodeId(nextOpen ? data.workflowNodeId : undefined)
    else setLocalMenuOpen(nextOpen)
  }, [data.workflowNodeId, nodeMenu])

  const closeMenu = useCallback((reason: SurfaceDismissReason) => {
    setMenuOpen(false)
    if (reason === 'escape') triggerRef.current?.focus()
  }, [setMenuOpen])

  useDismissableSurface({
    open: menuOpen,
    onDismiss: closeMenu,
    surfaceRef: menuRef,
    triggerRef,
  })

  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menuOpen])

  if (data.departing) {
    return (
      <div className="workflow-agent-node-departing" aria-hidden="true">
        <span className="workflow-agent-node-meta">
          <span>Agent</span>
          <span>{data.stepLabel}</span>
        </span>
        <span className="workflow-agent-node-label">{data.label}</span>
      </div>
    )
  }

  return (
    <article
      className={`workflow-agent-node${selected ? ' workflow-agent-node-selected' : ''}${data.entering ? ' workflow-agent-node-entering' : ''}`}
      data-testid={`agent-node-${data.agentId}`}
      data-agent-id={data.agentId}
      data-execution-state={data.executionState ?? 'unknown'}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={GRAPH_NODE_MIN_WIDTH}
        maxWidth={GRAPH_NODE_MAX_WIDTH}
        minHeight={GRAPH_NODE_MIN_HEIGHT}
        maxHeight={GRAPH_NODE_MAX_HEIGHT}
        handleClassName="workflow-agent-node-resize-handle nodrag"
        lineClassName="workflow-agent-node-resize-line"
        onResizeEnd={(_event, size) => data.onResize?.(data.workflowNodeId, size.width, size.height)}
      />
      {selected ? <span className="visually-hidden">Resize handles are available around this selected node.</span> : null}
      {HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={HANDLE_POSITIONS[side]}
          isConnectable={isConnectable}
          className="workflow-agent-node-handle"
        />
      ))}
      <button
        type="button"
        className="workflow-agent-node-button"
        aria-label={`${data.label} agent, ${data.stepLabel}`}
        aria-pressed={selected}
        onClick={() => data.onSelect?.(data.agentId, data.workflowNodeId)}
      >
        <span className="workflow-agent-node-meta">
          <span>Agent</span>
          <span>{data.stepLabel}</span>
        </span>
        <span className="workflow-agent-node-label">{data.label}</span>
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="workflow-agent-node-menu-trigger nodrag"
        aria-label={`Open actions for ${data.label}`}
        title="Node actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation()
          setMenuOpen(!menuOpen)
        }}
      >
        <MoreHorizontal aria-hidden="true" size={17} />
      </button>
      {menuOpen ? (
        <div ref={menuRef} className="workflow-agent-node-menu nodrag" role="menu" aria-label={`${data.label} node actions`}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              data.onUnlink?.(data.workflowNodeId)
              setMenuOpen(false)
              window.setTimeout(() => triggerRef.current?.focus(), 0)
            }}
          >
            Unlink
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              data.onDelete?.(data.agentId, data.label)
              setMenuOpen(false)
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </article>
  )
}

const nodeTypes = { agent: AgentNode }

/**
 * Removes the connection that owns this edge. The control rides inside the
 * edge group so hover and keyboard focus on the edge itself reveal it, and it
 * is rendered in a foreignObject so screen readers get a real button.
 */
function HandoffEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  style,
  markerStart,
  markerEnd,
  interactionWidth,
  data,
}: EdgeProps<GraphEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 10,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        label={label}
        labelX={labelX}
        labelY={labelY}
        labelStyle={labelStyle}
        labelShowBg={labelShowBg}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
        style={style}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
      />
      <foreignObject
        className="workflow-graph-edge-control"
        x={labelX - EDGE_CONTROL_SIZE / 2}
        y={labelY - EDGE_CONTROL_SIZE - 12}
        width={EDGE_CONTROL_SIZE}
        height={EDGE_CONTROL_SIZE}
      >
        <button
          type="button"
          className="workflow-graph-edge-remove"
          aria-label={`Remove connection from ${source} to ${target}`}
          title="Remove connection"
          onClick={(event) => {
            event.stopPropagation()
            data?.onRemove?.(id)
          }}
        >
          <X aria-hidden="true" size={13} />
        </button>
      </foreignObject>
    </>
  )
}

const edgeTypes = { [AGENT_HANDOFF_EDGE_TYPE]: HandoffEdge }

/** Minimap agents read as small blue dots instead of full node rectangles. */
function AgentMinimapDot({
  id,
  x,
  y,
  width,
  height,
  color,
  className,
  selected,
  strokeColor,
  strokeWidth,
  shapeRendering,
  onClick,
}: MiniMapNodeProps) {
  const classes = ['react-flow__minimap-node']
  if (selected) classes.push('selected')
  if (className) classes.push(className)
  const radius = Math.max(6, Math.round(Math.min(36, Math.min(width, height) / 3)))
  return (
    <circle
      className={classes.join(' ')}
      cx={x + width / 2}
      cy={y + height / 2}
      r={radius}
      fill={color}
      stroke={strokeColor}
      strokeWidth={strokeWidth}
      style={{ fill: color, stroke: strokeColor, strokeWidth }}
      shapeRendering={shapeRendering}
      onClick={onClick ? (event) => onClick(event, id) : undefined}
    />
  )
}

function graphErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')]
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function updateWorkspaceDetailsCache(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  saved: WorkflowDefinition,
) {
  queryClient.setQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails(workspaceId), (current) => {
    if (!current) return current
    return {
      ...current,
      workflows: current.workflows.map((workflow) => (workflow.id === saved.id ? saved : workflow)),
    }
  })
}

export function GraphEditor({
  workspaceId,
  workflow,
  agents,
  runFacts,
  selectedAgentId,
  onSelectAgent,
  onClearAgent,
  onSaveSession,
}: GraphEditorProps) {
  const theme = useTheme()
  const queryClient = useQueryClient()
  const workflowKey = workflowDraftKey(workspaceId, workflow.id)
  const draft = useGraphDraftStore((state) => state.drafts[workflowKey])
  const updateDraft = useGraphDraftStore((state) => state.updateDraft)
  const discardDraft = useGraphDraftStore((state) => state.discardDraft)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>()
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{ agentId: string; label: string }>()
  const [openMenuNodeId, setOpenMenuNodeId] = useState<string>()
  const [enteringEdgeId, setEnteringEdgeId] = useState<string>()
  const [enteringNodeIds, setEnteringNodeIds] = useState<Set<string>>(() => new Set())
  const [departing, setDeparting] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] })
  const agentCatalog = useAgentDirectoryStore((state) => state.catalogs[workspaceId])
  const hydrateAgentWorkspace = useAgentDirectoryStore((state) => state.hydrateWorkspace)
  const deleteSessionAgent = useAgentDirectoryStore((state) => state.deleteAgent)
  const localAgents = agentCatalog?.localAgents ?? readLocalAgents(workspaceId)
  const deletedAgentIds = agentCatalog?.deletedAgentIds ?? readDeletedAgentIds(workspaceId)
  const addAgentButtonRef = useRef<HTMLButtonElement>(null)
  const connectionSourceNodeRef = useRef<string | undefined>(undefined)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const deleteDialogRef = useRef<HTMLDivElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const deleteReturnFocusRef = useRef<HTMLButtonElement>(null)
  const deleteLabelRef = useRef<string | undefined>(undefined)
  const canvasRef = useRef<HTMLDivElement>(null)
  const flowInstanceRef = useRef<ReactFlowInstance<GraphNode, GraphEdge>>(null)
  const departureTimerRef = useRef<number | undefined>(undefined)
  const enteringNodeTimersRef = useRef<Map<string, number>>(new Map())
  const agentPickerPresence = usePresence(agentPickerOpen)
  const deletePresence = usePresence(pendingDelete !== undefined)
  const nodeMenuValue = useMemo(
    () => ({ openMenuNodeId, setOpenMenuNodeId }),
    [openMenuNodeId],
  )
  const saveMutation = useSaveGraphMutation()

  useEffect(() => {
    if (!enteringEdgeId) return
    const timeout = window.setTimeout(() => setEnteringEdgeId(undefined), CONNECT_MOTION_MS)
    return () => window.clearTimeout(timeout)
  }, [enteringEdgeId])

  useEffect(() => () => {
    if (departureTimerRef.current !== undefined) window.clearTimeout(departureTimerRef.current)
    for (const timer of enteringNodeTimersRef.current.values()) window.clearTimeout(timer)
    enteringNodeTimersRef.current.clear()
  }, [])

  useEffect(() => {
    hydrateAgentWorkspace(workspaceId)
  }, [hydrateAgentWorkspace, workspaceId])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(
      () => setNotice(undefined),
      notice.kind === 'error' ? ERROR_NOTICE_DISMISS_MS : NOTICE_DISMISS_MS,
    )
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (!agentPickerOpen) return
    const firstControl = agentPickerRef.current?.querySelector<HTMLElement>('[data-agent-picker-option]')
      ?? agentPickerRef.current?.querySelector<HTMLElement>('button, a[href]')
    firstControl?.focus()
  }, [agentPickerOpen])

  const closeDeleteConfirmation = useCallback(() => {
    setPendingDelete(undefined)
    window.setTimeout(() => deleteReturnFocusRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!pendingDelete) return
    deleteCancelRef.current?.focus()
  }, [pendingDelete])

  useDismissableSurface({
    open: pendingDelete !== undefined,
    onDismiss: closeDeleteConfirmation,
    surfaceRef: deleteDialogRef,
    triggerRef: deleteReturnFocusRef,
  })

  // Query owns the saved definition. The feature store is consulted only
  // while an unsaved draft exists, so refetches remain visible when clean.
  const currentWorkflow = draft?.dirty ? draft.workflow : workflow
  const deletedAgentIdSet = useMemo(() => new Set(deletedAgentIds), [deletedAgentIds])
  const sessionCleanedWorkflow = useMemo(
    () => withoutAgentReferences(workflow, deletedAgentIdSet),
    [deletedAgentIdSet, workflow],
  )
  const displayedWorkflow = useMemo(
    () => withoutAgentReferences(currentWorkflow, deletedAgentIdSet),
    [currentWorkflow, deletedAgentIdSet],
  )
  const hasSessionCleanup = displayedWorkflow !== currentWorkflow
  const isDirty = draft?.dirty === true || hasSessionCleanup
  const catalogAgents = useMemo(() => {
    const catalogById = new Map(agents
      .filter((agent) => !deletedAgentIdSet.has(agent.id))
      .map((agent) => [agent.id, agent]))
    for (const agent of localAgents) {
      if (!deletedAgentIdSet.has(agent.id)) catalogById.set(agent.id, agent)
    }
    return [...catalogById.values()]
  }, [agents, deletedAgentIdSet, localAgents])

  useEffect(() => {
    if (selectedAgentId && deletedAgentIdSet.has(selectedAgentId)) onClearAgent?.()
  }, [deletedAgentIdSet, onClearAgent, selectedAgentId])

  // Keep removed nodes and edges on the canvas briefly so removal reads as a
  // state change instead of an instant disappear. State sources update right
  // away; the departing copies are display-only.
  const startDeparture = useCallback((nodes: readonly GraphNode[], edges: readonly GraphEdge[]) => {
    if (!motionEnabled() || (nodes.length === 0 && edges.length === 0)) return
    if (departureTimerRef.current !== undefined) window.clearTimeout(departureTimerRef.current)
    setDeparting({
      nodes: nodes.map((node) => ({
        ...node,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        data: {
          ...node.data,
          departing: true,
          onSelect: undefined,
          onUnlink: undefined,
          onDelete: undefined,
          onResize: undefined,
        },
      })),
      edges: edges.map((edge) => ({
        ...edge,
        className: 'workflow-graph-edge-departing',
        selectable: false,
        focusable: false,
      })),
    })
    departureTimerRef.current = window.setTimeout(
      () => setDeparting({ nodes: [], edges: [] }),
      DEPARTURE_MOTION_MS,
    )
  }, [])

  const selectAgent = useCallback((agentId: string, workflowNodeId: string) => {
    onSelectAgent?.(agentId)
    const sourceNodeId = connectionSourceNodeRef.current
    connectionSourceNodeRef.current = workflowNodeId
    if (!sourceNodeId || sourceNodeId === workflowNodeId) return

    const nextEdge = makeWorkflowHandoffEdge(sourceNodeId, workflowNodeId)
    let edgeAdded = false
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => {
      const sourceExists = saved.nodes.some((node) => node.id === sourceNodeId)
      const targetExists = saved.nodes.some((node) => node.id === workflowNodeId)
      if (!sourceExists || !targetExists || hasConnection(saved.edges, sourceNodeId, workflowNodeId)) {
        return saved
      }
      edgeAdded = true
      return { ...saved, edges: [...saved.edges, nextEdge] }
    })
    if (edgeAdded) setEnteringEdgeId(nextEdge.id)
  }, [onSelectAgent, sessionCleanedWorkflow, updateDraft, workflowKey])

  const unlinkGraphNode = useCallback((workflowNodeId: string) => {
    const removedEdges = workflowToGraph({ workflow: displayedWorkflow, agents: catalogAgents })
      .edges
      .filter((edge) => edge.source === workflowNodeId || edge.target === workflowNodeId)
    startDeparture([], removedEdges)
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => ({
      ...saved,
      edges: saved.edges.filter((edge) => edge.source !== workflowNodeId && edge.target !== workflowNodeId),
    }))
  }, [catalogAgents, displayedWorkflow, sessionCleanedWorkflow, startDeparture, updateDraft, workflowKey])

  /** Removes one connection edge and keeps its projected copy for the exit animation. */
  const removeGraphEdge = useCallback((edgeId: string) => {
    const removedEdge = workflowToGraph({ workflow: displayedWorkflow, agents: catalogAgents })
      .edges
      .find((edge) => edge.id === edgeId)
    if (removedEdge) startDeparture([], [removedEdge])
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => ({
      ...saved,
      edges: saved.edges.filter((edge) => edge.id !== edgeId),
    }))
  }, [catalogAgents, displayedWorkflow, sessionCleanedWorkflow, startDeparture, updateDraft, workflowKey])

  const resizeGraphNode = useCallback((workflowNodeId: string, width: number, height: number) => {
    updateDraft(
      workflowKey,
      sessionCleanedWorkflow,
      (saved) => resizeWorkflowNode(saved, workflowNodeId, width, height),
    )
  }, [sessionCleanedWorkflow, updateDraft, workflowKey])

  const requestDeleteAgent = useCallback((agentId: string, label: string) => {
    deleteReturnFocusRef.current = document.activeElement
      ?.closest('.workflow-agent-node')
      ?.querySelector<HTMLButtonElement>('.workflow-agent-node-menu-trigger') ?? null
    deleteLabelRef.current = label
    setOpenMenuNodeId(undefined)
    setPendingDelete({ agentId, label })
  }, [])

  const confirmDeleteAgent = useCallback(() => {
    if (!pendingDelete) return
    const { agentId, label } = pendingDelete
    const removedNodeIds = new Set(
      displayedWorkflow.nodes.filter((node) => node.agentId === agentId).map((node) => node.id),
    )
    const projection = workflowToGraph({ workflow: displayedWorkflow, agents: catalogAgents })
    const departedNodes = projection.nodes.filter((node) => removedNodeIds.has(node.id))
    const departedEdges = projection.edges
      .filter((edge) => removedNodeIds.has(edge.source) || removedNodeIds.has(edge.target))
    deleteSessionAgent(workspaceId, agentId)
    startDeparture(departedNodes, departedEdges)
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => withoutAgentReferences(saved, new Set([agentId])))
    setPendingDelete(undefined)
    setNotice({
      kind: 'info',
      text: `${label} was removed for this browser session and unlinked from every graph step. Save the graph to persist reference cleanup.`,
    })
    window.setTimeout(() => addAgentButtonRef.current?.focus(), 0)
  }, [catalogAgents, deleteSessionAgent, displayedWorkflow, pendingDelete, sessionCleanedWorkflow, startDeparture, updateDraft, workspaceId, workflowKey])

  const graph = useMemo(
    () => workflowToGraph(
      { workflow: displayedWorkflow, agents: catalogAgents },
      {
        selectedAgentId,
      onSelectAgent: selectAgent,
        onUnlinkNode: unlinkGraphNode,
        onRemoveEdge: removeGraphEdge,
        onDeleteAgent: requestDeleteAgent,
        onResizeNode: resizeGraphNode,
        runFacts,
        enteringNodeIds,
      },
    ),
    [catalogAgents, displayedWorkflow, enteringNodeIds, removeGraphEdge, requestDeleteAgent, resizeGraphNode, runFacts, selectAgent, selectedAgentId, unlinkGraphNode],
  )

  const visibleNodes = useMemo(() => {
    const currentIds = new Set(graph.nodes.map((node) => node.id))
    return [...graph.nodes, ...departing.nodes.filter((node) => !currentIds.has(node.id))]
  }, [departing.nodes, graph.nodes])

  const visibleEdges = useMemo(() => {
    const currentIds = new Set(graph.edges.map((edge) => edge.id))
    return [
      ...graph.edges.map((edge) => edge.id === enteringEdgeId
        ? { ...edge, className: 'workflow-graph-edge-new' }
        : edge),
      ...departing.edges.filter((edge) => !currentIds.has(edge.id)),
    ]
  }, [departing.edges, enteringEdgeId, graph.edges])

  const updateFromGraph = useCallback(
    (nextNodes: GraphNode[], nextEdges: GraphEdge[]) => {
      updateDraft(workflowKey, sessionCleanedWorkflow, (savedDraft) => graphToWorkflow(savedDraft, nextNodes, nextEdges))
    },
    [sessionCleanedWorkflow, updateDraft, workflowKey],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<GraphNode>[]) => {
      const positionChanges = changes.filter(
        (change): change is NodePositionChange => change.type === 'position' && change.position !== undefined,
      )
      if (positionChanges.length === 0) return
      const nextNodes = applyNodeChanges(positionChanges, graph.nodes)
      updateFromGraph(nextNodes, graph.edges)
    },
    [graph.edges, graph.nodes, updateFromGraph],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return
      if (!graph.nodes.some((node) => node.id === connection.source) || !graph.nodes.some((node) => node.id === connection.target)) return
      if (hasConnection(graph.edges, connection.source, connection.target)) return
      const nextEdge = makeSequentialHandoffEdge(connection.source, connection.target)
      updateFromGraph(graph.nodes, addEdge(nextEdge, graph.edges))
      setEnteringEdgeId(nextEdge.id)
    },
    [graph.edges, graph.nodes, updateFromGraph],
  )

  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return false
      if (!graph.nodes.some((node) => node.id === connection.source) || !graph.nodes.some((node) => node.id === connection.target)) return false
      return !hasConnection(graph.edges, connection.source, connection.target)
    },
    [graph.edges, graph.nodes],
  )

  const handleDiscard = useCallback(() => {
    connectionSourceNodeRef.current = undefined
    discardDraft(workflowKey)
    setNotice(undefined)
  }, [discardDraft, workflowKey])

  const handleSave = useCallback(() => {
    if (!isDirty) return
    const submittedWorkflow = displayedWorkflow
    setNotice(undefined)

    // Session-created drafts have no server resource to save to. Keep the
    // graph in the caller's Zustand store and report the session boundary.
    if (onSaveSession) {
      onSaveSession(submittedWorkflow)
      const remainingDraft = getGraphDraft(workflowKey)
      if (!remainingDraft?.dirty || sameWorkflow(remainingDraft.workflow, submittedWorkflow)) {
        discardDraft(workflowKey)
        setNotice({ kind: 'success', text: 'Workflow saved to this browser session.' })
      } else {
        setNotice({
          kind: 'success',
          text: 'Saved to this browser session. Newer local changes remain unsaved.',
        })
      }
      return
    }

    if (saveMutation.isPending) return
    saveMutation.mutate(
      { workspaceId, workflow: submittedWorkflow },
      {
        onSuccess: ({ workflow: savedWorkflow }) => {
          queryClient.setQueryData(queryKeys.workflow(workspaceId, savedWorkflow.id), { workflow: savedWorkflow })
          updateWorkspaceDetailsCache(queryClient, workspaceId, savedWorkflow)
          void queryClient.invalidateQueries({
            queryKey: queryKeys.workspaceDetails(workspaceId),
            refetchType: 'none',
          })

          const remainingDraft = getGraphDraft(workflowKey)
          if (!remainingDraft?.dirty || sameWorkflow(remainingDraft.workflow, submittedWorkflow)) {
            discardDraft(workflowKey)
            setNotice({ kind: 'success', text: 'Graph saved.' })
          } else {
            setNotice({ kind: 'success', text: 'Graph saved. Newer local changes remain unsaved.' })
          }
        },
        onError: (error) => {
          setNotice({
            kind: 'error',
            text: `Graph could not be saved: ${graphErrorMessage(error, 'The server rejected the graph.')}`,
          })
        },
      },
    )
  }, [discardDraft, displayedWorkflow, isDirty, onSaveSession, queryClient, saveMutation, workspaceId, workflowKey])

  const closeAgentPicker = useCallback(() => {
    setAgentPickerOpen(false)
    addAgentButtonRef.current?.focus()
  }, [])

  const addAgentToGraph = useCallback((agent: Agent) => {
    const existingIds = new Set(displayedWorkflow.nodes.map((node) => node.id))
    const baseId = `node-${agent.id}`
    let nodeId = baseId
    let suffix = 2
    while (existingIds.has(nodeId)) {
      nodeId = `${baseId}-${suffix}`
      suffix += 1
    }

    const canvasBox = canvasRef.current?.getBoundingClientRect()
    const anchor = canvasBox && flowInstanceRef.current
      ? flowInstanceRef.current.screenToFlowPosition({
          x: canvasBox.left + canvasBox.width / 2 - 119,
          y: canvasBox.top + canvasBox.height / 2 - 83,
        })
      : { x: 64 + displayedWorkflow.nodes.length * 330, y: 120 }
    const position = findOpenNodePosition(displayedWorkflow.nodes, anchor)

    let nextEdgeId: string | undefined
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => {
      const nextNode = {
        id: nodeId,
        agentId: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        position,
      }
      const previousNode = saved.nodes.at(-1)
      const nextEdge = previousNode && !hasConnection(saved.edges, previousNode.id, nodeId)
        ? makeWorkflowHandoffEdge(previousNode.id, nodeId)
        : undefined
      nextEdgeId = nextEdge?.id
      return {
        ...saved,
        nodes: [...saved.nodes, nextNode],
        edges: nextEdge ? [...saved.edges, nextEdge] : saved.edges,
      }
    })
    if (nextEdgeId) setEnteringEdgeId(nextEdgeId)
    if (motionEnabled()) {
      setEnteringNodeIds((current) => new Set(current).add(nodeId))
      const existingTimer = enteringNodeTimersRef.current.get(nodeId)
      if (existingTimer !== undefined) window.clearTimeout(existingTimer)
      const timer = window.setTimeout(() => {
        enteringNodeTimersRef.current.delete(nodeId)
        setEnteringNodeIds((current) => {
          if (!current.has(nodeId)) return current
          const next = new Set(current)
          next.delete(nodeId)
          return next
        })
      }, NODE_ENTRY_MOTION_MS)
      enteringNodeTimersRef.current.set(nodeId, timer)
    }
    setOpenMenuNodeId(undefined)
  }, [displayedWorkflow, sessionCleanedWorkflow, updateDraft, workflowKey])

  const handlePaneClick = useCallback(() => {
    connectionSourceNodeRef.current = undefined
    onClearAgent?.()
  }, [onClearAgent])

  return (
    <section className="workflow-graph" data-testid="workflow-graph" aria-label={`${displayedWorkflow.name} workflow graph`}>
      <div className="workflow-graph-canvas" data-testid="workflow-graph-canvas" ref={canvasRef}>
        <NodeMenuContext.Provider value={nodeMenuValue}>
        <ReactFlow
          nodes={visibleNodes}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onPaneClick={handlePaneClick}
          isValidConnection={isValidConnection}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          panOnDrag
          zoomOnScroll
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.2, minZoom: 0.7, maxZoom: 1.1 }}
          defaultEdgeOptions={{ type: AGENT_HANDOFF_EDGE_TYPE, selectable: false }}
          proOptions={{ hideAttribution: true }}
          aria-label="Workflow editor canvas"
          onInit={(instance) => { flowInstanceRef.current = instance }}
        >
          <Background color={theme === 'dark' ? '#3e474c' : '#deded9'} gap={24} size={1} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            ariaLabel="Workflow overview"
            nodeComponent={AgentMinimapDot}
            nodeClassName={(node) => node.selected
              ? 'workflow-graph-minimap-node-selected'
              : 'workflow-graph-minimap-node'}
            nodeColor={(node) => (node.selected
              ? theme === 'dark' ? MINIMAP_DOT_SELECTED_COLOR.dark : MINIMAP_DOT_SELECTED_COLOR.light
              : theme === 'dark' ? MINIMAP_DOT_COLOR.dark : MINIMAP_DOT_COLOR.light)}
            nodeStrokeColor={() => (theme === 'dark' ? '#22272a' : '#f2f2ef')}
            nodeStrokeWidth={2}
            bgColor={theme === 'dark' ? '#22272a' : '#f2f2ef'}
            maskColor={theme === 'dark' ? 'rgba(17, 20, 22, 0.78)' : 'rgba(255, 255, 255, 0.72)'}
          />
        </ReactFlow>
        </NodeMenuContext.Provider>

        <div className="workflow-graph-primary-actions" aria-label="Workflow controls">
          <button
            type="button"
            className="workflow-graph-run"
            aria-label="Start workflow"
            title="Start workflow"
            onClick={() => setNotice({
              kind: 'info',
              text: 'Workflow execution is not connected in Phase 1.',
            })}
          >
            <Play aria-hidden="true" size={16} />
          </button>
          <button
            ref={addAgentButtonRef}
            type="button"
            className="workflow-graph-add-agent"
            aria-label="Add agent to graph"
            title="Add agent to graph"
            aria-haspopup="dialog"
            aria-expanded={agentPickerOpen}
            onClick={() => {
              setOpenMenuNodeId(undefined)
              setAgentPickerOpen(true)
            }}
          >
            <Plus aria-hidden="true" size={17} />
          </button>
        </div>

        {isDirty ? (
          <div className="workflow-graph-actions" aria-label="Graph actions">
            <button type="button" className="workflow-graph-action workflow-graph-action-quiet" onClick={handleDiscard} disabled={!onSaveSession && saveMutation.isPending}>
              Discard
            </button>
            <button type="button" className="workflow-graph-action workflow-graph-action-primary" onClick={handleSave} disabled={!onSaveSession && saveMutation.isPending}>
              {!onSaveSession && saveMutation.isPending ? 'Saving…' : 'Save graph'}
            </button>
          </div>
        ) : null}

        <div className="workflow-graph-notifications" data-testid="workflow-graph-notifications">
          {onSaveSession ? (
            <p
              className="workflow-graph-session-notice"
              data-testid="workflow-graph-session-notice"
              role="note"
            >
              Session-only workflow: this draft and its graph live in this browser tab until you
              refresh or close it. Saving keeps changes in the session, not on the workspace
              backend.
            </p>
          ) : null}

          {notice ? (
            <p
              className={`workflow-graph-toast workflow-graph-toast-${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
              aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
            >
              {notice.text}
            </p>
          ) : null}

        </div>

        {agentPickerPresence.mounted ? (
          <div
            ref={agentPickerRef}
            className="agent-picker-popover"
            role="dialog"
            aria-labelledby="agent-picker-title"
            aria-describedby="agent-picker-description"
            data-presence={agentPickerPresence.exiting ? 'exiting' : 'entering'}
            inert={agentPickerPresence.exiting || undefined}
          >
            <div className="agent-picker-heading">
              <div>
                <h2 id="agent-picker-title">Add agent to graph</h2>
                <p id="agent-picker-description">Choose a workspace agent. An agent may be used in more than one workflow step.</p>
              </div>
              <button type="button" aria-label="Close agent picker" title="Close" onClick={closeAgentPicker}>
                <X aria-hidden="true" size={17} />
              </button>
            </div>

            {catalogAgents.length > 0 ? (
              <div className="agent-picker-list">
                {catalogAgents.map((agent, index) => (
                  <button
                    key={agent.id}
                    type="button"
                    data-agent-picker-option
                    autoFocus={index === 0}
                    onClick={() => addAgentToGraph(agent)}
                  >
                    <strong>{agent.name}</strong>
                    <span>{agent.role ?? 'Agent'}{agent.description ? ` · ${agent.description}` : ''}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="agent-picker-empty">
                <p>No agents are available in this workspace.</p>
                <a href={`/workspaces/${encodeURIComponent(workspaceId)}/agents`}>Open Agents directory</a>
              </div>
            )}
          </div>
        ) : null}

        {deletePresence.mounted ? (
          <div
            className="agent-picker-backdrop"
            data-presence={deletePresence.exiting ? 'exiting' : 'entering'}
            inert={deletePresence.exiting || undefined}
          >
            <div
              ref={deleteDialogRef}
              className="agent-picker-dialog agent-delete-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="agent-delete-title"
              aria-describedby="agent-delete-description"
              onKeyDown={trapDialogFocus}
            >
              <div className="agent-picker-heading">
                <div>
                  <h2 id="agent-delete-title">Delete {pendingDelete?.label ?? deleteLabelRef.current} from this session?</h2>
                  <p id="agent-delete-description">
                    This removes the agent from this browser session and unlinks every reference to it in the graph draft. It does not delete backend data, and the graph cleanup remains unsaved until you choose Save graph.
                  </p>
                </div>
                <button type="button" aria-label="Close delete confirmation" title="Close" onClick={closeDeleteConfirmation}>
                  <X aria-hidden="true" size={17} />
                </button>
              </div>
              <div className="agent-delete-actions">
                <button ref={deleteCancelRef} type="button" onClick={closeDeleteConfirmation}>Cancel</button>
                <button type="button" className="agent-delete-confirm" onClick={confirmDeleteAgent}>Delete for this session</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export function WorkflowGraph({ workspaceId, workflowId, selectedAgentId, onSelectAgent, onClearAgent }: WorkflowGraphProps) {
  const workflowQuery = useWorkflowQuery(workspaceId, workflowId)
  const agentsQuery = useAgentsQuery(workspaceId)
  const workspaceQuery = useWorkspaceDetailsQuery(workspaceId)

  if (workflowQuery.isPending || agentsQuery.isPending || workspaceQuery.isPending) {
    return (
      <div className="workflow-graph-state" data-testid="workflow-graph-loading" role="status">
        <p className="workflow-graph-kicker">Workflow graph</p>
        <h2>Loading graph…</h2>
        <p>Loading the saved definition and its agent steps.</p>
      </div>
    )
  }

  if (
    workflowQuery.isError ||
    agentsQuery.isError ||
    workspaceQuery.isError ||
    !workflowQuery.data ||
    !agentsQuery.data ||
    !workspaceQuery.data
  ) {
    return (
      <div className="workflow-graph-state workflow-graph-state-error" data-testid="workflow-graph-error" role="alert">
        <p className="workflow-graph-kicker">Workflow graph</p>
        <h2>Graph unavailable</h2>
        <p>{graphErrorMessage(workflowQuery.error ?? agentsQuery.error ?? workspaceQuery.error, 'The workflow could not be loaded.')}</p>
      </div>
    )
  }

  return (
    <GraphEditor
      workspaceId={workspaceId}
      workflow={workflowQuery.data.workflow}
      agents={agentsQuery.data.agents}
      runFacts={workspaceQuery.data.runs}
      selectedAgentId={selectedAgentId}
      onSelectAgent={onSelectAgent}
      onClearAgent={onClearAgent}
    />
  )
}

export { AgentMinimapDot, AgentNode, HandoffEdge }
