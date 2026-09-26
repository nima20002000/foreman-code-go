import { useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { CurrentWorkspaceDetails } from '@graphql/contracts/wave25'
import { boardSearchForInspection, type WorkspaceBoardInspection, boardSearchForRun, resolveWorkflowBoardLocation, type RepeatGraphScopeV3, type WorkflowBoardLocation } from '@graphql/contracts/wave25'
import { Button, ErrorState } from '../shared/ui/nocturne'
import { PersistedWorkflowBoundary } from '../features/graph/PersistedWorkflowBoundary'
import { WorkflowBoard } from '../features/workflow-board/WorkflowBoard'
import { useProtectedAccessError } from '../features/auth/useProtectedAccessError'
import { clearCurrentRunAccess, revokeCurrentRunWorkspace } from '../features/workflow-board/currentRunQuery'
import { ApiError } from '../shared/api/client'
import { queryKeys, useManagedWorkflowQuery, useWorkspaceDetailsQuery } from '../shared/api/query'
import { WorkspaceSelection } from './WorkspaceRoute'

function cacheWorkspaceProjection(client: ReturnType<typeof useQueryClient>, workspaceId: string, details: CurrentWorkspaceDetails) {
  client.setQueryData(queryKeys.agents(workspaceId), { agents: details.agents })
  for (const workflow of details.workflows) client.setQueryData(queryKeys.workflow(workspaceId, workflow.id), { workflow })
}

/** Parent route remains mounted for both historical deep links and canonical Run selection. */
export function WorkspaceRouteEntry() {
  const location = useLocation()
  let selection: WorkflowBoardLocation
  try { selection = resolveWorkflowBoardLocation(location.pathname, location.search) }
  catch { return <ErrorState title="Invalid board selection" description="Use a complete workspace, workflow, Run, version and semantics selection. Conflicting pins are not replaced with the current version." /> }
  return <WorkspaceBoardRoute selection={selection} />
}

function WorkspaceBoardRoute({ selection }: { selection: WorkflowBoardLocation }) {
  const { workspaceId, workflowId: requestedId, search, run } = selection
  const navigate = useNavigate(), client = useQueryClient()
  const workspace = useWorkspaceDetailsQuery(workspaceId, {
    refetchInterval: (query) => {
      const error = query.state.error
      return ApiError.is(error) && (error.status === 401 || error.status === 403 || error.status === 404)
        ? false
        : 1_000
    },
  })
  const managed = useManagedWorkflowQuery(workspaceId, requestedId ?? '')
  const denied = useProtectedAccessError(workspace), managedDenied = useProtectedAccessError(managed)
  const details = denied ? undefined : workspace.data
  const managedWorkflow = managedDenied ? undefined : managed.data?.workflow
  const workflowId = requestedId ?? details?.workflows[0]?.id
  const workflow = details?.workflows.find((item) => item.id === workflowId) ?? managedWorkflow
  useEffect(() => {
    if (!denied) return
    if (denied.status === 401) clearCurrentRunAccess(client)
    else revokeCurrentRunWorkspace(client, workspaceId)
  }, [denied, client, workspaceId])
  useEffect(() => { if (details) cacheWorkspaceProjection(client, workspaceId, details) }, [client, workspaceId, details])
  useEffect(() => {
    // Resolve an unpinned workspace default only, but NEVER retarget a pinned Run.
    if (run) return
    const detailsKey = queryKeys.workspaceDetails(workspaceId), managedKey = queryKeys.managedWorkflow(workspaceId, requestedId ?? '')
    type Managed = NonNullable<ReturnType<typeof useManagedWorkflowQuery>['data']>
    const latest = client.getQueryData<CurrentWorkspaceDetails>(detailsKey)
    const catalog = client.getQueryData<Managed>(managedKey)
    if (!latest || requestedId && (latest.workflows.some((item) => item.id === requestedId)
      || catalog?.workflow.id === requestedId
      || client.getQueryState(managedKey)?.fetchStatus === 'fetching')) return
    if (requestedId === latest.workflows[0]?.id) return
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, replace: true, search: (previous) => {
      const current = client.getQueryData<CurrentWorkspaceDetails>(detailsKey)
      const saved = client.getQueryData<Managed>(managedKey)
      if (!current || previous.runId || previous.workflowId !== search.workflowId || previous.workflowId && (
        current.workflows.some((item) => item.id === previous.workflowId)
        || saved?.workflow.id === previous.workflowId
        || client.getQueryState(managedKey)?.fetchStatus === 'fetching')) return previous
      const next = { ...previous }, fallback = current.workflows[0]?.id
      if (fallback) next.workflowId = fallback
      else delete next.workflowId
      if (requestedId) delete next.agentId
      return next
    } })
  }, [requestedId, run, search.workflowId, workspaceId, navigate, client, details, managed.data, managed.fetchStatus])
  const selectRun = useCallback((scope?: RepeatGraphScopeV3) => {
    if (!workflowId) return
    if (scope && (scope.workspaceId !== workspaceId || scope.workflowId !== workflowId)) throw new Error('Run selection belongs to a different board.')
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, search: boardSearchForRun(search, workflowId, scope) })
  }, [workflowId, workspaceId, search, navigate])
  const selectInspection = useCallback((inspection: WorkspaceBoardInspection) => {
    if (!workflowId || !run) return
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, search: boardSearchForInspection(search, workflowId, run, inspection) })
  }, [workflowId, run, search, workspaceId, navigate])
  const selectDraftAgent = useCallback((agentId?: string) => {
    if (!workflowId) return
    // Keep the selected Run and its inspector independent of authoring selection.
    const next = { ...boardSearchForRun(search, workflowId, run),
      runNodeId: search.runNodeId, runRelationshipId: search.runRelationshipId, runExchangeKey: search.runExchangeKey }
    if (agentId) next.agentId = agentId
    else delete next.agentId
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, search: next })
  }, [workflowId, workspaceId, search, run, navigate])

  if (workspace.isPending && !details) return <WorkspaceSelection workspaceId={workspaceId} state="loading" />
  if (!details) {
    const notFound = ApiError.is(workspace.error) && workspace.error.status === 404
    return <WorkspaceSelection workspaceId={workspaceId} state={notFound ? 'not-found' : 'error'}
      stateMessage="This workspace cannot be opened with the current access.">
      <Button variant="secondary" onClick={() => void workspace.refetch()}>Retry workspace request</Button>
    </WorkspaceSelection>
  }
  return <WorkspaceSelection workspaceId={workspaceId} selectedAgentId={search.agentId} activeWorkflowId={workflowId}
    state={workflowId ? 'ready' : 'empty'} allowBoardWithoutLocation
    slots={{ workspace: <strong data-testid="workspace-name">{details.workspace.name}</strong>, graph: workflowId ? (
      <WorkflowBoard key={JSON.stringify([workspaceId, workflowId])} workspaceId={workspaceId} workflowId={workflowId}
        run={run} selectRun={selectRun} summaries={details.runs} selectInspection={selectInspection}
        selectedAgentId={search.agentId} selectDraftAgent={selectDraftAgent}
        inspection={{ runNodeId: search.runNodeId, runRelationshipId: search.runRelationshipId, runExchangeKey: search.runExchangeKey }}>
        {workspace.isError ? <p role="status">Workspace updates are unavailable. The local draft is retained.</p> : null}
        <PersistedWorkflowBoundary workspaceId={workspaceId} workflowId={workflowId} workflow={workflow} />
      </WorkflowBoard>
    ) : undefined }} />
}
