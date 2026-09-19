import { useCallback, useEffect } from 'react'
import {
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkspaceDetailsResponse } from '@graphql/contracts'

import { Button } from '../shared/ui/nocturne'
import { WorkflowGraph } from '../features/graph'
import { ApiError } from '../shared/api/client'
import {
  queryKeys,
  useManagedWorkflowsQuery,
  useWorkspaceDetailsQuery,
} from '../shared/api/query'
import { WorkspaceSelection } from './WorkspaceRoute'

type ManagedWorkflowsResult = NonNullable<ReturnType<typeof useManagedWorkflowsQuery>['data']>

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isNotFound(error: unknown): boolean {
  return ApiError.is(error) && error.status === 404
}

function WorkspaceHeader({ details }: { details: WorkspaceDetailsResponse }) {
  return <strong data-testid="workspace-name">{details.workspace.name}</strong>
}

function cacheWorkspaceProjection(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  details: WorkspaceDetailsResponse,
) {
  queryClient.setQueryData(queryKeys.agents(workspaceId), { agents: details.agents })
  for (const workflow of details.workflows) {
    queryClient.setQueryData(queryKeys.workflow(workspaceId, workflow.id), { workflow })
  }
}


/** Router adapter: URL state stays in TanStack Router and is handed to the shell as props. */
export function WorkspaceRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId' })
  const { agentId, workflowId } = useSearch({ from: '/workspaces/$workspaceId' })
  const navigate = useNavigate({ from: '/workspaces/$workspaceId' })
  const queryClient = useQueryClient()
  const workspaceQuery = useWorkspaceDetailsQuery(workspaceId)
  const managedWorkflowsQuery = useManagedWorkflowsQuery(workspaceId)

  const selectAgent = useCallback(
    (nextAgentId: string) => {
      void navigate({
        search: (previous) => ({ ...previous, agentId: nextAgentId }),
      })
    },
    [navigate],
  )

  const clearAgent = useCallback(() => {
    void navigate({
      search: (previous) => {
        const next = { ...previous }
        delete next.agentId
        return next
      },
    })
  }, [navigate])

  useEffect(() => {
    const details = workspaceQuery.data
    if (!details) return
    cacheWorkspaceProjection(queryClient, workspaceId, details)
  }, [queryClient, workspaceId, workspaceQuery.data])

  const resolvedDetails = workspaceQuery.data
  const availableWorkflows = resolvedDetails?.workflows ?? []
  const managedWorkflow = managedWorkflowsQuery.data?.items.find((item) => item.workflow.id === workflowId)?.workflow
  const workflow = resolvedDetails
    ? availableWorkflows.find((item) => item.id === workflowId) ?? managedWorkflow ?? availableWorkflows[0]
    : undefined

  useEffect(() => {
    const detailsKey = queryKeys.workspaceDetails(workspaceId)
    const managedKey = queryKeys.managedWorkflows(workspaceId)
    const latestDetails = queryClient.getQueryData<WorkspaceDetailsResponse>(detailsKey)
    const latestManaged = queryClient.getQueryData<ManagedWorkflowsResult>(managedKey)
    if (!latestDetails || (workflowId && (
      latestDetails.workflows.some((item) => item.id === workflowId)
      || latestManaged?.items.some((item) => item.workflow.id === workflowId)
      || queryClient.getQueryState(managedKey)?.fetchStatus === 'fetching'
    ))) return
    const fallbackId = latestDetails.workflows[0]?.id
    if (workflowId === fallbackId) return
    void navigate({
      replace: true,
      search: (previous) => {
        const currentDetails = queryClient.getQueryData<WorkspaceDetailsResponse>(detailsKey)
        const currentManaged = queryClient.getQueryData<ManagedWorkflowsResult>(managedKey)
        // A newer selection or accepted workflow may have arrived since this effect ran.
        if (!currentDetails || previous.workflowId !== workflowId || (previous.workflowId && (
          currentDetails.workflows.some((item) => item.id === previous.workflowId)
          || currentManaged?.items.some((item) => item.workflow.id === previous.workflowId)
          || queryClient.getQueryState(managedKey)?.fetchStatus === 'fetching'
        ))) return previous
        const next = { ...previous }
        const currentFallbackId = currentDetails.workflows[0]?.id
        if (currentFallbackId) next.workflowId = currentFallbackId
        else delete next.workflowId
        if (workflowId) delete next.agentId
        return next
      },
    })
  }, [navigate, queryClient, resolvedDetails, managedWorkflowsQuery.data, managedWorkflowsQuery.fetchStatus, workflowId, workspaceId])

  if (workspaceQuery.isPending) {
    return <WorkspaceSelection workspaceId={workspaceId} state="loading" />
  }

  if (workspaceQuery.isError || !resolvedDetails) {
    const notFound = isNotFound(workspaceQuery.error)
    return (
      <WorkspaceSelection
        workspaceId={workspaceId}
        state={notFound ? 'not-found' : 'error'}
        stateMessage={readableError(
          workspaceQuery.error,
          notFound ? `Workspace ${workspaceId} is not available.` : 'The workspace could not be loaded.',
        )}
        children={!notFound ? (
          <Button variant="secondary" onClick={() => void workspaceQuery.refetch()}>
            Retry workspace request
          </Button>
        ) : undefined}
      />
    )
  }

  const details = resolvedDetails
  const selectedAgentIsStale = Boolean(agentId && !details.agents.some((agent) => agent.id === agentId))
  const state = selectedAgentIsStale ? 'stale' : workflow ? 'ready' : 'empty'

  return (
    <WorkspaceSelection
      workspaceId={workspaceId}
      selectedAgentId={agentId}
      activeWorkflowId={workflow?.id}
      state={state}
      slots={{
        workspace: <WorkspaceHeader details={details} />,
        graph: workflow ? (
          <WorkflowGraph
            key={`${workspaceId}:${workflow.id}`}
            workspaceId={workspaceId}
            workflowId={workflow.id}
            selectedAgentId={agentId}
            onSelectAgent={selectAgent}
            onClearAgent={clearAgent}
          />
        ) : undefined,
      }}
    />
  )
}
