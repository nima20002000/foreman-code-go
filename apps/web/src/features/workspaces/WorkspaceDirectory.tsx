import { useEffect, useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { PanelsTopLeft, Trash2 } from 'lucide-react'

import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { useSessionWorkflowStore } from '../workflows/sessionWorkflowStore'
import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { useNavigationUiStore } from './navigationUiStore'
import { useWorkspaceSessionStore } from './workspaceSessionStore'

const DEFAULT_WORKSPACE_ID = 'workspace-1'

export function WorkspaceDirectory() {
  const workspaceQuery = useWorkspaceDetailsQuery(DEFAULT_WORKSPACE_ID)
  const sessionWorkspaces = useWorkspaceSessionStore((state) => state.workspaces)
  const knownWorkspaces = useWorkspaceSessionStore((state) => state.knownWorkspaces)
  const hiddenWorkspaceIds = useWorkspaceSessionStore((state) => state.hiddenWorkspaceIds)
  const registerWorkspace = useWorkspaceSessionStore((state) => state.registerWorkspace)
  const removeWorkspace = useWorkspaceSessionStore((state) => state.removeWorkspace)
  const removeWorkspaceState = useNavigationUiStore((state) => state.removeWorkspaceState)
  const removeWorkspaceAgents = useAgentDirectoryStore((state) => state.removeWorkspace)
  const removeWorkspaceWorkflows = useSessionWorkflowStore(
    (state) => state.removeWorkspaceWorkflows,
  )

  useEffect(() => {
    if (workspaceQuery.data?.workspace) registerWorkspace(workspaceQuery.data.workspace)
  }, [registerWorkspace, workspaceQuery.data?.workspace])

  const workspaces = useMemo(() => {
    const hidden = new Set(hiddenWorkspaceIds)
    const entries = [
      ...(workspaceQuery.data?.workspace ? [workspaceQuery.data.workspace] : []),
      ...knownWorkspaces,
      ...sessionWorkspaces,
    ]
    return [...new Map(entries
      .filter((workspace) => !hidden.has(workspace.id))
      .map((workspace) => [workspace.id, workspace])).values()]
  }, [hiddenWorkspaceIds, knownWorkspaces, sessionWorkspaces, workspaceQuery.data?.workspace])

  const deleteWorkspace = (workspaceId: string) => {
    removeWorkspace(workspaceId)
    removeWorkspaceState(workspaceId)
    removeWorkspaceAgents(workspaceId)
    removeWorkspaceWorkflows(workspaceId)
  }

  return (
    <section className="workspace-directory" aria-labelledby="workspace-directory-title">
      <header>
        <p className="panel-kicker">GraphQL</p>
        <h1 id="workspace-directory-title">Workspaces</h1>
        <p>Open a workspace or remove it from this frontend session.</p>
      </header>

      {workspaces.length > 0 ? (
        <ul className="workspace-card-list" data-testid="workspace-card-list">
          {workspaces.map((workspace) => (
            <li
              className="workspace-card"
              data-testid={`workspace-card-${workspace.id}`}
              key={workspace.id}
            >
              <Link
                to="/workspaces/$workspaceId"
                params={{ workspaceId: workspace.id }}
                search={{}}
                className="workspace-card-open"
              >
                <PanelsTopLeft aria-hidden="true" size={18} />
                <span>{workspace.name}</span>
              </Link>
              <button
                type="button"
                className="workspace-card-delete"
                aria-label={`Delete ${workspace.name}`}
                title={`Delete ${workspace.name}`}
                onClick={() => deleteWorkspace(workspace.id)}
              >
                <Trash2 aria-hidden="true" size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : workspaceQuery.isPending ? (
        <p className="workspace-directory-state" role="status">Loading workspaces…</p>
      ) : workspaceQuery.isError && hiddenWorkspaceIds.length === 0 ? (
        <p className="workspace-directory-state" role="alert">Workspaces unavailable</p>
      ) : (
        <div className="workspace-directory-empty" data-testid="workspace-directory-empty">
          <h2>No workspaces yet</h2>
          <p>Use New workspace in the navigation to create one for this session.</p>
        </div>
      )}
    </section>
  )
}
