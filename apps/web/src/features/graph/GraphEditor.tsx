import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Bot, BotMessageSquare, Check, MoreHorizontal, Play, Plus, Square, Trash2, X } from 'lucide-react'

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
  WorkflowExecutionPolicy,
  WorkflowNode,
  WorkflowRunSummary,
  WorkspaceDetailsResponse,
} from '@graphql/contracts'
import type { GraphDraft as ManagedGraphDraft } from '@graphql/contracts/management'

import {
  useAgentsQuery,
  useHarnessDefaultsQuery,
  useRunQuery,
  useSaveGraphMutation,
  useManagedGraphContextQuery,
  useManagedWorkspaceQuery,
  useStartManagedRunMutation,
  useStopManagedRunMutation,
  useStartWorkflowRunMutation,
  useWorkspaceDetailsQuery,
  useWorkflowQuery,
  queryKeys,
} from '../../shared/api/query'
import { useCancelRunMutation } from '../../shared/api/runActions'
import { applyManagedGraphDraft, saveManagedGraphDraft } from '../../shared/api/client'
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
  executionPolicy = { maxNodeExecutions: 1, maxParallelism: 1 },
  workflowNodeCount = 1,
}: {
  agent: Agent
  initialPrompt?: string
  creationDefaults?: HarnessDefaults
  onClose: () => void
  onRemove?: () => void
  onSave: (agent: Agent, initialPrompt: string | undefined, executionPolicy: WorkflowExecutionPolicy) => void
  executionPolicy?: WorkflowExecutionPolicy
  workflowNodeCount?: number
}) {
  const [name, setName] = useState(agent.name)
  const [harness, setHarness] = useState<NonNullable<Agent['harness']>>(agent.harness ?? 'codex')
  const [model, setModel] = useState(() => initialModel(agent, agent.harness ?? 'codex'))
  const [effort, setEffort] = useState<NonNullable<Agent['effort']>>(agent.effort ?? 'medium')
  const [fastMode, setFastMode] = useState(agent.fastMode ?? false)
  const [codexSandbox, setCodexSandbox] = useState<'read-only' | 'workspace-write' | 'danger-full-access'>(
    agent.harnessConfiguration?.harness === 'codex'
      ? agent.harnessConfiguration.sandbox
      : 'read-only',
  )
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const [maxNodeExecutions, setMaxNodeExecutions] = useState(executionPolicy.maxNodeExecutions)
  const [maxParallelism, setMaxParallelism] = useState(executionPolicy.maxParallelism)
  const trimmedName = name.trim()
  const limitsValid = Number.isInteger(maxNodeExecutions)
    && maxNodeExecutions >= workflowNodeCount
    && Number.isInteger(maxParallelism)
    && maxParallelism >= 1

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
          if (configuration.harness === 'codex') setCodexSandbox(configuration.sandbox)
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
      {harness === 'codex' ? (
        <div className="agent-settings-field"><span>Sandbox</span><select aria-label="Sandbox" value={codexSandbox} onChange={(event) => setCodexSandbox(event.target.value as typeof codexSandbox)}>
          <option value="read-only">Read only</option>
          <option value="workspace-write">Workspace write</option>
          <option value="danger-full-access">Danger: full access</option>
        </select></div>
      ) : null}
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
      <fieldset className="agent-settings-limits">
        <legend>Workflow limits</legend>
        <label>
          Maximum node executions
          <input
            type="number"
            min={workflowNodeCount}
            step={1}
            value={maxNodeExecutions}
            aria-invalid={maxNodeExecutions < workflowNodeCount}
            onChange={(event) => setMaxNodeExecutions(event.target.valueAsNumber)}
          />
        </label>
        <label>
          Maximum parallel agents
          <input
            type="number"
            min={1}
            step={1}
            value={maxParallelism}
            onChange={(event) => setMaxParallelism(event.target.valueAsNumber)}
          />
        </label>
      </fieldset>
      <div className="agent-settings-actions">
        <button
          type="button"
          className="agent-settings-save"
          aria-label="Save agent settings"
          title="Save"
          disabled={!trimmedName || !limitsValid}
          onClick={() => onSave({
            ...agent,
            name: trimmedName,
            harness,
            model,
            effort,
            ...(harness === 'codex' ? { fastMode } : { fastMode: undefined }),
            harnessConfiguration: configuredHarness(
              agent,
              harness,
              model,
              effort,
              fastMode,
              codexSandbox,
              creationDefaults,
            ),
          }, prompt.trim() || undefined, { maxNodeExecutions, maxParallelism })}
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
        {data.runState ? (
          <span className="workflow-agent-node-run-state">{data.runState.replaceAll('_', ' ')}</span>
        ) : null}
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
  const undoStackRef = useRef<GraphSaveSnapshot[]>([])
  const positionUndoActiveRef = useRef(false)
  const agentPickerPresence = usePresence(agentPickerOpen)
  const nodeMenuValue = useMemo(
    () => ({ openMenuNodeId, setOpenMenuNodeId }),
    [openMenuNodeId],
  )
  const saveMutation = useSaveGraphMutation()
  const isSaving = managedSaving || saveMutation.isPending
  const managedBase = useMemo(() => managedDraft
    ? draft?.managedBase ?? captureManagedBase(managedDraft, agents, managedAgentRevisions)
    : undefined, [agents, draft?.managedBase, managedAgentRevisions, managedDraft])
  const managedWorkspace = useManagedWorkspaceQuery(workspaceId, Boolean(managedDraft))
  const harnessDefaultsQuery = useHarnessDefaultsQuery()
  const startRunMutation = useStartWorkflowRunMutation()
  const startManagedRun = useStartManagedRunMutation()
  const stopManagedRun = useStopManagedRunMutation()
  const cancelRunMutation = useCancelRunMutation()
  const runQuery = useRunQuery(workspaceId, activeRunId ?? '', {
    enabled: Boolean(activeRunId),
    refetchInterval: (query) => query.state.data?.run.executionState === 'completed' ? false : 1_000,
  })
  const runStatesByNodeId = useMemo(
    () => new Map(runQuery.data?.executions.map((execution) => [execution.workflowNodeId, execution.state]) ?? []),
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
  const isDirty = hasLocalChanges || hasUnpublishedChanges || managedSaveQueue.hasPending(workflowKey)
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
    [catalogAgents, displayedWorkflow, enteringNodeIds, openNodeSettings, removeGraphEdge, removeGraphNode, resizeGraphNode, runFacts, runStatesByNodeId, saveNodeSettings, selectAgent, selectedAgentId, selectedNodeIds],
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
    if ((!isDirty && onSaveSession) || saveLock.current || managedSaveQueue.isRunning(workflowKey)) return
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
    executionLimitExceeded, isDirty, localAgents, managedBase, managedDraft, onPersisted,
    onSaveSession, queryClient, saveMutation, workspaceId, workflowKey])

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
            aria-label={runActive ? 'Cancel workflow' : 'Start workflow'}
            title={runActive ? 'Cancel workflow' : managedLocationReady ? 'Start workflow' : 'Set a valid workspace execution location first'}
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
            {runActive ? <Square aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={16} />}
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

        {isDirty || managedDraft ? (
          <div className="workflow-graph-actions" aria-label="Graph actions">
            <button type="button" className="workflow-graph-action workflow-graph-action-quiet" onClick={handleDiscard} disabled={!hasLocalChanges || isSaving}>
              {managedDraft ? 'Discard local edits' : 'Discard'}
            </button>
            <button type="button" className="workflow-graph-action workflow-graph-action-primary" onClick={handleSave} disabled={isSaving || (executionLimitExceeded && !managedSaveQueue.hasPending(workflowKey))}>
              {isSaving ? 'Saving…' : 'Save graph'}
            </button>
          </div>
        ) : null}

        <div className="workflow-graph-notifications" data-testid="workflow-graph-notifications">
          {managedSaveQueue.hasPending(workflowKey) && !managedSaving ? <p className="workflow-graph-toast workflow-graph-toast-info" role="status">
            The previous save is unresolved. Retry Save graph before discarding local edits or starting.
          </p> : null}
          {hasUnpublishedChanges ? <p className="workflow-graph-toast workflow-graph-toast-info" role="status">
            The shared draft has unpublished changes. Save graph before starting it.
          </p> : null}
          {runQuery.data?.run.executionLocation ? (
            <p className="workflow-graph-toast workflow-graph-toast-info" role="status">
              Run location: {runQuery.data.run.executionLocation.rootPath}
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
  const realMode = import.meta.env.MODE !== 'test' && (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false')
  const workflowQuery = useWorkflowQuery(workspaceId, workflowId)
  const agentsQuery = useAgentsQuery(workspaceId)
  const managedContextQuery = useManagedGraphContextQuery(workspaceId, workflowId, realMode)
  const managedAgentsQuery = { ...managedContextQuery, data: managedContextQuery.data?.agents }
  const managedDraftQuery = { ...managedContextQuery, data: managedContextQuery.data?.draft }
  const workspaceQuery = useWorkspaceDetailsQuery(workspaceId)

  if (workflowQuery.isPending || agentsQuery.isPending || workspaceQuery.isPending || (realMode && (managedAgentsQuery.isPending || managedDraftQuery.isPending))) {
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
    !workspaceQuery.data ||
    (realMode && (managedContextQuery.isError || !managedAgentsQuery.data || !managedDraftQuery.data))
  ) {
    return (
      <div className="workflow-graph-state workflow-graph-state-error" data-testid="workflow-graph-error" role="alert">
        <p className="workflow-graph-kicker">Workflow graph</p>
        <h2>Graph unavailable</h2>
        <p>{graphErrorMessage(workflowQuery.error ?? agentsQuery.error ?? workspaceQuery.error ?? managedAgentsQuery.error ?? managedDraftQuery.error, 'The workflow could not be loaded.')}</p>
      </div>
    )
  }

  return (
    <GraphEditor
      key={`${workspaceId}:${workflowId}`}
      workspaceId={workspaceId}
      workflow={realMode ? managedDraftQuery.data!.graph : workflowQuery.data.workflow}
      agents={realMode ? [...new Map([
        ...managedAgentsQuery.data!.items.map((item) => item.agent),
        ...managedDraftQuery.data!.stagedAgents.map((item) => item.agent),
      ].map((agent) => [agent.id, agent])).values()] : agentsQuery.data.agents}
      runFacts={workspaceQuery.data.runs}
      selectedAgentId={selectedAgentId}
      onSelectAgent={onSelectAgent}
      onClearAgent={onClearAgent}
      managedDraft={realMode ? managedDraftQuery.data : undefined}
      managedAgentRevisions={realMode ? Object.fromEntries([
        ...managedAgentsQuery.data!.items.map((item) => [item.agent.id, item.metadataRevision]),
        ...managedDraftQuery.data!.stagedAgents.map((item) => [item.agent.id, item.baseRevision]),
      ]) : undefined}
    />
  )
}

export { AgentMinimapDot, AgentNode, AgentSettingsForm, HandoffEdge }
