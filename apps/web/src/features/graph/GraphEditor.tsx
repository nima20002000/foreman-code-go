import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import { UnsavedChangesContext, useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Inbox } from 'lucide-react'
import { WorkflowExecutionLimits } from './WorkflowExecutionLimits'
import { EnableTypedDraftButton } from '../workflow-board/EnableTypedDraftButton'
import {
  Alert,
  Button,
  ErrorState,
  Icon,
  IconButton,
  LoadingState,
  Select,
  Toolbar,
} from '../../shared/ui/nocturne'

import type { Connection, IsValidConnection, ReactFlowInstance } from '@xyflow/react'
import { useQueryClient } from '@tanstack/react-query'

import {
  DEFAULT_AGENT_DEFAULTS, isLiveRunState, requiresRunRecovery, runRefetchInterval, type AgentDefaults,
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
  useInteractionsQuery,
  useStartManagedRunMutation,
  useStopManagedRunMutation,
  useStartWorkflowRunMutation,
  useWorkspaceDetailsQuery,
  queryKeys,
} from '../../shared/api/query'
import { useCancelRunMutation } from '../../shared/api/runActions'
import { useApprovalInboxStore } from '../approvals'
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

import { findOpenNodePosition, hasConnection, resizeWorkflowNode, sameWorkflow,
  withoutAgentReferences, workflowToGraph } from './mapper'
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas'
import { GraphPresentationProvider } from './GraphPresentation'
import { GraphRuntimeProvider } from './GraphRuntime'
import { GraphNodeMenuContext } from './graphContexts'
import { useGraphPresentation, useGraphPresentationStore } from './useGraphPresentation'
import { createGraphTopologyProjector } from './topology'
import { applyGraphGeometry, type GraphGeometryChange } from './geometry'
import { useGraphEvent } from './useGraphEvent'
import { useGraphRuntimeFreshness } from './useGraphRuntimeFreshness'
import {
  getGraphDraft,
  useGraphDraftStore,
  workflowDraftKey,
} from './store'
import type { GraphEdge, GraphNode } from './types'
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
const EMPTY_AGENT_OVERRIDES: Record<string, Agent> = {}

function makeWorkflowHandoffEdge(source: string, target: string): WorkflowEdge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
  }
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

