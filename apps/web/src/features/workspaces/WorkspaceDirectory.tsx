import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { MoreHorizontal, PanelsTopLeft } from 'lucide-react'

import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { useSessionWorkflowStore } from '../workflows/sessionWorkflowStore'
import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import { useNavigationUiStore } from './navigationUiStore'
import { useWorkspaceSessionStore } from './workspaceSessionStore'

const DEFAULT_WORKSPACE_ID = 'workspace-1'

function WorkspaceCardActions({ name, onRename, onRemove }: {
  name: string
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [nextName, setNextName] = useState(name)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useEffect(() => setNextName(name), [name])
  useDismissableSurface({ open, onDismiss: close, surfaceRef, triggerRef })

  return (
    <div className="workspace-card-actions-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="workspace-card-more"
        aria-label={`Open actions for ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div ref={surfaceRef} className="workspace-card-actions" role="dialog" aria-label={`${name} actions`}>
          <label>Name<input value={nextName} onChange={(event) => setNextName(event.target.value)} /></label>
          <button type="button" onClick={() => {
            const value = nextName.trim()
            if (!value) return
            onRename(value)
            close()
          }}>Rename</button>
          <button type="button" onClick={onRemove}>Remove workspace</button>
        </div>
      ) : null}
    </div>
  )
}

export function WorkspaceDirectory() {
  const workspaceQuery = useWorkspaceDetailsQuery(DEFAULT_WORKSPACE_ID)
  const sessionWorkspaces = useWorkspaceSessionStore((state) => state.workspaces)
  const knownWorkspaces = useWorkspaceSessionStore((state) => state.knownWorkspaces)
  const hiddenWorkspaceIds = useWorkspaceSessionStore((state) => state.hiddenWorkspaceIds)
  const workspaceNameOverrides = useWorkspaceSessionStore((state) => state.workspaceNameOverrides)
  const registerWorkspace = useWorkspaceSessionStore((state) => state.registerWorkspace)
  const removeWorkspace = useWorkspaceSessionStore((state) => state.removeWorkspace)
  const renameWorkspace = useWorkspaceSessionStore((state) => state.renameWorkspace)
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
      .map((workspace) => [workspace.id, {
        ...workspace,
        name: workspaceNameOverrides[workspace.id] ?? workspace.name,
      }])).values()]
  }, [hiddenWorkspaceIds, knownWorkspaces, sessionWorkspaces, workspaceNameOverrides, workspaceQuery.data?.workspace])

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
              <WorkspaceCardActions
                name={workspace.name}
                onRename={(name) => renameWorkspace(workspace.id, name)}
                onRemove={() => deleteWorkspace(workspace.id)}
              />
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
