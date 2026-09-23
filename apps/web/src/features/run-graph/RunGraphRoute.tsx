import { useEffect } from 'react'
import { useParams } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { RunGraphScopeSchema } from '@graphql/contracts/wave25'
import { ApiError } from '../../shared/api/client'
import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { WorkspaceShell } from '../../shared/ui/WorkspaceShell'
import { ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { RunGraphView } from './RunGraphView'
import { clearRunGraphAccess, revokeRunGraphWorkspace } from './sync'

/** Keep existing workspace discovery/authorization; URL pins are requests, not authority. */
export function RunGraphRoute() {
  const params = useParams({ strict: false }) as Record<string, string | undefined>
  const workspaceId = params.workspaceId ?? ''
  const workspace = useWorkspaceDetailsQuery(workspaceId, { enabled: Boolean(workspaceId) })
  const client = useQueryClient()
  useEffect(() => {
    if (!ApiError.is(workspace.error)) return
    if (workspace.error.status === 401) clearRunGraphAccess(client)
    else if (workspace.error.status === 403) revokeRunGraphWorkspace(client, workspaceId)
  }, [workspace.error, workspaceId, client])
  const parsed = RunGraphScopeSchema.safeParse({ workspaceId, workflowId: params.workflowId, runId: params.runId,
    workflowVersionId: params.workflowVersionId,
    executionSemanticsVersion: params.executionSemanticsVersion === '1' ? 1 : params.executionSemanticsVersion === '2' ? 2 : undefined })
  if (!parsed.success) return <ErrorState title="Invalid Run selection" description="A complete workspace, workflow, Run, version and semantics pin is required." />
  if (workspace.isPending) return <LoadingState label="Loading workspace…" />
  if (workspace.isError || !workspace.data) return <ErrorState title="Workspace unavailable" description="This Run cannot be opened with the current access." />
  return <WorkspaceShell workspaceId={workspaceId} activeWorkflowId={parsed.data.workflowId} slots={{
    workspace: <strong>{workspace.data.workspace.name}</strong>, graph: <RunGraphView scope={parsed.data} />,
  }} />
}
