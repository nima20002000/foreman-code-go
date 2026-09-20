import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import { UnsavedChangesContext, useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Inbox } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { createPortal } from 'react-dom'
import { AgentSettingsForm } from './AgentSettingsForm'
import { WorkflowExecutionLimits } from './WorkflowExecutionLimits'
import {
  Alert,
  Button,
  ErrorState,
  Icon,
  IconButton,
  LoadingState,
  Select,
  Toolbar,
  WorkflowNodeCard,
  type Tone,
} from '../../shared/ui/nocturne'

import {
  addEdge,
  Background,
  BaseEdge,
  ConnectionMode,
  Handle,
  MarkerType,
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

import {
  DEFAULT_AGENT_DEFAULTS, type AgentDefaults, type ApprovalHandler,
} from '@graphql/contracts'
import type {
  Agent,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowExecutionPolicy,
  WorkflowNode,
  WorkflowRunSummary,
  WorkspaceDetailsResponse,
} from '@graphql/contracts'
import type { GraphDraft as ManagedGraphDraft } from '@graphql/contracts/management'

import {
  useAgentDefaultsQuery,
  useRunQuery,
  useSaveGraphMutation,
  useManagedGraphContextQuery,
  useManagedWorkspaceQuery,
  useStartManagedRunMutation,
  useStopManagedRunMutation,
  useStartWorkflowRunMutation,
  useWorkspaceDetailsQuery,
  queryKeys,
} from '../../shared/api/query'
import { useCancelRunMutation } from '../../shared/api/runActions'
import { ApiError, applyManagedGraphDraft, saveManagedGraphDraft } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { managedSaveQueue } from './managedSave'
import {
  assertManagedBase, captureManagedBase, managedDraftIsPublished,
  type AgentRevisions, type CloneSources, type ManagedEditBase,
} from './managedGraphState'
import type { GraphSaveSnapshot } from './store'
import { motionEnabled, usePresence } from '../../shared/ui/usePresence'
import { useDismissableSurface, type SurfaceDismissReason } from '../../shared/ui/useDismissableSurface'
import { useTheme } from '../theme'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import {
  defaultAgentForHarness,
  nextCoderAgentName,
  nextHarnessAgentName,
} from '../agents/agentSettings'
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
  withoutAgentReferences,
  workflowToGraph,
} from './mapper'
import {
  getGraphDraft,
  useGraphDraftStore,
  workflowDraftKey,
} from './store'
import type { GraphEdge, GraphHandleSide, GraphNode } from './types'
import { managementGraphOperations } from './managementDiff'
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
  /** Called after a browser-created workflow is first persisted by a real workspace backend. */
  onPersisted?: (workflow: WorkflowDefinition) => void
  managedDraft?: ManagedGraphDraft
  managedAgentRevisions?: AgentRevisions
}

const DEPARTURE_MOTION_MS = 200
const NODE_ENTRY_MOTION_MS = 420
const CONNECT_MOTION_MS = 480
const NOTICE_DISMISS_MS = 4_000
const ERROR_NOTICE_DISMISS_MS = 8_000
const EDGE_CONTROL_SIZE = 26
const MINIMAP_DOT_COLOR = { light: '#2563eb', dark: '#60a5fa' }
const MINIMAP_DOT_SELECTED_COLOR = { light: '#1d4ed8', dark: '#bfdbfe' }
const EMPTY_AGENT_OVERRIDES: Record<string, Agent> = {}

const HANDLE_SIDES: GraphHandleSide[] = ['top', 'right', 'bottom', 'left']

function makeWorkflowHandoffEdge(source: string, target: string): WorkflowEdge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
  }
}

const HANDLE_POSITIONS: Record<GraphHandleSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

type NodeMenuContextValue = {
  workspaceId?: string
  workflowApprovalHandler?: ApprovalHandler
  openMenuNodeId?: string
  setOpenMenuNodeId: (nodeId?: string) => void
}

/**
 * Coordinates the per-node three-dots menus so only one anchored menu can be
 * open at a time, no matter which node owns it.
 */
const NodeMenuContext = createContext<NodeMenuContextValue | undefined>(undefined)

function agentNodeTone(data: GraphNode['data']): Tone {
  if (data.runState === 'completed') {
    if (data.runOutcome === 'failed') return 'danger'
    if (data.runOutcome === 'canceled') return 'neutral'
    return data.runOutcome === 'succeeded' ? 'success' : 'neutral'
  }
  if (data.executionState === 'auth_required' || data.executionState === 'waiting_browser' || data.runState === 'waiting') return 'warning'
  if (data.executionState === 'interrupted' || data.executionState === 'disconnected') return 'danger'
  if (data.executionState === 'working' || data.runState === 'queued' || data.runState === 'starting' || data.runState === 'running') return 'accent'
  if (data.executionState === 'available') return 'success'
  return 'neutral'
}

function agentNodeStatus(data: GraphNode['data']): string {
  if (data.runState === 'completed') {
    if (data.runOutcome === 'canceled') return 'Canceled'
    if (data.runOutcome === 'failed') return 'Failed'
    if (data.runOutcome === 'succeeded') return 'Completed'
  }
  return data.runState?.replaceAll('_', ' ') ?? data.executionStateLabel
}

function agentNodeSubtitle(data: GraphNode['data']): string {
  const harness = data.agent.harness ?? data.agent.harnessConfiguration?.harness
  const harnessLabel = harness === 'opencode' ? 'OpenCode'
    : harness === 'codex' ? 'Codex'
      : data.agent.harnessSummary?.label ?? 'Agent'
  const responsibility = data.role ?? data.agent.productRole ?? data.stepLabel
  return `${harnessLabel} · ${responsibility}`
}

function agentNodeIcon(data: GraphNode['data']): 'workflow' | 'code' | 'eye' | 'bot' {
  const responsibility = `${data.role ?? ''} ${data.agent.productRole ?? ''}`.toLowerCase()
  if (responsibility.includes('review')) return 'eye'
  if (responsibility.includes('orchestrat')) return 'workflow'
  if (responsibility.includes('develop') || responsibility.includes('cod')) return 'code'
  return 'bot'
}


