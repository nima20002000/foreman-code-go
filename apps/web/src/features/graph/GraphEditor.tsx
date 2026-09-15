import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Bot, BotMessageSquare, Check, MoreHorizontal, Play, Plus, Trash2, X } from 'lucide-react'

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
  HarnessDefaults,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRunSummary,
  WorkspaceDetailsResponse,
} from '@graphql/contracts'

import {
  useAgentsQuery,
  useHarnessDefaultsQuery,
  useRunQuery,
  useSaveGraphMutation,
  useStartWorkflowRunMutation,
  useWorkspaceDetailsQuery,
  useWorkflowQuery,
  queryKeys,
} from '../../shared/api/query'
import { useCancelRunMutation } from '../../shared/api/runActions'
import { motionEnabled, usePresence } from '../../shared/ui/usePresence'
import { useDismissableSurface, type SurfaceDismissReason } from '../../shared/ui/useDismissableSurface'
import { useTheme } from '../theme'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import {
  configuredHarness,
  defaultAgentForHarness,
  effortLabels,
  effortOptions,
  initialModel,
  modelOptions,
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
import './graph.css'
import './execution-controls.css'

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
  openMenuNodeId?: string
  setOpenMenuNodeId: (nodeId?: string) => void
}

/**
 * Coordinates the per-node three-dots menus so only one anchored menu can be
 * open at a time, no matter which node owns it.
 */
const NodeMenuContext = createContext<NodeMenuContextValue | undefined>(undefined)

