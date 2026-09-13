import { useCallback, useMemo, useState } from 'react'

import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type IsValidConnection,
  type NodeChange,
  type NodePositionChange,
  type NodeProps,
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
  graphToWorkflow,
  hasConnection,
  makeSequentialHandoffEdge,
  sameWorkflow,
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
}

export interface GraphEditorProps {
  workspaceId: string
  workflow: WorkflowDefinition
  agents: readonly Agent[]
  runFacts?: readonly WorkflowRunSummary[]
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
}

function AgentNode({ data, selected, isConnectable }: NodeProps<GraphNode>) {
  const stateText = data.waitLabel
    ? `${data.executionStateLabel} · ${data.waitLabel}`
    : data.executionStateLabel

  return (
    <article
      className={`workflow-agent-node${selected ? ' workflow-agent-node-selected' : ''}`}
      data-testid={`agent-node-${data.agentId}`}
      data-agent-id={data.agentId}
      data-execution-state={data.executionState ?? 'unknown'}
    >
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
      <button
        type="button"
        className="workflow-agent-node-button"
        aria-label={`${data.label} agent, ${stateText}`}
        aria-pressed={selected}
        onClick={() => data.onSelect?.(data.agentId)}
      >
        <span className="workflow-agent-node-eyebrow">Agent step</span>
        <span className="workflow-agent-node-label">{data.label}</span>
        {data.role ? <span className="workflow-agent-node-role">{data.role}</span> : null}
        <span className="workflow-agent-node-state">{stateText}</span>
        {data.description ? <span className="workflow-agent-node-description">{data.description}</span> : null}
      </button>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </article>
  )
}

const nodeTypes = { agent: AgentNode }

function graphErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
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
}: GraphEditorProps) {
  const theme = useTheme()
  const queryClient = useQueryClient()
  const workflowKey = workflowDraftKey(workspaceId, workflow.id)
  const draft = useGraphDraftStore((state) => state.drafts[workflowKey])
  const updateDraft = useGraphDraftStore((state) => state.updateDraft)
  const discardDraft = useGraphDraftStore((state) => state.discardDraft)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>()
  const saveMutation = useSaveGraphMutation()

  const isDirty = draft?.dirty === true
  // Query owns the saved definition. The feature store is consulted only
  // while an unsaved draft exists, so refetches remain visible when clean.
  const currentWorkflow = isDirty && draft ? draft.workflow : workflow
  const selectAgent = useCallback(
    (agentId: string) => onSelectAgent?.(agentId),
    [onSelectAgent],
  )
  const graph = useMemo(
    () => workflowToGraph(
      { workflow: currentWorkflow, agents },
      { selectedAgentId, onSelectAgent: selectAgent, runFacts },
    ),
    [agents, currentWorkflow, runFacts, selectAgent, selectedAgentId],
  )

  const updateFromGraph = useCallback(
    (nextNodes: GraphNode[], nextEdges: GraphEdge[]) => {
      updateDraft(workflowKey, currentWorkflow, (savedDraft) => graphToWorkflow(savedDraft, nextNodes, nextEdges))
    },
    [currentWorkflow, updateDraft, workflowKey],
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
    setNotice({ kind: 'info', text: 'Local graph changes discarded.' })
  }, [discardDraft, workflowKey])

  const handleSave = useCallback(() => {
    if (!isDirty || saveMutation.isPending) return
    const submittedWorkflow = currentWorkflow
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
  }, [currentWorkflow, discardDraft, isDirty, queryClient, saveMutation, workspaceId, workflowKey])

  return (
    <section className="workflow-graph" data-testid="workflow-graph" aria-label={`${currentWorkflow.name} workflow graph`}>
      <header className="workflow-graph-toolbar">
        <div>
          <p className="workflow-graph-kicker">Workflow graph</p>
          <h2>{currentWorkflow.name}</h2>
          <p className="workflow-graph-help">
            Connect steps to propose a sequential output handoff. Edges do not grant permissions, reserve resources, or execute work.
          </p>
        </div>
        <div className="workflow-graph-actions">
          <span className={`workflow-graph-draft-state${isDirty ? ' workflow-graph-draft-state-dirty' : ''}`} role="status">
            {isDirty ? 'Unsaved changes' : 'Saved definition'}
          </span>
          <button type="button" className="workflow-graph-action workflow-graph-action-quiet" onClick={handleDiscard} disabled={!isDirty || saveMutation.isPending}>
            Discard
          </button>
          <button type="button" className="workflow-graph-action workflow-graph-action-primary" onClick={handleSave} disabled={!isDirty || saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : 'Save graph'}
          </button>
        </div>
      </header>

      {notice ? (
        <p className={`workflow-graph-notice workflow-graph-notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      ) : null}

      <div className="workflow-graph-canvas" data-testid="workflow-graph-canvas">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
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
        >
          <Background color={theme === 'dark' ? '#3e474c' : '#deded9'} gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(node) => (node.selected
              ? theme === 'dark' ? '#e1e6e8' : '#3f3f3b'
              : theme === 'dark' ? '#79858b' : '#a8a8a1')}
            maskColor={theme === 'dark' ? 'rgba(17, 20, 22, 0.78)' : 'rgba(255, 255, 255, 0.72)'}
          />
        </ReactFlow>
      </div>
    </section>
  )
}

export function WorkflowGraph({ workspaceId, workflowId, selectedAgentId, onSelectAgent }: WorkflowGraphProps) {
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
    />
  )
}

export { AgentNode }