function AgentNode({ data, selected, isConnectable }: NodeProps<GraphNode>) {
  const nodeMenu = useContext(NodeMenuContext)
  const [localMenuOpen, setLocalMenuOpen] = useState(false)
  const menuOpen = nodeMenu ? nodeMenu.openMenuNodeId === data.workflowNodeId : localMenuOpen
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuPosition, setMenuPosition] = useState({ top: 8, left: 8 })

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const gap = 8
    const width = Math.min(432, window.innerWidth - 16)
    const estimatedHeight = Math.min(420, window.innerHeight - 16)
    const fitsRight = rect.right + gap + width <= window.innerWidth - 8
    const left = fitsRight ? rect.right + gap : Math.max(8, rect.left - gap - width)
    const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - estimatedHeight - 8))
    setMenuPosition({ top, left })
  }, [])

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
    positionMenu()
    menuRef.current?.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [menuOpen, positionMenu])

  if (data.departing) {
    return (
      <div className="workflow-agent-node-departing" aria-hidden="true">
        <WorkflowNodeCard
          title={data.label}
          subtitle={agentNodeSubtitle(data)}
          statusLabel={agentNodeStatus(data)}
          tone={agentNodeTone(data)}
          icon={agentNodeIcon(data)}
          meta={data.stepLabel}
        />
      </div>
    )
  }

  return (
    <article
      className={`workflow-agent-node${selected ? ' workflow-agent-node-selected' : ''}${data.runState === 'starting' || data.runState === 'running' || data.runState === 'waiting' ? ' workflow-agent-node-active' : ''}${data.entering ? ' workflow-agent-node-entering' : ''}`}
      data-testid={`agent-node-${data.agentId}`}
      data-agent-id={data.agentId}
      data-execution-state={data.executionState ?? 'unknown'}
      data-run-state={data.runState ?? 'idle'}
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
      <WorkflowNodeCard
        className="workflow-agent-node-button"
        title={data.label}
        subtitle={agentNodeSubtitle(data)}
        statusLabel={agentNodeStatus(data)}
        tone={agentNodeTone(data)}
        icon={agentNodeIcon(data)}
        selected={selected}
        working={data.runState === 'starting' || data.runState === 'running' || data.executionState === 'working'}
        meta={data.stepLabel}
        ariaLabel={`${data.label} agent, ${data.stepLabel}`}
        onSelect={(event) => data.onSelect?.(
          data.agentId,
          data.workflowNodeId,
          event.ctrlKey || event.metaKey,
        )}
      />
      <Button
        ref={triggerRef}
        variant="ghost"
        className="n-icon-button workflow-agent-node-menu-trigger nodrag"
        aria-label={`Open actions for ${data.label}`}
        title="Node actions"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation()
          if (!menuOpen) {
            positionMenu()
            data.onOpenSettings?.(data.agentId, data.workflowNodeId)
          }
          setMenuOpen(!menuOpen)
        }}
      >
        <Icon name="more" size={17} />
      </Button>
      {menuOpen ? createPortal((
        <div ref={menuRef} className="agent-settings-inspector nodrag nowheel" style={menuPosition} role="dialog" aria-modal={false} aria-label={`${data.label} settings`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // A portal still bubbles through React: do not let Delete remove graph nodes.
            event.stopPropagation()
            if (event.key === 'Escape') { event.preventDefault(); closeMenu('escape') }
          }}>
          <AgentSettingsForm
            workspaceId={nodeMenu?.workspaceId}
            workflowApprovalHandler={nodeMenu?.workflowApprovalHandler}
            agent={data.agent}
            initialPrompt={data.initialPrompt}
            executionPolicy={data.executionPolicy}
            workflowNodeCount={data.workflowNodeCount}
            onClose={() => {
              setMenuOpen(false)
              window.setTimeout(() => triggerRef.current?.focus(), 0)
            }}
            onRemove={() => {
              data.onRemove?.(data.workflowNodeId)
              setMenuOpen(false)
            }}
            onSave={(agent, initialPrompt, executionPolicy) => {
              data.onSaveSettings?.(data.workflowNodeId, agent, initialPrompt, executionPolicy)
              setMenuOpen(false)
              window.setTimeout(() => triggerRef.current?.focus(), 0)
            }}
          />
        </div>
      ), document.body) : null}
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
        className="n-flow-base workflow-graph-edge-path"
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
        <Button
          variant="secondary"
          className="workflow-graph-edge-remove"
          aria-label={`Remove connection from ${source} to ${target}${typeof label === 'string' && label ? `: ${label}` : ''}`}
          title="Remove connection"
          onClick={(event) => {
            event.stopPropagation()
            data?.onRemove?.(id)
          }}
        >
          <Icon name="close" size={13} />
        </Button>
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
  const message = error instanceof Error && error.message ? error.message : fallback
  if (!ApiError.is(error) || error.code !== 'GRAPH_INVALID' || !Array.isArray(error.details?.issues)) return message
  const issues = error.details.issues.flatMap((issue) =>
    issue && typeof issue === 'object' && 'message' in issue && typeof issue.message === 'string' && issue.message.trim()
      ? [issue.message.trim()] : [],
  )
  return issues.length > 0 ? `${message} ${issues.join(' ')}` : message
}

function cacheManagedBase(queryClient: ReturnType<typeof useQueryClient>, base: ManagedEditBase) {
  const items = base.agents.flatMap((agent) => {
    const metadataRevision = base.metadataRevisions[agent.id]
    return typeof metadataRevision === 'number' ? [{ agent, metadataRevision }] : []
  })
  const next = { draft: base.draft, agents: { items, pageInfo: { nextCursor: null as string | null } } }
  queryClient.setQueryData<typeof next>(queryKeys.managedGraphContext(base.draft.workspaceId, base.draft.workflowId),
    (current) => current?.draft.id === next.draft.id && current.draft.revision > next.draft.revision ? current : next)
}

function updateWorkspaceDetailsCache(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  saved: WorkflowDefinition,
  savedAgents?: readonly Agent[],
) {
  queryClient.setQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails(workspaceId), (current) => {
    if (!current) return current
    return {
      ...current,
      workflows: current.workflows.some((workflow) => workflow.id === saved.id)
        ? current.workflows.map((workflow) => (workflow.id === saved.id ? saved : workflow))
        : [...current.workflows, saved],
      agents: savedAgents ? [...savedAgents] : current.agents,
    }
  })
  if (savedAgents) queryClient.setQueryData(queryKeys.agents(workspaceId), { agents: [...savedAgents] })
}

function nextBoardAgentId(harness: NonNullable<Agent['harness']>): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `agent-${harness}-${suffix}`
}