function HumanApprovalInboxButton({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const approvals = useInteractionsQuery({ workspaceId, workflowId, status: 'pending', limit: 100 })
  const count = approvals.data?.items.filter((interaction) => interaction.approval.handler === 'user').length ?? 0
  const label = approvals.data?.nextCursor ? `${count}+` : String(count)
  const accessibleCount = count ? `, ${label} pending human approval request${count === 1 ? '' : 's'}` : ''
  return <Button variant="secondary" className="n-icon-button workflow-graph-add-agent workflow-approval-inbox"
    aria-label={`Open human approval inbox${accessibleCount}`} title={count ? `${label} pending human approval request${count === 1 ? '' : 's'}` : 'Human approval inbox'}
    onClick={() => useApprovalInboxStore.getState().openInbox({ workspaceId, workflowId })}>
    <Inbox aria-hidden="true" size={16} />
    {count ? <span className="workflow-approval-inbox-badge" aria-hidden="true">{label}</span> : null}
  </Button>
}

export function GraphEditor(props: GraphEditorProps) {
  return <GraphPresentationProvider key={workflowDraftKey(props.workspaceId, props.workflow.id)}>
    <GraphEditorBody {...props} />
  </GraphPresentationProvider>
}

function GraphEditorBody({
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
  const geometryRef = useRef<GraphCanvasHandle>(null)
  const geometryStartRef = useRef<{ snapshot: GraphSaveSnapshot; generation: ReturnType<typeof sessionGeneration> } | undefined>(undefined)
  const [geometryBase, setGeometryBase] = useState<GraphSaveSnapshot>()
  const [geometryDirty, setGeometryDirty] = useState(false)
  const agentOverrides = draft?.agentOverrides ?? EMPTY_AGENT_OVERRIDES
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>()
  useEffect(() => { if (notice?.kind === 'success') toasts?.notify({ tone: 'success', title: notice.text }) }, [notice, toasts])
  const [startedRun, setStartedRun] = useState<{ scope: string; id: string }>()
  const activeRunId = startedRun?.scope === workflowKey ? startedRun.id : undefined
  const workflowRuns = runFacts?.filter((run) => run.workspaceId === workspaceId && run.workflowId === workflow.id)
  const liveRunId = workflowRuns?.find((run) => isLiveRunState(run.executionState))?.id
  const recoveryRunId = workflowRuns?.find(requiresRunRecovery)?.id
  const displayedRunId = activeRunId ?? liveRunId ?? recoveryRunId
  const startLock = useRef(false)
  useEffect(() => { startLock.current = false }, [workflowKey])
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(false)
  const presentation = useGraphPresentationStore()
  const selectedNodeIds = useGraphPresentation((state) => state.selectedNodeIds)
  const enteringEdgeId = useGraphPresentation((state) => state.enteringEdgeId)
  const { setSelectedNodeIds, setOpenMenuNodeId, setEnteringEdgeId, setEnteringNodeIds, setDepartingNodeIds } = presentation.getState()
  const [departing, setDeparting] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] })
  const agentCatalog = useAgentDirectoryStore((state) => state.catalogs[workspaceId])
  const hydrateAgentWorkspace = useAgentDirectoryStore((state) => state.hydrateWorkspace)
  const localAgents = useMemo(() => agentCatalog?.localAgents ?? readLocalAgents(workspaceId), [agentCatalog?.localAgents, workspaceId])
  const deletedAgentIds = useMemo(() => agentCatalog?.deletedAgentIds ?? readDeletedAgentIds(workspaceId), [agentCatalog?.deletedAgentIds, workspaceId])
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
  const submittedUndoRef = useRef(new WeakMap<GraphSaveSnapshot, Set<GraphSaveSnapshot>>())
  const agentPickerPresence = usePresence(agentPickerOpen)
  const openNodeMenu = useCallback((nodeId?: string) => {
    void leaveSurface(() => {
      if (nodeId) { setWorkflowSettingsOpen(false); setAgentPickerOpen(false) }
      setOpenMenuNodeId(nodeId)
    })
  }, [leaveSurface, setOpenMenuNodeId])
  const openNodeMenuAction = useGraphEvent(openNodeMenu)
  const workflowApprovalHandler = (draft?.workflow ?? workflow).approval?.handler
  const designatedOrchestratorAgentId = (draft?.workflow ?? workflow).approval?.designatedOrchestratorAgentId
  const nodeMenuValue = useMemo(
    () => ({ setOpenMenuNodeId: openNodeMenuAction, workspaceId, workflowApprovalHandler, designatedOrchestratorAgentId }),
    [openNodeMenuAction, workspaceId, workflowApprovalHandler, designatedOrchestratorAgentId],
  )
  const saveMutation = useSaveGraphMutation()
  const isSaving = managedSaving || saveMutation.isPending
  const managedBase = useMemo(() => managedDraft
    ? draft?.managedBase ?? geometryBase?.managedBase ?? captureManagedBase(managedDraft, agents, managedAgentRevisions)
    : undefined, [agents, draft?.managedBase, geometryBase?.managedBase, managedAgentRevisions, managedDraft])
  const managedWorkspace = useManagedWorkspaceQuery(workspaceId, Boolean(managedDraft))
  const agentDefaultsQuery = useAgentDefaultsQuery(import.meta.env.MODE !== 'test')
  const agentDefaults: AgentDefaults = agentDefaultsQuery.data?.value ?? DEFAULT_AGENT_DEFAULTS
  const startRunMutation = useStartWorkflowRunMutation()
  const startManagedRun = useStartManagedRunMutation()
  const stopManagedRun = useStopManagedRunMutation()
  const cancelRunMutation = useCancelRunMutation()
  const runQuery = useRunQuery(workspaceId, displayedRunId ?? '', {
    enabled: Boolean(displayedRunId),
    refetchInterval: (query) => runRefetchInterval(query.state.data),
  })
  useEffect(() => {
    if (activeRunId && runQuery.data?.run.id === activeRunId
      && !['queued', 'running', 'waiting'].includes(runQuery.data.run.executionState)) {
      startLock.current = false
      setStartedRun((current) => current?.scope === workflowKey && current.id === activeRunId ? undefined : current)
    }
  }, [activeRunId, runQuery.data?.run.id, runQuery.data?.run.executionState, workflowKey])

  useEffect(() => {
    const run = runQuery.data?.run
    if (!run || run.id !== activeRunId || run.executionState !== 'completed') return
    startLock.current = false
    setStartedRun(undefined)
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    if (run.outcome === 'succeeded') {
      setNotice({ kind: 'success', text: 'Workflow completed with a durable result.' })
    } else {
      setNotice({
        kind: 'error',
        text: run.stopCause?.error.message ?? run.result?.error?.message ?? `Workflow finished with outcome ${run.outcome}.`,
      })
    }
  }, [activeRunId, queryClient, runQuery.data, workspaceId])

  useEffect(() => {
    if (!enteringEdgeId) return
    const timeout = window.setTimeout(() => setEnteringEdgeId(undefined), CONNECT_MOTION_MS)
    return () => window.clearTimeout(timeout)
  }, [enteringEdgeId, setEnteringEdgeId])

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
  const currentWorkflow = draft?.dirty ? draft.workflow : geometryBase?.workflow ?? workflow
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
  const runActive = Boolean(displayedRunId && (runQuery.data
    ? isLiveRunState(runQuery.data.run.executionState) : displayedRunId !== recoveryRunId))
  const recoveryRequired = Boolean(recoveryRunId || (runQuery.data
    && (runQuery.data.run.executionState === 'interrupted' || runQuery.data.cleanupPending)))
  const stopAvailable = runActive || recoveryRequired
  const stopRunId = runActive ? displayedRunId : recoveryRunId ?? displayedRunId
  const stopCause = runQuery.data ? runQuery.data.run.stopCause
    : (displayedRunId ? workflowRuns?.find((run) => run.id === displayedRunId)?.stopCause : workflowRuns?.[0]?.stopCause)
  const startDisabled = startRunMutation.isPending || startManagedRun.isPending || !managedLocationReady || runActive || recoveryRequired
  const hasUnsavedAgentSettings = displayedWorkflow.nodes.some((node) => {
    const local = localAgents.find((agent) => agent.id === node.agentId)
    const persisted = agents.find((agent) => agent.id === node.agentId)
    return local && (!persisted || (['harness', 'model', 'effort', 'fastMode', 'configurationVersionId'] as const)
      .some((key) => local[key] !== persisted[key]))
  })
  const hasLocalChanges = draft?.dirty === true || geometryDirty || hasSessionCleanup
    || Object.keys(agentOverrides).length > 0 || hasUnsavedAgentSettings
  const hasUnpublishedChanges = Boolean(managedDraft && !managedDraftIsPublished(managedDraft))
  const hasPendingSave = managedSaveQueue.hasPending(workflowKey)
  const needsAgentBeforeSave = Boolean(managedDraft && displayedWorkflow.nodes.length === 0 && !hasPendingSave)
  const isDirty = hasLocalChanges || hasUnpublishedChanges || hasPendingSave
  const showGraphActions = hasLocalChanges || (hasUnpublishedChanges && !needsAgentBeforeSave) || hasPendingSave
  const saveDisabled = isSaving
  const captureEditorSnapshot = useGraphEvent((): GraphSaveSnapshot => {
    const current = getGraphDraft(workflowKey)
    return current ?? { workflow: displayedWorkflow, agentOverrides, managedBase, cloneSources: draft?.cloneSources }
  })
  const recordUndo = useCallback(() => {
    undoStackRef.current.push(captureEditorSnapshot())
    if (undoStackRef.current.length > 100) undoStackRef.current.shift()
  }, [captureEditorSnapshot])
  const beginGeometry = useGraphEvent((dirty: boolean) => {
    if (dirty) setGeometryDirty(true)
    if (geometryStartRef.current) return
    const snapshot = captureEditorSnapshot()
    geometryStartRef.current = { snapshot, generation: sessionGeneration() }
    setGeometryBase(snapshot)
  })
  const cancelGeometry = useGraphEvent(() => {
    geometryStartRef.current = undefined
    setGeometryBase(undefined)
    setGeometryDirty(false)
  })
  const commitGeometry = useGraphEvent((changes: readonly GraphGeometryChange[]) => {
    const started = geometryStartRef.current
    geometryStartRef.current = undefined
    setGeometryBase(undefined)
    setGeometryDirty(false)
    // A teardown after session loss must not recreate a cleared draft.
    if (!started || started.generation !== sessionGeneration()) return
    const before = getGraphDraft(workflowKey) ?? started.snapshot
    const next = applyGraphGeometry(before.workflow, changes)
    if (sameWorkflow(before.workflow, next)) return
    undoStackRef.current.push(before)
    if (undoStackRef.current.length > 100) undoStackRef.current.shift()
    updateDraft(workflowKey, started.snapshot.workflow,
      (saved) => applyGraphGeometry(saved, changes), [], before.managedBase)
  })
  const applyBoardChange = useCallback((
    change: (saved: WorkflowDefinition) => WorkflowDefinition,
    changedAgents: readonly Agent[] = [],
    cloneSources: CloneSources = {},
  ) => {
    geometryRef.current?.flush()
    recordUndo()
    updateDraft(workflowKey, sessionCleanedWorkflow, change, changedAgents, managedBase, cloneSources)
  }, [managedBase, recordUndo, sessionCleanedWorkflow, updateDraft, workflowKey])
  useEffect(() => {
    const base = draft?.managedBase ?? geometryBase?.managedBase
    if (!managedDraft || !base || managedSaving) return
    if (base.draft.id !== managedDraft.id || base.draft.revision !== managedDraft.revision) {
      setNotice({ kind: 'error', text: 'This shared draft changed elsewhere. Your unsent edits are preserved. Discard local edits to load the latest draft, or keep them for comparison.' })
    }
  }, [draft?.managedBase, geometryBase?.managedBase, managedDraft, managedSaving])
  useEffect(() => {
    if (selectedAgentId && deletedAgentIdSet.has(selectedAgentId)) onClearAgent?.()
  }, [deletedAgentIdSet, onClearAgent, selectedAgentId])

  const previousLinkedAgent = useRef<{ value?: string; initialized: boolean }>({ initialized: false })
  useEffect(() => {
    const selected = presentation.getState().selectedNodeIds
    const linkedChanged = !previousLinkedAgent.current.initialized || previousLinkedAgent.current.value !== selectedAgentId
    previousLinkedAgent.current = { value: selectedAgentId, initialized: true }
    if (!linkedChanged) {
      const ids = new Set(displayedWorkflow.nodes.map((node) => node.id))
      if ([...selected].some((id) => !ids.has(id))) setSelectedNodeIds(new Set([...selected].filter((id) => ids.has(id))))
      return
    }
    if (!selectedAgentId) {
      if (linkedChanged) setSelectedNodeIds(new Set())
      return
    }
    const linkedNodes = displayedWorkflow.nodes.filter((node) => node.agentId === selectedAgentId)
    if (!linkedNodes.some((node) => selected.has(node.id))) setSelectedNodeIds(new Set(linkedNodes.map((node) => node.id)))
  }, [displayedWorkflow.nodes, presentation, selectedAgentId, setSelectedNodeIds])

  // Keep removed nodes and edges on the canvas briefly so removal reads as a
  // state change instead of an instant disappear. State sources update right
  // away; the departing copies are display-only.
  const startDeparture = useCallback((nodes: readonly GraphNode[], edges: readonly GraphEdge[]) => {
    if (!motionEnabled() || (nodes.length === 0 && edges.length === 0)) return
    if (departureTimerRef.current !== undefined) window.clearTimeout(departureTimerRef.current)
    setDepartingNodeIds(new Set(nodes.map((node) => node.id)))
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
        data: { explanation: edge.data?.explanation ?? 'Sequential handoff', departing: true },
        selectable: false,
        focusable: false,
      })),
    })
    departureTimerRef.current = window.setTimeout(
      () => { setDepartingNodeIds(new Set()); setDeparting({ nodes: [], edges: [] }) },
      DEPARTURE_MOTION_MS,
    )
  }, [setDepartingNodeIds])

  const selectAgent = useCallback((agentId: string, workflowNodeId: string, additive: boolean) => {
    if (additive) {
      connectionSourceNodeRef.current = undefined
      const next = new Set(presentation.getState().selectedNodeIds)
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
  }, [applyBoardChange, displayedWorkflow.edges, displayedWorkflow.nodes, onClearAgent, onSelectAgent, presentation, setSelectedNodeIds, setEnteringEdgeId])

  const openNodeSettings = useCallback((agentId: string, workflowNodeId: string) => {
    connectionSourceNodeRef.current = undefined
    setSelectedNodeIds(new Set([workflowNodeId]))
    onSelectAgent?.(agentId)
  }, [onSelectAgent, setSelectedNodeIds])

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
    projection.nodes = geometryRef.current?.getNodes() ?? projection.nodes
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
  }, [applyBoardChange, catalogAgents, displayedWorkflow, onClearAgent, startDeparture, setOpenMenuNodeId, setSelectedNodeIds])

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

  const selectAgentAction = useGraphEvent(selectAgent)
  const openNodeSettingsAction = useGraphEvent(openNodeSettings)
  const removeGraphEdgeAction = useGraphEvent(removeGraphEdge)
  const removeGraphNodeAction = useGraphEvent(removeGraphNode)
  const saveNodeSettingsAction = useGraphEvent(saveNodeSettings)
  const resizeGraphNodeAction = useGraphEvent(resizeGraphNode)
  const topologyActions = useMemo(() => ({
    onSelectAgent: selectAgentAction, onOpenNodeSettings: openNodeSettingsAction,
    onRemoveEdge: removeGraphEdgeAction, onRemoveNode: removeGraphNodeAction,
    onSaveNodeSettings: saveNodeSettingsAction, onResizeNode: resizeGraphNodeAction,
  }), [selectAgentAction, openNodeSettingsAction, removeGraphEdgeAction, removeGraphNodeAction, saveNodeSettingsAction, resizeGraphNodeAction])
  const [projectTopology] = useState(createGraphTopologyProjector)
  const graph = useMemo(() => projectTopology(displayedWorkflow, catalogAgents, topologyActions),
    [projectTopology, displayedWorkflow, catalogAgents, topologyActions])
  const expectedVersionId = managedBase?.draft.baseWorkflowVersionId ?? managedDraft?.baseWorkflowVersionId
  const fresh = useGraphRuntimeFreshness(displayedRunId, runQuery.dataUpdatedAt,
    Math.max(5_000, 3 * (runRefetchInterval(runQuery.data) || 1_000)))
  const runtimeUnavailable = !fresh || runQuery.isError || runQuery.fetchStatus === 'paused'
  const runtimeScope = useMemo(() => ({ workspaceId, workflowId: workflow.id, runId: displayedRunId,
    workflowVersionId: expectedVersionId ?? undefined, overlayAllowed: !isDirty, unavailable: runtimeUnavailable }),
  [workspaceId, workflow.id, displayedRunId, expectedVersionId, isDirty, runtimeUnavailable])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return
      if (!graph.nodes.some((node) => node.id === connection.source) || !graph.nodes.some((node) => node.id === connection.target)) return
      if (hasConnection(graph.edges, connection.source, connection.target)) return
      const nextEdge: WorkflowEdge = {
        ...makeWorkflowHandoffEdge(connection.source, connection.target),
        ...(connection.sourceHandle ? { sourceHandle: connection.sourceHandle as WorkflowEdge['sourceHandle'] } : {}),
        ...(connection.targetHandle ? { targetHandle: connection.targetHandle as WorkflowEdge['targetHandle'] } : {}),
      }
      // Geometry flushes first; only the authored connection fields are changed.
      applyBoardChange((saved) => ({ ...saved, edges: [...saved.edges, nextEdge] }))
      setEnteringEdgeId(nextEdge.id)
    },
    [applyBoardChange, graph.edges, graph.nodes, setEnteringEdgeId],
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
    geometryRef.current?.cancel()
    connectionSourceNodeRef.current = undefined
    discardDraft(workflowKey)
    undoStackRef.current = []

    setSelectedNodeIds(new Set())
    onClearAgent?.()
    setNotice(undefined)
  }, [discardDraft, onClearAgent, workflowKey, setSelectedNodeIds])

  const handleSave = useCallback(async () => {
    if (saveLock.current || managedSaveQueue.isRunning(workflowKey)) return
    geometryRef.current?.flush()
    if (!getGraphDraft(workflowKey) && !hasSessionCleanup && !hasUnsavedAgentSettings
      && !hasUnpublishedChanges && !hasPendingSave) return
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
    // Read synchronously after flush, not the render closure from before the last pointer event.
    const submitted = captureEditorSnapshot()
    const submittedWorkflow = submitted.workflow
    const submittedAgentOverrides = submitted.agentOverrides
    const submittedBase = submitted.managedBase
    if (!submittedUndoRef.current.has(submitted)) submittedUndoRef.current.set(submitted, new Set(undoStackRef.current))
    const referencedAgentIds = new Set(submittedWorkflow.nodes.map((node) => node.agentId))
    const persistedAgentIds = new Set(agents.map((agent) => agent.id))
    const submittedLocalAgents = localAgents.filter((agent) => referencedAgentIds.has(agent.id) && !persistedAgentIds.has(agent.id))
    const submittedAgents = [...new Map([
      ...submittedLocalAgents,
      ...Object.values(submittedAgentOverrides).filter((agent) => referencedAgentIds.has(agent.id)),
    ].map((agent) => [agent.id, agent])).values()]
    setNotice(undefined)
    try {
      if (onSaveSession) {
        const directory = useAgentDirectoryStore.getState()
        const localById = new Map((directory.catalogs[workspaceId]?.localAgents ?? readLocalAgents(workspaceId)).map((agent) => [agent.id, agent]))
        for (const agent of submittedAgents) localById.set(agent.id, agent)
        directory.setLocalAgents(workspaceId, [...localById.values()])
        onSaveSession(submittedWorkflow)
        geometryRef.current?.flush()
        completeSave(workflowKey, submitted, submittedWorkflow, submittedAgents)
        const submittedUndo = submittedUndoRef.current.get(submitted)
        undoStackRef.current = submittedUndo ? undoStackRef.current.filter((entry) => !submittedUndo.has(entry)) : []
        setNotice({ kind: 'success', text: getGraphDraft(workflowKey)
          ? 'Saved to this browser session. Newer local changes remain unsaved.' : 'Workflow saved to this browser session.' })
        return
      }
      if (managedDraft && submittedBase) {
        await managedSaveQueue.run(workflowKey, () => {
          // Retrying an uncertain response skips preparation and reuses its
          // exact command ID, payload and acknowledged batch revision.
          assertManagedBase(submittedBase, managedDraft)
          const nextAgents = [...new Map([...catalogAgents, ...submittedAgents].map((agent) => [agent.id, agent])).values()]
          const preparedSubmission = { ...submitted,
            agentOverrides: { ...submittedAgentOverrides, ...Object.fromEntries(submittedAgents.map((agent) => [agent.id, agent])) } }
          submittedUndoRef.current.set(preparedSubmission, new Set(undoStackRef.current))
          return {
            submitted: preparedSubmission,
            base: submittedBase,
            operations: managementGraphOperations({
              base: submittedBase.draft.graph, next: submittedWorkflow,
              baseAgents: submittedBase.agents, nextAgents,
              metadataRevisions: submittedBase.metadataRevisions, cloneSources: submitted.cloneSources,
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
            geometryRef.current?.flush()
            completeSave(workflowKey, plan.submitted, savedWorkflow, savedAgents, base)
            queryClient.setQueryData(queryKeys.managedDraft(workspaceId, savedWorkflow.id), saved.value.draft)
            queryClient.setQueryData(queryKeys.workflow(workspaceId, savedWorkflow.id), { workflow: savedWorkflow })
            cacheManagedBase(queryClient, base)
            updateWorkspaceDetailsCache(queryClient, workspaceId, savedWorkflow, base.agents)
            // Keep post-submission gestures undoable. Retry keeps the same prepared snapshot.
            // restoreDraft already protects the acknowledged concurrency token.
            const submittedUndo = submittedUndoRef.current.get(plan.submitted)
            undoStackRef.current = submittedUndo ? undoStackRef.current.filter((entry) => !submittedUndo.has(entry)) : []

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
      geometryRef.current?.flush()
      completeSave(workflowKey, submitted, savedWorkflow, savedAgents ?? [])
      if (submittedLocalAgents.length > 0) {
        const submittedLocalIds = new Set(submittedLocalAgents.map((agent) => agent.id))
        const directory = useAgentDirectoryStore.getState()
        const currentLocalAgents = directory.catalogs[workspaceId]?.localAgents ?? readLocalAgents(workspaceId)
        directory.setLocalAgents(workspaceId, currentLocalAgents.filter((agent) => !submittedLocalIds.has(agent.id)))
      }
      const submittedUndo = submittedUndoRef.current.get(submitted)
      undoStackRef.current = submittedUndo ? undoStackRef.current.filter((entry) => !submittedUndo.has(entry)) : []
      setNotice({ kind: 'success', text: getGraphDraft(workflowDraftKey(workspaceId, savedWorkflow.id))
        ? 'Graph saved. Newer local changes remain unsaved.' : 'Graph saved.' })
      onPersisted?.(savedWorkflow)
    } catch (error) {
      if (sessionGeneration() !== generation) return
      const retry = managedSaveQueue.hasPending(workflowKey)
        ? ' Retry Save graph to resolve the previous request before discarding or starting.' : ''
      setNotice({ kind: 'error', text: `Graph could not be saved: ${graphErrorMessage(error, 'The server rejected the graph.')}${retry}` })
    } finally { saveLock.current = false }
  }, [agents, catalogAgents, captureEditorSnapshot, completeSave,
    executionLimitExceeded, hasPendingSave, hasSessionCleanup, hasUnpublishedChanges, hasUnsavedAgentSettings,
    localAgents, managedDraft, needsAgentBeforeSave, onPersisted,
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
        setStartedRun({ scope: workflowKey, id: run.id })
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
  }, [applyBoardChange, closeAgentPicker, displayedWorkflow, onSelectAgent, setEnteringNodeIds, setOpenMenuNodeId, setSelectedNodeIds])

  const copySelectedGraph = useCallback(() => {
    if (selectedNodeIds.size === 0) return
    geometryRef.current?.flush()
    const current = captureEditorSnapshot().workflow
    const selectedNodes = current.nodes.filter((node) => selectedNodeIds.has(node.id))
    if (selectedNodes.length === 0) return
    const agentsById = new Map(catalogAgents.map((agent) => [agent.id, agent]))
    copiedGraphRef.current = {
      nodes: selectedNodes.map((node) => ({
        node,
        agent: agentsById.get(node.agentId) ?? { id: node.agentId, name: node.name ?? node.label ?? node.agentId },
      })),
      edges: current.edges.filter(
        (edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target),
      ),
    }
    setNotice({
      kind: 'info',
      text: `Copied ${selectedNodes.length} agent${selectedNodes.length === 1 ? '' : 's'}.`,
    })
  }, [catalogAgents, captureEditorSnapshot, selectedNodeIds])

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
  }, [applyBoardChange, catalogAgents, displayedWorkflow.nodes, onSelectAgent, setSelectedNodeIds])

  const undoBoardChange = useCallback(() => {
    geometryRef.current?.flush()
    const previous = undoStackRef.current.pop()
    if (!previous) return

    connectionSourceNodeRef.current = undefined
    restoreDraft(workflowKey, sessionCleanedWorkflow, previous)
    setSelectedNodeIds(new Set())
    setOpenMenuNodeId(undefined)
    onClearAgent?.()
    setNotice({ kind: 'info', text: 'Undid the previous board change.' })
  }, [onClearAgent, restoreDraft, sessionCleanedWorkflow, workflowKey, setOpenMenuNodeId, setSelectedNodeIds])

  const handleGraphKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (isEditableKeyboardTarget(event.target)) return
    const key = event.key.toLowerCase()
    const command = event.ctrlKey || event.metaKey
    if (command && !event.shiftKey && key === 'z' && (undoStackRef.current.length > 0 || geometryRef.current?.hasPending())) {
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
  }, [onClearAgent, setSelectedNodeIds])
  const connectAction = useGraphEvent(onConnect)
  const validConnection = useGraphEvent(isValidConnection)
  const paneClickAction = useGraphEvent(handlePaneClick)
  const initializeCanvas = useCallback((instance: ReactFlowInstance<GraphNode, GraphEdge>) => { flowInstanceRef.current = instance }, [])

  return (
    <section
      className="workflow-graph"
      data-testid="workflow-graph"
      aria-label={`${displayedWorkflow.name} workflow graph`}
      onKeyDown={handleGraphKeyDown}
    >
      {recoveryRequired ? <Alert live tone="warning" title="Workflow needs recovery">
        <p>An interrupted Run or unfinished native cleanup needs attention. Interrupted Runs are not shown as live work. Stop any remaining native work and finish cleanup before starting another Run.</p>
        {recoveryRunId && recoveryRunId !== stopRunId ? <Button
          disabled={stopManagedRun.isPending || cancelRunMutation.isPending}
          onClick={() => {
            const onError = (error: Error) => setNotice({ kind: 'error' as const, text: graphErrorMessage(error, 'Recovery Stop failed.') })
            if (managedDraft) stopManagedRun.mutate({ workspaceId, runId: recoveryRunId, commandId: crypto.randomUUID() }, {
              onError,
              onSuccess: (result) => {
                setNotice({ kind: result.status === 'not_owner' ? 'error' : 'info', text: result.status === 'not_owner'
                  ? 'Stop was not accepted by this API. Use the active owner.' : 'Stop requested. Native cleanup is not yet confirmed.' })
                void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
              },
            })
            else cancelRunMutation.mutate({ workspaceId, runId: recoveryRunId }, { onError })
          }}>Stop recovery Run</Button> : null}
      </Alert> : null}
      {stopCause ? <Alert tone="danger" title="Orchestrator review failed">
        <p>{stopCause.error.message}</p>
        <p>Finish any pending cleanup, then correct the reviewer settings before starting a new Run.</p>
        <span>Review ID: {stopCause.interactionId}</span>
      </Alert> : null}
      <div className="workflow-graph-canvas" data-testid="workflow-graph-canvas" ref={canvasRef}>
        <GraphNodeMenuContext.Provider value={nodeMenuValue}>
          <GraphRuntimeProvider scope={runtimeScope}>
            <GraphCanvas topology={graph} departing={departing} theme={theme} geometryRef={geometryRef}
              onGeometryStart={beginGeometry} onGeometryCommit={commitGeometry} onGeometryCancel={cancelGeometry}
              onConnect={connectAction} isValidConnection={validConnection} onPaneClick={paneClickAction} onInit={initializeCanvas} />
          </GraphRuntimeProvider>
        </GraphNodeMenuContext.Provider>

        <div className="workflow-graph-primary-actions">
          <Toolbar label="Workflow controls">
            {managedDraft ? <EnableTypedDraftButton /> : null}
            <Button ref={workflowSettingsButtonRef} variant="secondary" className="n-icon-button workflow-graph-add-agent" aria-label="Workflow settings" title="Workflow settings"
              aria-haspopup="dialog" aria-expanded={workflowSettingsOpen} aria-controls={workflowSettingsOpen ? 'workflow-settings-popover' : undefined}
              onClick={() => void leaveSurface(() => { setAgentPickerOpen(false); setOpenMenuNodeId(undefined); setWorkflowSettingsOpen((open) => !open) })}><Icon name="settings" size={16} /></Button>
            <HumanApprovalInboxButton workspaceId={workspaceId} workflowId={displayedWorkflow.id} />
            <Button
              variant="secondary"
              className="n-icon-button workflow-graph-run"
              aria-label={stopAvailable ? runActive ? 'Cancel workflow' : 'Stop workflow for recovery' : 'Start workflow'}
              title={stopAvailable ? runActive ? 'Cancel workflow' : 'Stop this Run to finish recovery' : needsAgentBeforeSave ? 'Add an Agent before starting this workflow' : managedLocationReady ? 'Start workflow' : 'Set a valid workspace execution location first'}
              disabled={stopAvailable ? cancelRunMutation.isPending || stopManagedRun.isPending : startDisabled || (Boolean(managedDraft) && (isDirty || isSaving))}
              onClick={stopAvailable && stopRunId
                ? () => managedDraft
                  ? stopManagedRun.mutate({ workspaceId, runId: stopRunId, commandId: crypto.randomUUID() }, {
                      onSuccess: (result) => {
                        setNotice({ kind: result.status === 'not_owner' ? 'error' : 'info', text:
                          result.status === 'not_owner' ? 'This API does not own the running process. Stop was not accepted; use its active owner.' :
                            result.status === 'already_terminal' ? 'The run record is already terminal. Native process exit has not been verified.' :
                              'Cancellation was requested. Native process exit has not yet been verified.' })
                        void queryClient.invalidateQueries({ queryKey: queryKeys.run(workspaceId, stopRunId) })
                      },
                      onError: (error) => setNotice({ kind: 'error', text: graphErrorMessage(error, 'The run could not be canceled.') }),
                    })
                  : cancelRunMutation.mutate({ workspaceId, runId: stopRunId }, {
                      onError: (error) => setNotice({ kind: 'error', text: graphErrorMessage(error, 'The run could not be canceled.') }),
                    })
                : handleStart}
            >
              {stopAvailable ? <Icon name="stop" size={14} /> : <Icon name="play" size={16} />}
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
            ]}
            onChange={(event) => {
              const handler = event.target.value as 'user' | 'orchestrator'
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
          {displayedWorkflow.approval?.handler === 'orchestrator' ? <Alert tone="info" title="Automatic review setup">
            Every node using routed approval needs a direct edge to the designated Orchestrator. Native Codex self-review remains a separate per-node setting. A Codex Orchestrator needs Ask when needed and Codex automatic review. An OpenCode Orchestrator needs a deny-default policy with explicit allow rules for graphql-app_interaction_get and graphql-app_interaction_respond.
          </Alert> : null}
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
  // Workspace discovery is retained: it finds Runs started outside this tab.
  const workspaceQuery = useWorkspaceDetailsQuery(workspaceId, { refetchInterval: 1_000 })
  const items = managedContextQuery.data?.agents.items
  const staged = managedContextQuery.data?.draft.stagedAgents
  const mergedAgents = useMemo(() => [...new Map([
    ...(items ?? []).map((item) => item.agent), ...(staged ?? []).map((item) => item.agent),
  ].map((agent) => [agent.id, agent])).values()], [items, staged])
  const revisions = useMemo(() => Object.fromEntries([
    ...(items ?? []).map((item) => [item.agent.id, item.metadataRevision]),
    ...(staged ?? []).map((item) => [item.agent.id, item.baseRevision]),
  ]), [items, staged])

  if (workspaceQuery.isPending || managedContextQuery.isPending) {
    return <div className="workflow-graph-state" data-testid="workflow-graph-loading">
      <LoadingState label="Loading graph…" rows={3} />
    </div>
  }
  if (workspaceQuery.isError || !workspaceQuery.data || managedContextQuery.isError || !managedContextQuery.data) {
    return <div className="workflow-graph-state workflow-graph-state-error" data-testid="workflow-graph-error">
      <ErrorState title="Graph unavailable"
        description={graphErrorMessage(workspaceQuery.error ?? managedContextQuery.error, 'The workflow could not be loaded.')} />
    </div>
  }
  return <GraphEditor key={`${workspaceId}:${workflowId}`} workspaceId={workspaceId}
    workflow={managedContextQuery.data.draft.graph} agents={mergedAgents} runFacts={workspaceQuery.data.runs}
    selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} onClearAgent={onClearAgent}
    managedDraft={managedContextQuery.data.draft} managedAgentRevisions={revisions} />
}

export { AgentMinimapDot, AgentNode, HandoffEdge } from './GraphElements'
export { AgentSettingsForm } from './AgentSettingsForm'