function AgentSettingsForm({
  agent,
  initialPrompt,
  creationDefaults,
  onClose,
  onRemove,
  onSave,
}: {
  agent: Agent
  initialPrompt?: string
  creationDefaults?: HarnessDefaults
  onClose: () => void
  onRemove?: () => void
  onSave: (agent: Agent, initialPrompt?: string) => void
}) {
  const [name, setName] = useState(agent.name)
  const [harness, setHarness] = useState<NonNullable<Agent['harness']>>(agent.harness ?? 'codex')
  const [model, setModel] = useState(() => initialModel(agent, agent.harness ?? 'codex'))
  const [effort, setEffort] = useState<NonNullable<Agent['effort']>>(agent.effort ?? 'medium')
  const [fastMode, setFastMode] = useState(agent.fastMode ?? false)
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const trimmedName = name.trim()

  return (
    <>
      <div className="agent-settings-heading">
        <strong>Agent settings</strong>
        <div>
          {harness === 'codex' ? (
            <label className="agent-settings-fast">
              <input type="checkbox" checked={fastMode} onChange={(event) => setFastMode(event.target.checked)} />
              Fast mode
            </label>
          ) : null}
          {onRemove ? (
            <button type="button" className="agent-settings-trash" aria-label={`Remove ${agent.name} from workflow`} onClick={onRemove}>
              <Trash2 aria-hidden="true" size={16} />
            </button>
          ) : null}
          <button type="button" aria-label="Close agent settings" onClick={onClose}>
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      </div>
      <div className="agent-settings-name agent-settings-control">
        <span>Name</span>
        <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="agent-settings-field"><span>Harness</span><select aria-label="Harness" value={harness} onChange={(event) => {
        const nextHarness = event.target.value as NonNullable<Agent['harness']>
        setHarness(nextHarness)
        if (creationDefaults) {
          const configuration = creationDefaults[nextHarness]
          setModel(configuration.model)
          setEffort(configuration.harness === 'codex' ? configuration.reasoningEffort : configuration.variant)
          setFastMode(configuration.harness === 'codex' && configuration.serviceTier === 'priority')
          return
        }
        const nextModel = modelOptions(nextHarness).includes(model) ? model : modelOptions(nextHarness)[0]!
        setModel(nextModel)
        if (!effortOptions(nextHarness, nextModel).includes(effort)) setEffort(nextHarness === 'codex' ? 'medium' : 'max')
      }}>
        <option value="codex">Codex</option>
        <option value="opencode">OpenCode</option>
      </select></div>
      <div className="agent-settings-field"><span>Model</span><select aria-label="Model" value={model} onChange={(event) => {
        const nextModel = event.target.value
        setModel(nextModel)
        if (!effortOptions(harness, nextModel).includes(effort)) setEffort(harness === 'codex' ? 'medium' : 'max')
      }}>
        {modelOptions(harness).map((value) => <option key={value} value={value}>{value}</option>)}
      </select></div>
      <div className="agent-settings-field"><span>Effort</span><select aria-label="Effort" value={effort} onChange={(event) => setEffort(event.target.value as NonNullable<Agent['effort']>)}>
        {effortOptions(harness, model).map((value) => <option key={value} value={value}>{effortLabels[value]}</option>)}
      </select></div>
      <div className="agent-settings-prompt agent-settings-control">
        <span>Initial prompt</span>
        <textarea
          aria-label="Initial prompt"
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Tell this model what to do when the workflow reaches it."
        />
      </div>
      <div className="agent-settings-actions">
        <button
          type="button"
          className="agent-settings-save"
          aria-label="Save agent settings"
          title="Save"
          disabled={!trimmedName}
          onClick={() => onSave({
            ...agent,
            name: trimmedName,
            harness,
            model,
            effort,
            ...(harness === 'codex' ? { fastMode } : { fastMode: undefined }),
            harnessConfiguration: configuredHarness(agent, harness, model, effort, fastMode, creationDefaults),
          }, prompt.trim() || undefined)}
        >
          <Check aria-hidden="true" size={16} />
        </button>
      </div>
    </>
  )
}

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
    menuRef.current?.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus()
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
        onClick={(event) => data.onSelect?.(
          data.agentId,
          data.workflowNodeId,
          event.ctrlKey || event.metaKey,
        )}
      >
        <span className="workflow-agent-node-meta">
          <span>Agent</span>
          <span>{data.stepLabel}</span>
        </span>
        <span className="workflow-agent-node-label">{data.label}</span>
      </button>
      <button
        type="button"
        ref={triggerRef}
        className="workflow-agent-node-menu-trigger nodrag"
        aria-label={`Open actions for ${data.label}`}
        title="Node actions"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation()
          if (!menuOpen) data.onOpenSettings?.(data.agentId, data.workflowNodeId)
          setMenuOpen(!menuOpen)
        }}
      >
        <MoreHorizontal aria-hidden="true" size={17} />
      </button>
      {menuOpen ? (
        <div ref={menuRef} className="workflow-agent-node-menu agent-directory-card-actions nodrag" role="dialog" aria-label={`${data.label} settings`}>
          <AgentSettingsForm
            agent={data.agent}
            initialPrompt={data.initialPrompt}
            onClose={() => {
              setMenuOpen(false)
              window.setTimeout(() => triggerRef.current?.focus(), 0)
            }}
            onRemove={() => {
              data.onRemove?.(data.workflowNodeId)
              setMenuOpen(false)
            }}
            onSave={(agent, initialPrompt) => {
              data.onSaveSettings?.(data.workflowNodeId, agent, initialPrompt)
              setMenuOpen(false)
              window.setTimeout(() => triggerRef.current?.focus(), 0)
            }}
          />
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
}: GraphEditorProps) {
  const theme = useTheme()
  const queryClient = useQueryClient()
  const workflowKey = workflowDraftKey(workspaceId, workflow.id)
  const draft = useGraphDraftStore((state) => state.drafts[workflowKey])
  const updateDraft = useGraphDraftStore((state) => state.updateDraft)
  const discardDraft = useGraphDraftStore((state) => state.discardDraft)
  const completeSave = useGraphDraftStore((state) => state.completeSave)
  const agentOverrides = draft?.agentOverrides ?? EMPTY_AGENT_OVERRIDES
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>()
  const [activeRunId, setActiveRunId] = useState<string | undefined>(() => runFacts?.find((run) =>
    run.workflowId === workflow.id && run.executionState !== 'completed',
  )?.id)
  const startLock = useRef(Boolean(activeRunId))
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
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
  const agentPickerPresence = usePresence(agentPickerOpen)
  const nodeMenuValue = useMemo(
    () => ({ openMenuNodeId, setOpenMenuNodeId }),
    [openMenuNodeId],
  )
  const saveMutation = useSaveGraphMutation()
  const harnessDefaultsQuery = useHarnessDefaultsQuery()
  const startRunMutation = useStartWorkflowRunMutation()
  const cancelRunMutation = useCancelRunMutation()
  const runQuery = useRunQuery(workspaceId, activeRunId ?? '', {
    enabled: Boolean(activeRunId),
    refetchInterval: (query) => query.state.data?.run.executionState === 'completed' ? false : 1_000,
  })

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
  }, [agentPickerOpen, harnessDefaultsQuery.data])

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
    const catalogById = new Map(agents
      .filter((agent) => !deletedAgentIdSet.has(agent.id))
      .map((agent) => [agent.id, agent]))
    for (const agent of localAgents) {
      if (!deletedAgentIdSet.has(agent.id)) catalogById.set(agent.id, agent)
    }
    for (const agent of Object.values(agentOverrides)) {
      if (!deletedAgentIdSet.has(agent.id)) catalogById.set(agent.id, agent)
    }
    return [...catalogById.values()]
  }, [agentOverrides, agents, deletedAgentIdSet, localAgents])

  const executionPolicy = displayedWorkflow.executionPolicy ?? {
    maxParallelism: Math.max(1, displayedWorkflow.nodes.length),
    maxNodeExecutions: Math.max(1, displayedWorkflow.nodes.length),
  }
  const executionLimitExceeded = !onSaveSession && executionPolicy.maxNodeExecutions < displayedWorkflow.nodes.length
  const startDisabled = startRunMutation.isPending
    || Boolean(activeRunId && runQuery.data?.run.executionState !== 'completed')
  const hasUnsavedAgentSettings = displayedWorkflow.nodes.some((node) => {
    const local = localAgents.find((agent) => agent.id === node.agentId)
    const persisted = agents.find((agent) => agent.id === node.agentId)
    return local && (!persisted || (['harness', 'model', 'effort', 'fastMode', 'configurationVersionId'] as const)
      .some((key) => local[key] !== persisted[key]))
  })
  const isDirty = draft?.dirty === true
    || hasSessionCleanup
    || Object.keys(agentOverrides).length > 0
    || hasUnsavedAgentSettings
  const updateExecutionLimit = (key: 'maxNodeExecutions' | 'maxParallelism', value: number) => {
    if (!Number.isInteger(value) || value < 1) return
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => ({
      ...saved,
      executionPolicy: { ...executionPolicy, [key]: value },
    }))
  }

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
  }, [displayedWorkflow.nodes, onClearAgent, onSelectAgent, selectedNodeIds, sessionCleanedWorkflow, updateDraft, workflowKey])

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

  const removeGraphNodes = useCallback((workflowNodeIds: ReadonlySet<string>) => {
    if (workflowNodeIds.size === 0) return
    const projection = workflowToGraph({ workflow: displayedWorkflow, agents: catalogAgents })
    const removedNodes = projection.nodes.filter((node) => workflowNodeIds.has(node.id))
    const removedEdges = projection.edges.filter(
      (edge) => workflowNodeIds.has(edge.source) || workflowNodeIds.has(edge.target),
    )
    startDeparture(removedNodes, removedEdges)
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => ({
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
  }, [catalogAgents, displayedWorkflow, onClearAgent, sessionCleanedWorkflow, startDeparture, updateDraft, workflowKey])

  const removeGraphNode = useCallback((workflowNodeId: string) => {
    removeGraphNodes(new Set([workflowNodeId]))
  }, [removeGraphNodes])

  const saveNodeSettings = useCallback((workflowNodeId: string, agent: Agent, initialPrompt?: string) => {
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => ({
      ...saved,
      nodes: saved.nodes.map((node) => node.id === workflowNodeId
        ? {
            ...node,
            agentId: agent.id,
            name: agent.name,
            initialPrompt,
          }
        : node),
    }), [agent])
  }, [sessionCleanedWorkflow, updateDraft, workflowKey])

  const graph = useMemo(
    () => workflowToGraph(
      { workflow: displayedWorkflow, agents: catalogAgents },
      {
        selectedAgentId,
        selectedNodeIds,
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
    [catalogAgents, displayedWorkflow, enteringNodeIds, openNodeSettings, removeGraphEdge, removeGraphNode, resizeGraphNode, runFacts, saveNodeSettings, selectAgent, selectedAgentId, selectedNodeIds],
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
    setSelectedNodeIds(new Set())
    onClearAgent?.()
    setNotice(undefined)
  }, [discardDraft, onClearAgent, workflowKey])

  const handleSave = useCallback(async () => {
    if (!isDirty && onSaveSession) return
    if (!onSaveSession && saveMutation.isPending) return
    if (executionLimitExceeded) {
      setNotice({ kind: 'error', text: 'Review the execution limit below before saving this graph.' })
      return
    }
    const submittedWorkflow = displayedWorkflow
    const submitted = { workflow: submittedWorkflow, agentOverrides }
    const referencedAgentIds = new Set(submittedWorkflow.nodes.map((node) => node.agentId))
    const submittedAgents = Object.values(agentOverrides).filter((agent) => referencedAgentIds.has(agent.id))
    setNotice(undefined)

    // Session saves persist both halves to their session-owned stores.
    if (onSaveSession) {
      const directory = useAgentDirectoryStore.getState()
      const localById = new Map((directory.catalogs[workspaceId]?.localAgents ?? readLocalAgents(workspaceId))
        .map((agent) => [agent.id, agent]))
      for (const agent of submittedAgents) localById.set(agent.id, agent)
      directory.setLocalAgents(workspaceId, [...localById.values()])
      onSaveSession(submittedWorkflow)
      completeSave(workflowKey, submitted, submittedWorkflow, submittedAgents)
      setNotice({
        kind: 'success',
        text: getGraphDraft(workflowKey)
          ? 'Saved to this browser session. Newer local changes remain unsaved.'
          : 'Workflow saved to this browser session.',
      })
      return
    }

    try {
      // Await the promise rather than observer callbacks, which are dropped
      // when navigation or first-save promotion unmounts this editor.
      const { workflow: savedWorkflow, agents: savedAgents } = await saveMutation.mutateAsync({
        workspaceId,
        workflow: submittedWorkflow,
        agents: submittedAgents,
      })
      queryClient.setQueryData(queryKeys.workflow(workspaceId, savedWorkflow.id), { workflow: savedWorkflow })
      updateWorkspaceDetailsCache(queryClient, workspaceId, savedWorkflow, savedAgents)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceDetails(workspaceId),
        refetchType: 'none',
      })
      completeSave(workflowKey, submitted, savedWorkflow, savedAgents ?? [])
      setNotice({
        kind: 'success',
        text: getGraphDraft(workflowDraftKey(workspaceId, savedWorkflow.id))
          ? 'Graph saved. Newer local changes remain unsaved.'
          : 'Graph saved.',
      })
      onPersisted?.(savedWorkflow)
    } catch (error) {
      setNotice({
        kind: 'error',
        text: `Graph could not be saved: ${graphErrorMessage(error, 'The server rejected the graph.')}`,
      })
    }
  }, [agentOverrides, completeSave, displayedWorkflow, executionLimitExceeded, isDirty, onPersisted, onSaveSession, queryClient, saveMutation, workspaceId, workflowKey])

  const handleStart = useCallback(() => {
    if (onSaveSession) {
      setNotice({ kind: 'info', text: 'Save this workflow to the backend before starting it.' })
      return
    }
    if (isDirty) {
      setNotice({ kind: 'info', text: 'Save the current graph before starting the workflow.' })
      return
    }
    if (startLock.current || startDisabled) return
    startLock.current = true
    setNotice(undefined)
    startRunMutation.mutate(
      { workspaceId, workflowId: displayedWorkflow.id, input: {} },
      {
        onSuccess: ({ run }) => {
          setActiveRunId(run.id)
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
          setNotice({ kind: 'info', text: `Run ${run.id} was queued.` })
        },
        onError: (error) => {
          startLock.current = false
          setNotice({
            kind: 'error',
            text: `Workflow could not start: ${graphErrorMessage(error, 'The backend rejected the run.')}`,
          })
        },
      },
    )
  }, [displayedWorkflow.id, isDirty, onSaveSession, queryClient, startDisabled, startRunMutation, workspaceId])

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

    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => ({
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
  }, [closeAgentPicker, displayedWorkflow, onSelectAgent, sessionCleanedWorkflow, updateDraft, workflowKey])

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
    updateDraft(workflowKey, sessionCleanedWorkflow, (saved) => ({
      ...saved,
      nodes: [...saved.nodes, ...pastedNodes],
      edges: [...saved.edges, ...pastedEdges],
    }), pastedAgents)
    setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)))
    const lastAgent = pastedAgents.at(-1)
    if (lastAgent) onSelectAgent?.(lastAgent.id)
    setNotice({
      kind: 'info',
      text: `Pasted ${pastedNodes.length} agent${pastedNodes.length === 1 ? '' : 's'}.`,
    })
  }, [catalogAgents, displayedWorkflow.nodes, onSelectAgent, sessionCleanedWorkflow, updateDraft, workflowKey])

  const handleGraphKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (isEditableKeyboardTarget(event.target)) return
    const key = event.key.toLowerCase()
    const command = event.ctrlKey || event.metaKey
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
  }, [copySelectedGraph, pasteCopiedGraph, removeGraphNodes, selectedNodeIds])

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
            disabled={startDisabled}
            onClick={handleStart}
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
            <button type="button" className="workflow-graph-action workflow-graph-action-quiet" onClick={handleDiscard} disabled={!isDirty || (!onSaveSession && saveMutation.isPending)}>
              Discard
            </button>
            <button type="button" className="workflow-graph-action workflow-graph-action-primary" onClick={handleSave} disabled={executionLimitExceeded || (!onSaveSession && saveMutation.isPending)}>
              {!onSaveSession && saveMutation.isPending ? 'Saving…' : 'Save graph'}
            </button>
          </div>
        ) : null}

        <details className="workflow-execution-limits" open={executionLimitExceeded || undefined}>
          <summary>Execution limits</summary>
          <label>
            Maximum node executions
            <input type="number" min={1} step={1} value={executionPolicy.maxNodeExecutions}
              aria-invalid={executionLimitExceeded}
              onChange={(event) => updateExecutionLimit('maxNodeExecutions', event.target.valueAsNumber)} />
          </label>
          <label>
            Maximum parallel agents
            <input type="number" min={1} step={1} value={executionPolicy.maxParallelism}
              onChange={(event) => updateExecutionLimit('maxParallelism', event.target.valueAsNumber)} />
          </label>
          {executionLimitExceeded ? (
            <p role="alert">This graph has {displayedWorkflow.nodes.length} steps, but its execution limit is {executionPolicy.maxNodeExecutions}. Raise the limit explicitly or remove a step before saving.</p>
          ) : <p>These safety limits are saved with each workflow version.</p>}
        </details>

        <div className="workflow-graph-notifications" data-testid="workflow-graph-notifications">
          {activeRunId ? (
            <section className="workflow-run-status" data-testid="workflow-run-status" aria-live="polite">
              <strong>Run {runQuery.data?.run.executionState ?? (runQuery.isError ? 'unavailable' : 'loading')}</strong>
              <span>{activeRunId}</span>
              {runQuery.data?.run.executionState === 'interrupted' ? (
                <p>Execution ownership was lost. Inspect native work before starting again. Cancel closes this run record without replaying the interrupted attempt.</p>
              ) : null}
              {runQuery.data?.run.executionState !== 'completed' ? (
                <button type="button" disabled={cancelRunMutation.isPending}
                  onClick={() => cancelRunMutation.mutate({ workspaceId, runId: activeRunId }, {
                    onError: (error) => setNotice({ kind: 'error', text: graphErrorMessage(error, 'The run could not be canceled.') }),
                  })}>
                  {cancelRunMutation.isPending ? 'Canceling…' : 'Cancel run'}
                </button>
              ) : null}
              {runQuery.isError ? <button type="button" onClick={() => void runQuery.refetch()}>Retry run status</button> : null}
              {runQuery.data?.executions.map((execution) => (
                <span key={execution.id}>
                  {execution.agentId}: {execution.state}
                  {execution.nativeSessionId ? ` · ${execution.nativeSessionId}` : ''}
                </span>
              ))}
              {runQuery.data?.run.result?.output !== undefined ? (
                <pre>{typeof runQuery.data.run.result.output === 'string'
                  ? runQuery.data.run.result.output
                  : JSON.stringify(runQuery.data.run.result.output, null, 2)}</pre>
              ) : null}
            </section>
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
            data-presence={agentPickerPresence.exiting ? 'exiting' : 'entering'}
            inert={agentPickerPresence.exiting || undefined}
          >
            <div className="agent-picker-heading">
              <div>
                <h2 id="agent-picker-title">Add harness</h2>
              </div>
              <button type="button" aria-label="Close agent picker" title="Close" onClick={closeAgentPicker}>
                <X aria-hidden="true" size={17} />
              </button>
            </div>

            {harnessDefaultsQuery.isPending ? (
              <p className="agent-picker-state" role="status">Loading harness defaults…</p>
            ) : harnessDefaultsQuery.isError || !harnessDefaultsQuery.data ? (
              <div className="agent-picker-state" role="alert">
                <p>Harness defaults are unavailable.</p>
                <button type="button" onClick={() => void harnessDefaultsQuery.refetch()}>Retry</button>
              </div>
            ) : (
              <div className="harness-picker-grid">
                <button
                  type="button"
                  data-agent-picker-option
                  onClick={() => addAgentToGraph(defaultAgentForHarness(
                    'codex',
                    nextBoardAgentId('codex'),
                    nextHarnessAgentName('codex', catalogAgents),
                    harnessDefaultsQuery.data.defaults.codex,
                  ))}
                >
                  <Bot aria-hidden="true" size={28} />
                  <span>Codex</span>
                </button>
                <button
                  type="button"
                  data-agent-picker-option
                  onClick={() => addAgentToGraph(defaultAgentForHarness(
                    'opencode',
                    nextBoardAgentId('opencode'),
                    nextHarnessAgentName('opencode', catalogAgents),
                    harnessDefaultsQuery.data.defaults.opencode,
                  ))}
                >
                  <BotMessageSquare aria-hidden="true" size={28} />
                  <span>OpenCode</span>
                </button>
              </div>
            )}
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
      key={`${workspaceId}:${workflowId}`}
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

export { AgentMinimapDot, AgentNode, AgentSettingsForm, HandoffEdge }