function nextCopiedAgentId(agent: Agent): string {
  const harness = agent.harness ?? agent.harnessConfiguration?.harness
  if (harness) return nextBoardAgentId(harness)
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `agent-copy-${suffix}`
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
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
  onPersisted,
  managedDraft,
  managedAgentRevisions = {},
}: GraphEditorProps) {
  const theme = useTheme()
  const toasts = useContext(ToastContext)
  const navigationGuard = useContext(UnsavedChangesContext)
  const leaveSurface = useCallback(async (action: () => void) => {
    if (!navigationGuard || await navigationGuard.surfaces()) action()
  }, [navigationGuard])
  const queryClient = useQueryClient()
  const workflowKey = workflowDraftKey(workspaceId, workflow.id)
  const draft = useGraphDraftStore((state) => state.drafts[workflowKey])
  const updateDraft = useGraphDraftStore((state) => state.updateDraft)
  const discardDraft = useGraphDraftStore((state) => state.discardDraft)
  const completeSave = useGraphDraftStore((state) => state.completeSave)
  const restoreDraft = useGraphDraftStore((state) => state.restoreDraft)
  const managedSaving = useGraphDraftStore((state) => Boolean(state.managedSaving[workflowKey]))
  const saveLock = useRef(false)
  const agentOverrides = draft?.agentOverrides ?? EMPTY_AGENT_OVERRIDES
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>()
  useEffect(() => { if (notice?.kind === 'success') toasts?.notify({ tone: 'success', title: notice.text }) }, [notice, toasts])
  const [activeRunId, setActiveRunId] = useState<string | undefined>(() => runFacts?.find((run) =>
    run.workflowId === workflow.id && run.executionState !== 'completed',
  )?.id)
  const displayedRunId = activeRunId ?? runFacts?.find((run) => run.workflowId === workflow.id)?.id
  const startLock = useRef(Boolean(activeRunId))
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(false)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set())
  const [openMenuNodeId, setOpenMenuNodeId] = useState<string>()
  const [enteringEdgeId, setEnteringEdgeId] = useState<string>()
  const [enteringNodeIds, setEnteringNodeIds] = useState<Set<string>>(() => new Set())
  const [departing, setDeparting] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] })
  const agentCatalog = useAgentDirectoryStore((state) => state.catalogs[workspaceId])
  const hydrateAgentWorkspace = useAgentDirectoryStore((state) => state.hydrateWorkspace)
  const localAgents = agentCatalog?.localAgents ?? readLocalAgents(workspaceId)
  const deletedAgentIds = agentCatalog?.deletedAgentIds ?? readDeletedAgentIds(workspaceId)
  const addAgentButtonRef = useRef<HTMLButtonElement>(null)
  const workflowSettingsButtonRef = useRef<HTMLButtonElement>(null)
  const workflowSettingsRef = useRef<HTMLDivElement>(null)
  const closeWorkflowSettings = useCallback((reason: SurfaceDismissReason = 'escape') => {
    void leaveSurface(() => {
      setWorkflowSettingsOpen(false)
      if (reason === 'escape') workflowSettingsButtonRef.current?.focus()
    })
  }, [leaveSurface])
  useDismissableSurface({ open: workflowSettingsOpen, onDismiss: closeWorkflowSettings,
    surfaceRef: workflowSettingsRef, triggerRef: workflowSettingsButtonRef })
  useEffect(() => {
    if (workflowSettingsOpen) workflowSettingsRef.current?.querySelector<HTMLElement>('select, button')?.focus()
  }, [workflowSettingsOpen])
  const connectionSourceNodeRef = useRef<string | undefined>(undefined)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const flowInstanceRef = useRef<ReactFlowInstance<GraphNode, GraphEdge>>(null)
  const departureTimerRef = useRef<number | undefined>(undefined)
  const enteringNodeTimersRef = useRef<Map<string, number>>(new Map())
  const copiedGraphRef = useRef<{
    nodes: Array<{ node: WorkflowNode; agent: Agent }>
    edges: WorkflowEdge[]
  } | undefined>(undefined)
  const undoStackRef = useRef<GraphSaveSnapshot[]>([])
  const positionUndoActiveRef = useRef(false)
  const agentPickerPresence = usePresence(agentPickerOpen)
  const openNodeMenu = useCallback((nodeId?: string) => {
    void leaveSurface(() => {
      if (nodeId) { setWorkflowSettingsOpen(false); setAgentPickerOpen(false) }
      setOpenMenuNodeId(nodeId)
    })
  }, [leaveSurface])
  const nodeMenuValue = useMemo(
    () => ({ openMenuNodeId, setOpenMenuNodeId: openNodeMenu, workspaceId,
      workflowApprovalHandler: (draft?.workflow ?? workflow).approval?.handler }),
    [openMenuNodeId, openNodeMenu, workspaceId, draft?.workflow, workflow],
  )
  const saveMutation = useSaveGraphMutation()
  const isSaving = managedSaving || saveMutation.isPending
  const managedBase = useMemo(() => managedDraft
    ? draft?.managedBase ?? captureManagedBase(managedDraft, agents, managedAgentRevisions)
    : undefined, [agents, draft?.managedBase, managedAgentRevisions, managedDraft])
  const managedWorkspace = useManagedWorkspaceQuery(workspaceId, Boolean(managedDraft))
  const agentDefaultsQuery = useAgentDefaultsQuery(import.meta.env.MODE !== 'test')
  const agentDefaults: AgentDefaults = agentDefaultsQuery.data?.value ?? DEFAULT_AGENT_DEFAULTS
  const startRunMutation = useStartWorkflowRunMutation()
  const startManagedRun = useStartManagedRunMutation()
  const stopManagedRun = useStopManagedRunMutation()
  const cancelRunMutation = useCancelRunMutation()
  const runQuery = useRunQuery(workspaceId, displayedRunId ?? '', {
    enabled: Boolean(displayedRunId),
    refetchInterval: (query) => query.state.data?.run.executionState === 'completed' ? false : 1_000,
  })
  const runStatesByNodeId = useMemo(
    () => new Map(runQuery.data?.executions.map((execution) => [execution.workflowNodeId, execution.state]) ?? []),
    [runQuery.data?.executions],
  )
  const runOutcomesByNodeId = useMemo(
    () => new Map(runQuery.data?.executions.flatMap((execution) => execution.result
      ? [[execution.workflowNodeId, execution.result.outcome] as const] : []) ?? []),
    [runQuery.data?.executions],
  )

  useEffect(() => {
    const run = runQuery.data?.run
    if (!run || run.id !== activeRunId || run.executionState !== 'completed') return
    startLock.current = false
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    if (run.outcome === 'succeeded') {
      setNotice({ kind: 'success', text: 'Workflow completed with a durable result.' })
    } else {
      setNotice({
        kind: 'error',
        text: run.result?.error?.message ?? `Workflow finished with outcome ${run.outcome}.`,
      })
    }
  }, [activeRunId, queryClient, runQuery.data, workspaceId])

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
  }, [agentPickerOpen, agentDefaults])

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
  const catalogAgents = useMemo(() => {
    const catalogById = new Map((draft?.managedBase?.agents ?? agents)
      .filter((agent) => !deletedAgentIdSet.has(agent.id))
      .map((agent) => [agent.id, agent]))
    for (const agent of localAgents) {
      if (!deletedAgentIdSet.has(agent.id)) catalogById.set(agent.id, agent)
    }
    for (const agent of Object.values(agentOverrides)) {
      if (!deletedAgentIdSet.has(agent.id)) catalogById.set(agent.id, agent)
    }
    return [...catalogById.values()]
  }, [agentOverrides, agents, deletedAgentIdSet, draft?.managedBase?.agents, localAgents])
  const workflowAgentIds = useMemo(() => new Set(displayedWorkflow.nodes.map((node) => node.agentId)), [displayedWorkflow.nodes])
  const workflowOrchestrators = catalogAgents.filter((agent) => workflowAgentIds.has(agent.id) && agent.productRole === 'orchestrator')
  const hasDistinctCoder = catalogAgents.some((agent) => workflowAgentIds.has(agent.id) && agent.productRole === 'coder')

  const executionPolicy = displayedWorkflow.executionPolicy ?? {
    maxParallelism: Math.max(1, displayedWorkflow.nodes.length),
    maxNodeExecutions: Math.max(1, displayedWorkflow.nodes.length),
  }
  const executionLimitExceeded = !onSaveSession && executionPolicy.maxNodeExecutions < displayedWorkflow.nodes.length
  const managedLocationReady = !managedDraft || managedWorkspace.data?.locationValidation.status === 'ready'
  const startDisabled = startRunMutation.isPending || startManagedRun.isPending || !managedLocationReady
    || Boolean(activeRunId && runQuery.data?.run.executionState !== 'completed')
  const runActive = Boolean(activeRunId && runQuery.data?.run.executionState !== 'completed')
  const hasUnsavedAgentSettings = displayedWorkflow.nodes.some((node) => {
    const local = localAgents.find((agent) => agent.id === node.agentId)
    const persisted = agents.find((agent) => agent.id === node.agentId)
    return local && (!persisted || (['harness', 'model', 'effort', 'fastMode', 'configurationVersionId'] as const)
      .some((key) => local[key] !== persisted[key]))
  })
  const hasLocalChanges = draft?.dirty === true || hasSessionCleanup
    || Object.keys(agentOverrides).length > 0 || hasUnsavedAgentSettings
  const hasUnpublishedChanges = Boolean(managedDraft && !managedDraftIsPublished(managedDraft))
  const hasPendingSave = managedSaveQueue.hasPending(workflowKey)
  const needsAgentBeforeSave = Boolean(managedDraft && displayedWorkflow.nodes.length === 0 && !hasPendingSave)
  const isDirty = hasLocalChanges || hasUnpublishedChanges || hasPendingSave
  const showGraphActions = hasLocalChanges || (hasUnpublishedChanges && !needsAgentBeforeSave) || hasPendingSave
  const saveDisabled = isSaving
  const recordUndo = useCallback(() => {
    undoStackRef.current.push({ workflow: displayedWorkflow, agentOverrides, managedBase, cloneSources: draft?.cloneSources })
    if (undoStackRef.current.length > 100) undoStackRef.current.shift()
  }, [agentOverrides, displayedWorkflow, draft?.cloneSources, managedBase])
  const applyBoardChange = useCallback((
    change: (saved: WorkflowDefinition) => WorkflowDefinition,
    changedAgents: readonly Agent[] = [],
    cloneSources: CloneSources = {},
  ) => {
    recordUndo()
    updateDraft(workflowKey, sessionCleanedWorkflow, change, changedAgents, managedBase, cloneSources)
  }, [managedBase, recordUndo, sessionCleanedWorkflow, updateDraft, workflowKey])
  useEffect(() => {
    const base = draft?.managedBase
    if (!managedDraft || !base || managedSaving) return
    if (base.draft.id !== managedDraft.id || base.draft.revision !== managedDraft.revision) {
      setNotice({ kind: 'error', text: 'This shared draft changed elsewhere. Your unsent edits are preserved. Discard local edits to load the latest draft, or keep them for comparison.' })
    }
  }, [draft?.managedBase, managedDraft, managedSaving])
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
          onOpenSettings: undefined,
          onRemove: undefined,
          onSaveSettings: undefined,
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

  const selectAgent = useCallback((agentId: string, workflowNodeId: string, additive: boolean) => {
    if (additive) {
      connectionSourceNodeRef.current = undefined
      const next = new Set(selectedNodeIds)
      if (next.has(workflowNodeId)) next.delete(workflowNodeId)
      else next.add(workflowNodeId)
      setSelectedNodeIds(next)
      const lastSelectedNodeId = [...next].at(-1)
      const lastSelectedAgentId = displayedWorkflow.nodes.find((node) => node.id === lastSelectedNodeId)?.agentId
      if (lastSelectedAgentId) onSelectAgent?.(lastSelectedAgentId)
      else onClearAgent?.()
      return
    }
    setSelectedNodeIds(new Set([workflowNodeId]))
    onSelectAgent?.(agentId)
    const sourceNodeId = connectionSourceNodeRef.current
    connectionSourceNodeRef.current = workflowNodeId
    if (!sourceNodeId || sourceNodeId === workflowNodeId) return
    if (!displayedWorkflow.nodes.some((node) => node.id === sourceNodeId)
      || !displayedWorkflow.nodes.some((node) => node.id === workflowNodeId)
      || hasConnection(displayedWorkflow.edges, sourceNodeId, workflowNodeId)) return

    const nextEdge = makeWorkflowHandoffEdge(sourceNodeId, workflowNodeId)
    applyBoardChange((saved) => ({ ...saved, edges: [...saved.edges, nextEdge] }))
    setEnteringEdgeId(nextEdge.id)
  }, [applyBoardChange, displayedWorkflow.edges, displayedWorkflow.nodes, onClearAgent, onSelectAgent, selectedNodeIds])

  const openNodeSettings = useCallback((agentId: string, workflowNodeId: string) => {
    connectionSourceNodeRef.current = undefined
    setSelectedNodeIds(new Set([workflowNodeId]))
    onSelectAgent?.(agentId)
  }, [onSelectAgent])

  /** Removes one connection edge and keeps its projected copy for the exit animation. */
  const removeGraphEdge = useCallback((edgeId: string) => {
    const removedEdge = workflowToGraph({ workflow: displayedWorkflow, agents: catalogAgents })
      .edges
      .find((edge) => edge.id === edgeId)
    if (removedEdge) startDeparture([], [removedEdge])
    applyBoardChange((saved) => ({
      ...saved,
      edges: saved.edges.filter((edge) => edge.id !== edgeId),
    }))
  }, [applyBoardChange, catalogAgents, displayedWorkflow, startDeparture])

  const resizeGraphNode = useCallback((workflowNodeId: string, width: number, height: number) => {
    applyBoardChange((saved) => resizeWorkflowNode(saved, workflowNodeId, width, height))
  }, [applyBoardChange])

  const removeGraphNodes = useCallback((workflowNodeIds: ReadonlySet<string>) => {
    if (workflowNodeIds.size === 0) return
    const projection = workflowToGraph({ workflow: displayedWorkflow, agents: catalogAgents })
    const removedNodes = projection.nodes.filter((node) => workflowNodeIds.has(node.id))
    const removedEdges = projection.edges.filter(
      (edge) => workflowNodeIds.has(edge.source) || workflowNodeIds.has(edge.target),
    )
    startDeparture(removedNodes, removedEdges)
    applyBoardChange((saved) => ({
      ...saved,
      nodes: saved.nodes.filter((node) => !workflowNodeIds.has(node.id)),
      edges: saved.edges.filter(
        (edge) => !workflowNodeIds.has(edge.source) && !workflowNodeIds.has(edge.target),
      ),
    }))
    if (connectionSourceNodeRef.current && workflowNodeIds.has(connectionSourceNodeRef.current)) {
      connectionSourceNodeRef.current = undefined
    }
    setSelectedNodeIds(new Set())
    setOpenMenuNodeId(undefined)
    onClearAgent?.()
  }, [applyBoardChange, catalogAgents, displayedWorkflow, onClearAgent, startDeparture])

  const removeGraphNode = useCallback((workflowNodeId: string) => {
    removeGraphNodes(new Set([workflowNodeId]))
  }, [removeGraphNodes])

  const saveNodeSettings = useCallback((
    workflowNodeId: string,
    agent: Agent,
    initialPrompt: string | undefined,
    executionPolicy: WorkflowExecutionPolicy,
  ) => {
    applyBoardChange((saved) => ({
      ...saved,
      executionPolicy,
      nodes: saved.nodes.map((node) => node.id === workflowNodeId
        ? {
            ...node,
            agentId: agent.id,
            name: agent.name,
            initialPrompt,
          }
        : node),
    }), [agent])
  }, [applyBoardChange])

  const graph = useMemo(
    () => workflowToGraph(
      { workflow: displayedWorkflow, agents: catalogAgents },
      {
        selectedAgentId,
        selectedNodeIds,
        runStatesByNodeId,
        runOutcomesByNodeId,
        onSelectAgent: selectAgent,
        onOpenNodeSettings: openNodeSettings,
        onRemoveEdge: removeGraphEdge,
        onRemoveNode: removeGraphNode,
        onSaveNodeSettings: saveNodeSettings,
        onResizeNode: resizeGraphNode,
        runFacts,
        enteringNodeIds,
      },
    ),
    [catalogAgents, displayedWorkflow, enteringNodeIds, openNodeSettings, removeGraphEdge, removeGraphNode, resizeGraphNode, runFacts, runOutcomesByNodeId, runStatesByNodeId, saveNodeSettings, selectAgent, selectedAgentId, selectedNodeIds],
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
      updateDraft(workflowKey, sessionCleanedWorkflow, (savedDraft) => graphToWorkflow(savedDraft, nextNodes, nextEdges), [], managedBase)
    },
    [managedBase, sessionCleanedWorkflow, updateDraft, workflowKey],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<GraphNode>[]) => {
      const positionChanges = changes.filter(
        (change): change is NodePositionChange => change.type === 'position' && change.position !== undefined,
      )
      if (positionChanges.length === 0) return
      if (!positionUndoActiveRef.current) {
        recordUndo()
        positionUndoActiveRef.current = true
      }
      const nextNodes = applyNodeChanges(positionChanges, graph.nodes)
      updateFromGraph(nextNodes, graph.edges)
      if (positionChanges.every((change) => change.dragging !== true)) {
        positionUndoActiveRef.current = false
      }
    },
    [graph.edges, graph.nodes, recordUndo, updateFromGraph],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return
      if (!graph.nodes.some((node) => node.id === connection.source) || !graph.nodes.some((node) => node.id === connection.target)) return
      if (hasConnection(graph.edges, connection.source, connection.target)) return
      const nextEdge = {
        ...makeSequentialHandoffEdge(connection.source, connection.target),
        sourceHandle: connection.sourceHandle, targetHandle: connection.targetHandle,
      }
      applyBoardChange((saved) => graphToWorkflow(saved, graph.nodes, addEdge(nextEdge, graph.edges)))
      setEnteringEdgeId(nextEdge.id)
    },
    [applyBoardChange, graph.edges, graph.nodes],
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
    if (saveLock.current || managedSaveQueue.isRunning(workflowKey)) return
    try { managedSaveQueue.discard(workflowKey) } catch (error) {
      setNotice({ kind: 'error', text: graphErrorMessage(error, 'Resolve the pending save before discarding.') })
      return
    }
    connectionSourceNodeRef.current = undefined
    discardDraft(workflowKey)
    undoStackRef.current = []
    positionUndoActiveRef.current = false
    setSelectedNodeIds(new Set())
    onClearAgent?.()
    setNotice(undefined)
  }, [discardDraft, onClearAgent, workflowKey])

  const handleSave = useCallback(async () => {
    if (!isDirty || saveLock.current || managedSaveQueue.isRunning(workflowKey)) return
    if (needsAgentBeforeSave) {
      setNotice({ kind: 'error', text: 'Add an Agent before saving this workflow.' })
      return
    }
    if (executionLimitExceeded && !managedSaveQueue.hasPending(workflowKey)) {
      setNotice({ kind: 'error', text: 'Review the execution limit before saving this graph.' })
      return
    }
    saveLock.current = true
    const generation = sessionGeneration()
    const submittedWorkflow = displayedWorkflow
    const submitted: GraphSaveSnapshot = {
      workflow: submittedWorkflow, agentOverrides, managedBase, cloneSources: draft?.cloneSources,
    }
    const referencedAgentIds = new Set(submittedWorkflow.nodes.map((node) => node.agentId))
    const persistedAgentIds = new Set(agents.map((agent) => agent.id))
    const submittedLocalAgents = localAgents.filter((agent) => referencedAgentIds.has(agent.id) && !persistedAgentIds.has(agent.id))
    const submittedAgents = [...new Map([
      ...submittedLocalAgents,
      ...Object.values(agentOverrides).filter((agent) => referencedAgentIds.has(agent.id)),
    ].map((agent) => [agent.id, agent])).values()]
    setNotice(undefined)
    try {
      if (onSaveSession) {
        const directory = useAgentDirectoryStore.getState()
        const localById = new Map((directory.catalogs[workspaceId]?.localAgents ?? readLocalAgents(workspaceId)).map((agent) => [agent.id, agent]))
        for (const agent of submittedAgents) localById.set(agent.id, agent)
        directory.setLocalAgents(workspaceId, [...localById.values()])
        onSaveSession(submittedWorkflow)
        completeSave(workflowKey, submitted, submittedWorkflow, submittedAgents)
        if (!getGraphDraft(workflowKey)) { undoStackRef.current = []; positionUndoActiveRef.current = false }
        setNotice({ kind: 'success', text: getGraphDraft(workflowKey)
          ? 'Saved to this browser session. Newer local changes remain unsaved.' : 'Workflow saved to this browser session.' })
        return
      }
      if (managedDraft && managedBase) {
        await managedSaveQueue.run(workflowKey, () => {
          // Retrying an uncertain response skips preparation and reuses its
          // exact command ID, payload and acknowledged batch revision.
          assertManagedBase(managedBase, managedDraft)
          const nextAgents = [...new Map([...catalogAgents, ...submittedAgents].map((agent) => [agent.id, agent])).values()]
          return {
            submitted: { ...submitted, agentOverrides: { ...agentOverrides, ...Object.fromEntries(submittedAgents.map((agent) => [agent.id, agent])) } },
            base: managedBase,
            operations: managementGraphOperations({
              base: managedBase.draft.graph, next: submittedWorkflow,
              baseAgents: managedBase.agents, nextAgents,
              metadataRevisions: managedBase.metadataRevisions, cloneSources: draft?.cloneSources,
            }),
          }
        }, {
          apply: applyManagedGraphDraft,
          save: saveManagedGraphDraft,
          assertSession: () => assertSession(generation),
          setSaving: (saving) => useGraphDraftStore.getState().setManagedSaving(workflowKey, saving),
          onApplied: (base) => {
            useGraphDraftStore.getState().acknowledgeManagedBase(workflowKey, base)
            // Keep only the draft cache here. The atomic context read will
            // refresh persisted agents; staged agents are in base itself.
            queryClient.setQueryData(queryKeys.managedDraft(workspaceId, submittedWorkflow.id), base.draft)
            cacheManagedBase(queryClient, base)
          },
          onSaved: (plan, saved, base) => {
            const savedWorkflow = saved.value.version.definition
            const savedAgents = saved.value.agents.map((item) => item.agent)
            // Publication is acknowledged before optional cache refreshes.
            completeSave(workflowKey, plan.submitted, savedWorkflow, savedAgents, base)
            queryClient.setQueryData(queryKeys.managedDraft(workspaceId, savedWorkflow.id), saved.value.draft)
            queryClient.setQueryData(queryKeys.workflow(workspaceId, savedWorkflow.id), { workflow: savedWorkflow })
            cacheManagedBase(queryClient, base)
            updateWorkspaceDetailsCache(queryClient, workspaceId, savedWorkflow, base.agents)
            // Clear pre-publication Undo snapshots, including after navigation.
            // Newer edits remain in the workflow-scoped buffer with the new base.
            undoStackRef.current = []
            positionUndoActiveRef.current = false
            const localIds = new Set(savedAgents.map((agent) => agent.id))
            const directory = useAgentDirectoryStore.getState()
            const currentLocal = directory.catalogs[workspaceId]?.localAgents ?? readLocalAgents(workspaceId)
            if (currentLocal.some((agent) => localIds.has(agent.id))) {
              directory.setLocalAgents(workspaceId, currentLocal.filter((agent) => !localIds.has(agent.id)))
            }
            setNotice({ kind: 'success', text: getGraphDraft(workflowKey)
              ? 'Graph saved. Newer local changes remain unsaved.' : 'Graph saved.' })
            void Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.managedAgents(workspaceId) }),
              queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }),
              queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) }),
              queryClient.invalidateQueries({ queryKey: queryKeys.managedGraphContext(workspaceId, savedWorkflow.id) }),
            ]).catch(() => undefined)
            try { onPersisted?.(savedWorkflow) } catch {
              setNotice({ kind: 'info', text: 'Graph saved. Reload to refresh the surrounding view.' })
            }
          },
        })
        return
      }
      const { workflow: savedWorkflow, agents: savedAgents } = await saveMutation.mutateAsync({
        workspaceId, workflow: submittedWorkflow, agents: submittedAgents,
      })
      assertSession(generation)
      queryClient.setQueryData(queryKeys.workflow(workspaceId, savedWorkflow.id), { workflow: savedWorkflow })
      updateWorkspaceDetailsCache(queryClient, workspaceId, savedWorkflow, savedAgents)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId), refetchType: 'none' })
      completeSave(workflowKey, submitted, savedWorkflow, savedAgents ?? [])
      if (submittedLocalAgents.length > 0) {
        const submittedLocalIds = new Set(submittedLocalAgents.map((agent) => agent.id))
        const directory = useAgentDirectoryStore.getState()
        const currentLocalAgents = directory.catalogs[workspaceId]?.localAgents ?? readLocalAgents(workspaceId)
        directory.setLocalAgents(workspaceId, currentLocalAgents.filter((agent) => !submittedLocalIds.has(agent.id)))
      }
      if (!getGraphDraft(workflowDraftKey(workspaceId, savedWorkflow.id))) {
        undoStackRef.current = []; positionUndoActiveRef.current = false
      }
      setNotice({ kind: 'success', text: getGraphDraft(workflowDraftKey(workspaceId, savedWorkflow.id))
        ? 'Graph saved. Newer local changes remain unsaved.' : 'Graph saved.' })
      onPersisted?.(savedWorkflow)
    } catch (error) {
      if (sessionGeneration() !== generation) return
      const retry = managedSaveQueue.hasPending(workflowKey)
        ? ' Retry Save graph to resolve the previous request before discarding or starting.' : ''
      setNotice({ kind: 'error', text: `Graph could not be saved: ${graphErrorMessage(error, 'The server rejected the graph.')}${retry}` })
    } finally { saveLock.current = false }
  }, [agentOverrides, agents, catalogAgents, completeSave, displayedWorkflow, draft?.cloneSources,
    executionLimitExceeded, isDirty, localAgents, managedBase, managedDraft, needsAgentBeforeSave, onPersisted,
    onSaveSession, queryClient, saveMutation, workspaceId, workflowKey])

  useUnsavedChanges({ label: 'workflow graph', dirty: hasLocalChanges, busy: isSaving,
    uncertain: managedSaveQueue.hasPending(workflowKey),
    error: notice?.kind === 'error' ? notice.text : undefined, save: handleSave, discard: handleDiscard,
  }, (current, next) => current.pathname !== next.pathname || current.search.workflowId !== next.search.workflowId)

  const handleStart = useCallback(() => {
    if (onSaveSession) {
      setNotice({ kind: 'info', text: 'Save this workflow to the backend before starting it.' })
      return
    }
    if (isDirty || saveLock.current || managedSaveQueue.isRunning(workflowKey)
      || (managedDraft && !managedDraftIsPublished(managedDraft))) {
      setNotice({ kind: 'info', text: 'Save the displayed graph before starting the workflow.' })
      return
    }
    if (startLock.current || startDisabled) return
    startLock.current = true
    setNotice(undefined)
    const callbacks = {
      onSuccess: ({ run }: { run: { id: string } }) => {
        setActiveRunId(run.id)
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
        setNotice({ kind: 'info' as const, text: `Run ${run.id} was queued.` })
      },
      onError: (error: Error) => {
        startLock.current = false
        setNotice({ kind: 'error' as const, text: `Workflow could not start: ${graphErrorMessage(error, 'The backend rejected the run.')}` })
      },
    }
    if (managedDraft?.baseWorkflowVersionId) {
      const expectedLocationRevision = managedWorkspace.data?.locationRevision
      if (expectedLocationRevision === undefined || managedWorkspace.data?.locationValidation.status !== 'ready') {
        startLock.current = false
        setNotice({ kind: 'info', text: 'Set a valid workspace execution location before starting this workflow.' })
        return
      }
      startManagedRun.mutate({
        workspaceId, workflowId: displayedWorkflow.id, workflowVersionId: managedDraft.baseWorkflowVersionId,
        expectedLocationRevision, commandId: crypto.randomUUID(), input: {},
        draftId: managedDraft.id, expectedDraftRevision: managedDraft.revision,
      }, callbacks)
      return
    }
    if (managedDraft) {
      startLock.current = false
      setNotice({ kind: 'info', text: 'Save this graph to create its first runnable version.' })
      return
    }
    startRunMutation.mutate(
      { workspaceId, workflowId: displayedWorkflow.id, expectedLocationRevision: 0, input: {} },
      callbacks,
    )
  }, [displayedWorkflow.id, isDirty, managedDraft, managedWorkspace.data, onSaveSession, queryClient, startDisabled, startManagedRun, startRunMutation, workflowKey, workspaceId])

  const closeAgentPicker = useCallback(() => {
    setAgentPickerOpen(false)
    addAgentButtonRef.current?.focus()
  }, [])

  useDismissableSurface({
    open: agentPickerOpen,
    onDismiss: closeAgentPicker,
    surfaceRef: agentPickerRef,
    triggerRef: addAgentButtonRef,
    dismissOnEscape: false,
  })

  const addAgentToGraph = useCallback((agent: Agent, initialPrompt?: string) => {
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

    applyBoardChange((saved) => ({
      ...saved,
      nodes: [...saved.nodes, {
        id: nodeId,
        agentId: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        position,
        ...(initialPrompt ? { initialPrompt } : {}),
      }],
    }), [agent])
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
    setSelectedNodeIds(new Set([nodeId]))
    onSelectAgent?.(agent.id)
    closeAgentPicker()
  }, [applyBoardChange, closeAgentPicker, displayedWorkflow, onSelectAgent])

  const copySelectedGraph = useCallback(() => {
    if (selectedNodeIds.size === 0) return
    const selectedNodes = displayedWorkflow.nodes.filter((node) => selectedNodeIds.has(node.id))
    if (selectedNodes.length === 0) return
    const agentsById = new Map(catalogAgents.map((agent) => [agent.id, agent]))
    copiedGraphRef.current = {
      nodes: selectedNodes.map((node) => ({
        node,
        agent: agentsById.get(node.agentId) ?? { id: node.agentId, name: node.name ?? node.label ?? node.agentId },
      })),
      edges: displayedWorkflow.edges.filter(
        (edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target),
      ),
    }
    setNotice({
      kind: 'info',
      text: `Copied ${selectedNodes.length} agent${selectedNodes.length === 1 ? '' : 's'}.`,
    })
  }, [catalogAgents, displayedWorkflow.edges, displayedWorkflow.nodes, selectedNodeIds])

  const pasteCopiedGraph = useCallback(() => {
    const copied = copiedGraphRef.current
    if (!copied || copied.nodes.length === 0) return
    const nodeIdMap = new Map<string, string>()
    const workingNodes = [...displayedWorkflow.nodes]
    const namingAgents = [...catalogAgents]
    const pastedAgents: Agent[] = []
    const pastedNodes: WorkflowNode[] = []
    const cloneSources: Record<string, string> = {}

    for (const { node, agent } of copied.nodes) {
      const harness = agent.harness ?? agent.harnessConfiguration?.harness
      const agentId = nextCopiedAgentId(agent)
      const name = harness
        ? nextHarnessAgentName(harness, namingAgents)
        : `${agent.name} copy`
      const pastedAgent: Agent = {
        ...agent,
        id: agentId,
        name,
        configurationVersionId: undefined,
        activeRunId: undefined,
        executionState: undefined,
        status: undefined,
        harnessSummary: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      }
      const nodeId = `node-${agentId}`
      const position = findOpenNodePosition(
        workingNodes,
        {
          x: (node.position?.x ?? 64) + 32,
          y: (node.position?.y ?? 120) + 32,
        },
        node.width,
        node.height,
      )
      const pastedNode: WorkflowNode = {
        ...node,
        id: nodeId,
        agentId,
        name,
        position,
      }
      nodeIdMap.set(node.id, nodeId)
      cloneSources[agentId] = agent.id
      pastedAgents.push(pastedAgent)
      namingAgents.push(pastedAgent)
      pastedNodes.push(pastedNode)
      workingNodes.push(pastedNode)
    }

    const pastedEdges = copied.edges.map((edge) => {
      const source = nodeIdMap.get(edge.source)!
      const target = nodeIdMap.get(edge.target)!
      return {
        ...edge,
        id: `edge-${source}-${target}`,
        source,
        target,
      }
    })
    applyBoardChange((saved) => ({
      ...saved,
      nodes: [...saved.nodes, ...pastedNodes],
      edges: [...saved.edges, ...pastedEdges],
    }), pastedAgents, cloneSources)
    setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)))
    const lastAgent = pastedAgents.at(-1)
    if (lastAgent) onSelectAgent?.(lastAgent.id)
    setNotice({
      kind: 'info',
      text: `Pasted ${pastedNodes.length} agent${pastedNodes.length === 1 ? '' : 's'}.`,
    })
  }, [applyBoardChange, catalogAgents, displayedWorkflow.nodes, onSelectAgent])

  const undoBoardChange = useCallback(() => {
    const previous = undoStackRef.current.pop()
    if (!previous) return
    positionUndoActiveRef.current = false
    connectionSourceNodeRef.current = undefined
    restoreDraft(workflowKey, sessionCleanedWorkflow, previous)
    setSelectedNodeIds(new Set())
    setOpenMenuNodeId(undefined)
    onClearAgent?.()
    setNotice({ kind: 'info', text: 'Undid the previous board change.' })
  }, [onClearAgent, restoreDraft, sessionCleanedWorkflow, workflowKey])

  const handleGraphKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (isEditableKeyboardTarget(event.target)) return
    const key = event.key.toLowerCase()
    const command = event.ctrlKey || event.metaKey
    if (command && !event.shiftKey && key === 'z' && undoStackRef.current.length > 0) {
      event.preventDefault()
      undoBoardChange()
      return
    }
    if (command && key === 'c' && selectedNodeIds.size > 0) {
      event.preventDefault()
      copySelectedGraph()
      return
    }
    if (command && key === 'v' && copiedGraphRef.current) {
      event.preventDefault()
      pasteCopiedGraph()
      return
    }
    if (!command && (event.key === 'Delete' || event.key === 'Backspace') && selectedNodeIds.size > 0) {
      event.preventDefault()
      removeGraphNodes(selectedNodeIds)
    }
  }, [copySelectedGraph, pasteCopiedGraph, removeGraphNodes, selectedNodeIds, undoBoardChange])

  const handlePaneClick = useCallback(() => {
    connectionSourceNodeRef.current = undefined
    setSelectedNodeIds(new Set())
    onClearAgent?.()
  }, [onClearAgent])

  return (
    <section
      className="workflow-graph"
      data-testid="workflow-graph"
      aria-label={`${displayedWorkflow.name} workflow graph`}
      onKeyDown={handleGraphKeyDown}
    >
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
          defaultEdgeOptions={{
            type: AGENT_HANDOFF_EDGE_TYPE,
            selectable: false,
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--n-border-strong)' },
          }}
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

        <div className="workflow-graph-primary-actions">
          <Toolbar label="Workflow controls">
            <Button ref={workflowSettingsButtonRef} variant="secondary" className="n-icon-button workflow-graph-add-agent" aria-label="Workflow settings" title="Workflow settings"
              aria-haspopup="dialog" aria-expanded={workflowSettingsOpen} aria-controls={workflowSettingsOpen ? 'workflow-settings-popover' : undefined}
              onClick={() => void leaveSurface(() => { setAgentPickerOpen(false); setOpenMenuNodeId(undefined); setWorkflowSettingsOpen((open) => !open) })}><Icon name="settings" size={16} /></Button>
            <Link to="/workspaces/$workspaceId/approvals" params={{ workspaceId }} search={{ workflowId: displayedWorkflow.id }} className="workflow-graph-add-agent" aria-label="Workflow Approval Inbox" title="Workflow Approval Inbox"><Inbox aria-hidden="true" size={16} /></Link>
            <Button
              variant="secondary"
              className="n-icon-button workflow-graph-run"
              aria-label={runActive ? 'Cancel workflow' : 'Start workflow'}
              title={runActive ? 'Cancel workflow' : needsAgentBeforeSave ? 'Add an Agent before starting this workflow' : managedLocationReady ? 'Start workflow' : 'Set a valid workspace execution location first'}
              disabled={runActive ? cancelRunMutation.isPending || stopManagedRun.isPending : startDisabled || (Boolean(managedDraft) && (isDirty || isSaving))}
              onClick={runActive && activeRunId
                ? () => managedDraft
                  ? stopManagedRun.mutate({ workspaceId, runId: activeRunId, commandId: crypto.randomUUID() }, {
                      onSuccess: (result) => {
                        setNotice({ kind: result.status === 'not_owner' ? 'error' : 'info', text:
                          result.status === 'not_owner' ? 'This API does not own the running process. Stop was not accepted; use its active owner.' :
                            result.status === 'already_terminal' ? 'The run record is already terminal. Native process exit has not been verified.' :
                              'Cancellation was requested. Native process exit has not yet been verified.' })
                        void queryClient.invalidateQueries({ queryKey: queryKeys.run(workspaceId, activeRunId) })
                      },
                      onError: (error) => setNotice({ kind: 'error', text: graphErrorMessage(error, 'The run could not be canceled.') }),
                    })
                  : cancelRunMutation.mutate({ workspaceId, runId: activeRunId }, {
                      onError: (error) => setNotice({ kind: 'error', text: graphErrorMessage(error, 'The run could not be canceled.') }),
                    })
                : handleStart}
            >
              {runActive ? <Icon name="stop" size={14} /> : <Icon name="play" size={16} />}
            </Button>
            <Button
              ref={addAgentButtonRef}
              variant="secondary"
              className="n-icon-button workflow-graph-add-agent"
              aria-label="Add agent to graph"
              title="Add agent to graph"
              aria-haspopup="dialog"
              aria-expanded={agentPickerOpen}
              onClick={() => void leaveSurface(() => {
                setOpenMenuNodeId(undefined)
                setWorkflowSettingsOpen(false)
                setAgentPickerOpen(true)
              })}
            >
              <Icon name="plus" size={17} />
            </Button>
          </Toolbar>
        </div>

        {workflowSettingsOpen ? <div ref={workflowSettingsRef} id="workflow-settings-popover" className="workflow-settings-popover" role="dialog" aria-modal={false} aria-labelledby="workflow-settings-title">
          <header><div><p className="n-eyebrow">Local override</p><h2 id="workflow-settings-title">Workflow settings</h2></div><IconButton label="Close workflow settings" variant="ghost" onClick={() => closeWorkflowSettings()}><Icon name="close" size={16} /></IconButton></header>
          <Select
            label="Approval handler"
            value={displayedWorkflow.approval?.handler ?? ''}
            options={[
              { value: '', label: 'Select handler', disabled: true },
              { value: 'user', label: 'User' },
              { value: 'orchestrator', label: 'Orchestrator', disabled: !hasDistinctCoder || workflowOrchestrators.length === 0 },
              { value: 'operator', label: 'Operator' },
            ]}
            onChange={(event) => {
              const handler = event.target.value as 'user' | 'orchestrator' | 'operator'
              applyBoardChange((saved) => ({ ...saved, approval: handler === 'orchestrator'
                ? { handler, ...(saved.approval?.handler === 'orchestrator' && saved.approval.designatedOrchestratorAgentId ? { designatedOrchestratorAgentId: saved.approval.designatedOrchestratorAgentId } : {}) }
                : { handler } }))
            }}
          />
          {displayedWorkflow.approval?.handler === 'orchestrator' ? <Select
            label="Designated Orchestrator"
            aria-label="Designated Orchestrator"
            value={displayedWorkflow.approval.designatedOrchestratorAgentId ?? ''}
            options={[
              { value: '', label: 'Choose an Orchestrator' },
              ...(displayedWorkflow.approval.designatedOrchestratorAgentId && !workflowOrchestrators.some((agent) => agent.id === displayedWorkflow.approval?.designatedOrchestratorAgentId)
                ? [{ value: displayedWorkflow.approval.designatedOrchestratorAgentId, label: 'Previously designated Agent is unavailable', disabled: true }]
                : []),
              ...workflowOrchestrators.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
            onChange={(event) => applyBoardChange((saved) => ({ ...saved, approval: { handler: 'orchestrator', designatedOrchestratorAgentId: event.target.value || undefined } }))}
          /> : null}
          {!hasDistinctCoder || workflowOrchestrators.length === 0 ? <Alert live tone="warning" title="Orchestrator handling requires one Orchestrator and a distinct Coder on this board." /> : null}
          <WorkflowExecutionLimits
            key={`${displayedWorkflow.id}:${executionPolicy.maxNodeExecutions}:${executionPolicy.maxParallelism}`}
            value={executionPolicy} nodeCount={displayedWorkflow.nodes.length}
            onApply={(next) => applyBoardChange((saved) => ({ ...saved, executionPolicy: next }))}
          />
          <p>Normal graph edges do not grant approval authority. These workflow settings are pinned when you Save graph.</p>
        </div> : null}

        {showGraphActions ? (
          <div className="workflow-graph-actions">
            <Toolbar label="Graph actions">
              {hasLocalChanges ? <Button variant="secondary" onClick={handleDiscard} disabled={isSaving}>
                {managedDraft ? 'Discard local edits' : 'Discard'}
              </Button> : null}
              <Button variant="primary" onClick={handleSave} disabled={saveDisabled}>
                {isSaving ? 'Saving…' : 'Save graph'}
              </Button>
            </Toolbar>
          </div>
        ) : null}

        <div className="workflow-graph-notifications" data-testid="workflow-graph-notifications">
          {hasPendingSave && !managedSaving ? <Alert live tone="warning" title="The previous save is unresolved. Retry Save graph before discarding local edits or starting." /> : null}
          {notice ? (
            <Alert
              live
              tone={notice.kind === 'error' ? 'danger' : notice.kind === 'success' ? 'success' : 'info'}
              title={notice.text}
            />
          ) : null}
        </div>

        {agentPickerPresence.mounted ? (
          <div
            ref={agentPickerRef}
            className="agent-picker-popover"
            role="dialog"
            aria-labelledby="agent-picker-title"
            data-presence={agentPickerPresence.exiting ? 'exiting' : 'entering'}
            inert={agentPickerPresence.exiting || undefined}
          >
            <div className="agent-picker-heading">
              <div>
                <h2 id="agent-picker-title">Add Agent</h2>
              </div>
              <IconButton label="Close agent picker" variant="ghost" onClick={closeAgentPicker}>
                <Icon name="close" size={17} />
              </IconButton>
            </div>

            {agentDefaultsQuery.isPending && agentDefaultsQuery.fetchStatus !== 'idle' ? (
              <LoadingState label="Loading Agent templates…" rows={2} />
            ) : agentDefaultsQuery.isError ? (
              <ErrorState
                title="Agent templates are unavailable."
                description="The saved harness defaults could not be loaded."
                onRetry={() => void agentDefaultsQuery.refetch()}
                retrying={agentDefaultsQuery.isFetching}
              />
            ) : (
              <div className="harness-picker-grid">
                <Button
                  variant="secondary"
                  data-agent-picker-option
                  leading={<Icon name="bot" size={28} />}
                  onClick={() => addAgentToGraph(defaultAgentForHarness(
                    agentDefaults.orchestrator.harness.harness,
                    nextBoardAgentId(agentDefaults.orchestrator.harness.harness),
                    'Orchestrator',
                    agentDefaults.orchestrator.harness,
                    'orchestrator',
                  ))}
                >
                  Orchestrator
                </Button>
                <Button
                  variant="secondary"
                  data-agent-picker-option
                  leading={<Icon name="code" size={28} />}
                  onClick={() => addAgentToGraph(defaultAgentForHarness(
                    agentDefaults.coder.harness.harness,
                    nextBoardAgentId(agentDefaults.coder.harness.harness),
                    nextCoderAgentName(catalogAgents),
                    agentDefaults.coder.harness,
                    'coder',
                  ))}
                >
                  Coder
                </Button>
              </div>
            )}
          </div>
        ) : null}

      </div>
    </section>
  )
}

