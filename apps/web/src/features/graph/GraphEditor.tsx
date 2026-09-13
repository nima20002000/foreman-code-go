import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { MoreHorizontal, Plus, X } from 'lucide-react'

import {
  addEdge,
  Background,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type IsValidConnection,
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
import { useTheme } from '../theme'
import {
  deleteAgentForSession,
  readDeletedAgentIds,
  readLocalAgents,
} from '../agents/localAgents'

import {
  graphToWorkflow,
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
import type { GraphEdge, GraphNode } from './types'
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
}

function AgentNode({ data, selected, isConnectable }: NodeProps<GraphNode>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const closeFromOutside = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node) || triggerRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMenuOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', closeFromOutside)
    window.addEventListener('keydown', closeFromEscape)
    return () => {
      document.removeEventListener('mousedown', closeFromOutside)
      window.removeEventListener('keydown', closeFromEscape)
    }
  }, [menuOpen])

  return (
    <article
      className={`workflow-agent-node${selected ? ' workflow-agent-node-selected' : ''}`}
      data-testid={`agent-node-${data.agentId}`}
      data-agent-id={data.agentId}
      data-execution-state={data.executionState ?? 'unknown'}
      data-connection-armed={data.connectionArmed || undefined}
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
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
      <button
        type="button"
        className="workflow-agent-node-button"
        aria-label={`${data.label} agent, ${data.stepLabel}`}
        aria-pressed={selected}
        aria-describedby={data.connectionArmed ? `connection-source-${data.workflowNodeId}` : undefined}
        onClick={() => data.onSelect?.(data.agentId, data.workflowNodeId)}
      >
        <span className="workflow-agent-node-meta">
          <span>Agent</span>
          <span>{data.stepLabel}</span>
        </span>
        <span className="workflow-agent-node-label">{data.label}</span>
        {data.connectionArmed ? (
          <span className="visually-hidden" id={`connection-source-${data.workflowNodeId}`}>
            Connection source armed. Choose another agent node to create a connection.
          </span>
        ) : null}
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
          setMenuOpen((open) => !open)
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
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </article>
  )
}