export function WorkflowGraph({ workspaceId, workflowId, selectedAgentId, onSelectAgent, onClearAgent }: WorkflowGraphProps) {
  const managedContextQuery = useManagedGraphContextQuery(workspaceId, workflowId)
  const managedAgentsQuery = { ...managedContextQuery, data: managedContextQuery.data?.agents }
  const managedDraftQuery = { ...managedContextQuery, data: managedContextQuery.data?.draft }
  const workspaceQuery = useWorkspaceDetailsQuery(workspaceId)

  if (workspaceQuery.isPending || managedAgentsQuery.isPending || managedDraftQuery.isPending) {
    return (
      <div className="workflow-graph-state" data-testid="workflow-graph-loading">
        <LoadingState label="Loading graph…" rows={3} />
      </div>
    )
  }

  if (
    workspaceQuery.isError ||
    !workspaceQuery.data ||
    managedContextQuery.isError ||
    !managedAgentsQuery.data ||
    !managedDraftQuery.data
  ) {
    return (
      <div className="workflow-graph-state workflow-graph-state-error" data-testid="workflow-graph-error">
        <ErrorState
          title="Graph unavailable"
          description={graphErrorMessage(workspaceQuery.error ?? managedAgentsQuery.error ?? managedDraftQuery.error, 'The workflow could not be loaded.')}
        />
      </div>
    )
  }

  return (
    <GraphEditor
      key={`${workspaceId}:${workflowId}`}
      workspaceId={workspaceId}
      workflow={managedDraftQuery.data.graph}
      agents={[...new Map([
        ...managedAgentsQuery.data!.items.map((item) => item.agent),
        ...managedDraftQuery.data!.stagedAgents.map((item) => item.agent),
      ].map((agent) => [agent.id, agent])).values()]}
      runFacts={workspaceQuery.data.runs}
      selectedAgentId={selectedAgentId}
      onSelectAgent={onSelectAgent}
      onClearAgent={onClearAgent}
      managedDraft={managedDraftQuery.data}
      managedAgentRevisions={Object.fromEntries([
        ...managedAgentsQuery.data!.items.map((item) => [item.agent.id, item.metadataRevision]),
        ...managedDraftQuery.data!.stagedAgents.map((item) => [item.agent.id, item.baseRevision]),
      ])}
    />
  )
}

export { AgentMinimapDot, AgentNode, AgentSettingsForm, HandoffEdge }