const nodeTypes = { agent: AgentNode }

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
  const [armedNodeId, setArmedNodeId] = useState<string>()
  const [localAgents, setLocalAgents] = useState<Agent[]>(() => readLocalAgents(workspaceId))
  const [deletedAgentIds, setDeletedAgentIds] = useState<string[]>(() => readDeletedAgentIds(workspaceId))
  const addAgentButtonRef = useRef<HTMLButtonElement>(null)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const deleteDialogRef = useRef<HTMLDivElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const deleteReturnFocusRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const flowInstanceRef = useRef<ReactFlowInstance<GraphNode, GraphEdge>>(null)
  const saveMutation = useSaveGraphMutation()

  useEffect(() => {
    setLocalAgents(readLocalAgents(workspaceId))
    setDeletedAgentIds(readDeletedAgentIds(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(undefined), 4_000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (!agentPickerOpen) return
    const firstControl = agentPickerRef.current?.querySelector<HTMLElement>('[data-agent-picker-option]')
      ?? agentPickerRef.current?.querySelector<HTMLElement>('button, a[href]')
    firstControl?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setAgentPickerOpen(false)
      addAgentButtonRef.current?.focus()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [agentPickerOpen])

  const closeDeleteConfirmation = useCallback(() => {
    setPendingDelete(undefined)
    window.setTimeout(() => deleteReturnFocusRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!pendingDelete) return
    deleteCancelRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeDeleteConfirmation()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeDeleteConfirmation, pendingDelete])

  // Query owns the saved definition. The feature store is consulted only
  // while an unsaved draft exists, so refetches remain visible when clean.
  const currentWorkflow = draft?.dirty ? draft.workflow : workflow
  const deletedAgentIdSet = useMemo(() => new Set(deletedAgentIds), [deletedAgentIds])
  const displayedWorkflow = useMemo(
    () => withoutAgentReferences(currentWorkflow, deletedAgentIdSet),
    [currentWorkflow, deletedAgentIdSet],
  )
  const hasSessionCleanup = displayedWorkflow !== currentWorkflow
  const savedWorkflowHasSessionCleanup = useMemo(
    () => withoutAgentReferences(workflow, deletedAgentIdSet) !== workflow,
    [deletedAgentIdSet, workflow],
  )
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

  const armedNode = displayedWorkflow.nodes.find((node) => node.id === armedNodeId)
  const selectAgent = useCallback((agentId: string, workflowNodeId: string) => {
    onSelectAgent?.(agentId)
    if (!armedNodeId) {
      setArmedNodeId(workflowNodeId)
      return
    }
    if (armedNodeId === workflowNodeId) {
      setArmedNodeId(undefined)
      setNotice({ kind: 'info', text: 'Connection canceled. Choose a node to start again.' })
      return
    }
    if (!displayedWorkflow.nodes.some((node) => node.id === armedNodeId)
      || !displayedWorkflow.nodes.some((node) => node.id === workflowNodeId)) {
      setArmedNodeId(undefined)
      return
    }
    if (hasConnection(displayedWorkflow.edges, armedNodeId, workflowNodeId)) {
      setArmedNodeId(undefined)
      setNotice({ kind: 'info', text: 'Those agent steps are already connected.' })
      return
    }
    const nextEdge = makeSequentialHandoffEdge(armedNodeId, workflowNodeId)
    updateDraft(workflowKey, displayedWorkflow, (saved) => ({
      ...saved,
      edges: [...saved.edges, {
        id: nextEdge.id,
        source: nextEdge.source,
        target: nextEdge.target,
        ...(typeof nextEdge.label === 'string' ? { label: nextEdge.label } : {}),
      }],
    }))
    setArmedNodeId(undefined)
    setNotice({ kind: 'success', text: 'Agent steps connected. Save the graph to keep this connection.' })
  }, [armedNodeId, displayedWorkflow, onSelectAgent, updateDraft, workflowKey])

  useEffect(() => {
    if (!armedNodeId || agentPickerOpen || pendingDelete) return
    const cancelConnection = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setArmedNodeId(undefined)
      setNotice({ kind: 'info', text: 'Connection canceled.' })
    }
    window.addEventListener('keydown', cancelConnection)
    return () => window.removeEventListener('keydown', cancelConnection)
  }, [agentPickerOpen, armedNodeId, pendingDelete])

  const unlinkGraphNode = useCallback((workflowNodeId: string) => {
    updateDraft(workflowKey, displayedWorkflow, (saved) => ({
      ...saved,
      edges: saved.edges.filter((edge) => edge.source !== workflowNodeId && edge.target !== workflowNodeId),
    }))
  }, [displayedWorkflow, updateDraft, workflowKey])

  const resizeGraphNode = useCallback((workflowNodeId: string, width: number, height: number) => {
    updateDraft(
      workflowKey,
      displayedWorkflow,
      (saved) => resizeWorkflowNode(saved, workflowNodeId, width, height),
    )
  }, [displayedWorkflow, updateDraft, workflowKey])

  const requestDeleteAgent = useCallback((agentId: string, label: string) => {
    deleteReturnFocusRef.current = document.activeElement
      ?.closest('.workflow-agent-node')
      ?.querySelector<HTMLButtonElement>('.workflow-agent-node-menu-trigger') ?? null
    setPendingDelete({ agentId, label })
  }, [])

  const confirmDeleteAgent = useCallback(() => {
    if (!pendingDelete) return
    const { agentId, label } = pendingDelete
    const sessionCatalog = deleteAgentForSession(workspaceId, agentId)
    setLocalAgents(sessionCatalog.localAgents)
    setDeletedAgentIds(sessionCatalog.deletedAgentIds)
    updateDraft(workflowKey, displayedWorkflow, (saved) => withoutAgentReferences(saved, new Set([agentId])))
    if (armedNode?.agentId === agentId) setArmedNodeId(undefined)
    setPendingDelete(undefined)
    setNotice({
      kind: 'info',
      text: `${label} was removed for this browser session and unlinked from every graph step. Save the graph to persist reference cleanup.`,
    })
    window.setTimeout(() => addAgentButtonRef.current?.focus(), 0)
  }, [armedNode?.agentId, displayedWorkflow, pendingDelete, updateDraft, workspaceId, workflowKey])

  const graph = useMemo(
    () => workflowToGraph(
      { workflow: displayedWorkflow, agents: catalogAgents },
      {
        selectedAgentId,
        armedNodeId,
        onSelectAgent: selectAgent,
        onUnlinkNode: unlinkGraphNode,
        onDeleteAgent: requestDeleteAgent,
        onResizeNode: resizeGraphNode,
        runFacts,
      },
    ),
    [armedNodeId, catalogAgents, displayedWorkflow, requestDeleteAgent, resizeGraphNode, runFacts, selectAgent, selectedAgentId, unlinkGraphNode],
  )

  const updateFromGraph = useCallback(
    (nextNodes: GraphNode[], nextEdges: GraphEdge[]) => {
      updateDraft(workflowKey, displayedWorkflow, (savedDraft) => graphToWorkflow(savedDraft, nextNodes, nextEdges))
    },
    [displayedWorkflow, updateDraft, workflowKey],
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
    discardDraft(workflowKey)
    setArmedNodeId(undefined)
    setNotice({
      kind: 'info',
      text: savedWorkflowHasSessionCleanup
        ? 'Other local graph changes were discarded. Session-deleted agents and their references stay removed.'
        : 'Local graph changes discarded.',
    })
  }, [discardDraft, savedWorkflowHasSessionCleanup, workflowKey])

  const handleSave = useCallback(() => {
    if (!isDirty || saveMutation.isPending) return
    const submittedWorkflow = displayedWorkflow
    setNotice(undefined)
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
  }, [discardDraft, displayedWorkflow, isDirty, queryClient, saveMutation, workspaceId, workflowKey])

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
    const position = canvasBox && flowInstanceRef.current
      ? flowInstanceRef.current.screenToFlowPosition({
          x: canvasBox.left + canvasBox.width / 2 - 119,
          y: canvasBox.top + canvasBox.height / 2 - 83,
        })
      : { x: 64 + displayedWorkflow.nodes.length * 330, y: 120 }

    updateDraft(workflowKey, displayedWorkflow, (saved) => ({
      ...saved,
      nodes: [...saved.nodes, {
        id: nodeId,
        agentId: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        position,
      }],
    }))
    setArmedNodeId(undefined)
    closeAgentPicker()
  }, [closeAgentPicker, displayedWorkflow, updateDraft, workflowKey])

  const handlePaneClick = useCallback(() => {
    setArmedNodeId(undefined)
    onClearAgent?.()
  }, [onClearAgent])

  return (
    <section className="workflow-graph" data-testid="workflow-graph" aria-label={`${displayedWorkflow.name} workflow graph`}>
      <div className="workflow-graph-canvas" data-testid="workflow-graph-canvas" ref={canvasRef}>
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
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
          defaultEdgeOptions={{ type: 'smoothstep', selectable: false }}
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
            nodeClassName={(node) => node.selected
              ? 'workflow-graph-minimap-node-selected'
              : 'workflow-graph-minimap-node'}
            nodeColor={(node) => (node.selected
              ? theme === 'dark' ? '#e1e6e8' : '#3f3f3b'
              : theme === 'dark' ? '#79858b' : '#a8a8a1')}
            nodeStrokeColor={(node) => (node.selected
              ? theme === 'dark' ? '#7db7ff' : '#1e5d99'
              : theme === 'dark' ? '#3e474c' : '#deded9')}
            nodeStrokeWidth={3}
            bgColor={theme === 'dark' ? '#22272a' : '#f2f2ef'}
            maskColor={theme === 'dark' ? 'rgba(17, 20, 22, 0.78)' : 'rgba(255, 255, 255, 0.72)'}
          />
        </ReactFlow>

        <button
          ref={addAgentButtonRef}
          type="button"
          className="workflow-graph-add-agent"
          aria-label="Add agent to graph"
          title="Add agent to graph"
          aria-haspopup="dialog"
          aria-expanded={agentPickerOpen}
          onClick={() => {
            setArmedNodeId(undefined)
            setAgentPickerOpen(true)
          }}
        >
          <Plus aria-hidden="true" size={17} />
        </button>

        <div className="workflow-graph-actions" aria-label="Graph actions">
          <button type="button" className="workflow-graph-action workflow-graph-action-quiet" onClick={handleDiscard} disabled={!isDirty || saveMutation.isPending}>
            Discard
          </button>
          <button type="button" className="workflow-graph-action workflow-graph-action-primary" onClick={handleSave} disabled={!isDirty || saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : 'Save graph'}
          </button>
        </div>

        {notice ? (
          <p
            className={`workflow-graph-toast workflow-graph-toast-${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
            aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
          >
            {notice.text}
          </p>
        ) : null}

        {armedNode ? (
          <p className="workflow-graph-connection-status" role="status" aria-live="polite">
            {armedNode.name ?? armedNode.label ?? 'Agent'} is the connection source. Choose another agent node, or press Escape to cancel.
          </p>
        ) : null}

        {agentPickerOpen ? (
          <div
            className="agent-picker-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeAgentPicker()
            }}
          >
            <div
              ref={agentPickerRef}
              className="agent-picker-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="agent-picker-title"
              aria-describedby="agent-picker-description"
              onKeyDown={trapDialogFocus}
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
          </div>
        ) : null}

        {pendingDelete ? (
          <div
            className="agent-picker-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeDeleteConfirmation()
            }}
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
                  <h2 id="agent-delete-title">Delete {pendingDelete.label} from this session?</h2>
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

export { AgentNode }
