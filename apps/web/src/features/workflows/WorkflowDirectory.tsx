import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Workflow } from 'lucide-react'

import {
  queryKeys, useArchiveManagedWorkflowMutation, useManagedWorkflowsQuery,
  useUpdateManagedWorkflowMutation, useWorkspaceDetailsQuery,
} from '../../shared/api/query'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import { isSessionWorkspaceId, useWorkspaceSessionStore } from '../workspaces/workspaceSessionStore'
import { useSessionWorkflowStore } from './sessionWorkflowStore'
import '../workspaces/workspaces.css'

function WorkflowCardActions({ name, onRename, onRemove }: {
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
          <button type="button" onClick={onRemove}>Remove workflow</button>
        </div>
      ) : null}
    </div>
  )
}

export function WorkflowDirectory({ workspaceId }: { workspaceId: string }) {
  const sessionWorkspace = isSessionWorkspaceId(workspaceId)
  const realMode = import.meta.env.MODE !== 'test' && (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false') && !sessionWorkspace
  const queryClient = useQueryClient()
  const workflowsQuery = useWorkspaceDetailsQuery(workspaceId, { enabled: !sessionWorkspace && !realMode })
  const managedQuery = useManagedWorkflowsQuery(workspaceId, realMode)
  const updateWorkflow = useUpdateManagedWorkflowMutation()
  const archiveWorkflow = useArchiveManagedWorkflowMutation()
  const sessionWorkflows = useSessionWorkflowStore((state) => state.workflows)
  const workflowNameOverrides = useSessionWorkflowStore((state) => state.workflowNameOverrides)
  const hiddenWorkflowIds = useSessionWorkflowStore((state) => state.hiddenWorkflowIds)
  const renameWorkflow = useSessionWorkflowStore((state) => state.renameWorkflow)
  const removeWorkflow = useSessionWorkflowStore((state) => state.removeWorkflow)
  const workspaceName = useWorkspaceSessionStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.name,
  )

  const sessions = Object.values(sessionWorkflows).filter(
    (workflow) => workflow.workspaceId === workspaceId,
  )
  const sessionIds = new Set(sessions.map((workflow) => workflow.id))
  const hiddenIds = new Set(hiddenWorkflowIds)
  const managed = managedQuery.data?.items ?? []
  const managedById = new Map(managed.map((item) => [item.workflow.id, item]))
  const workflows = realMode ? managed.map((item) => item.workflow) : [...sessions, ...(workflowsQuery.data?.workflows ?? [])]
    .filter((workflow) => !hiddenIds.has(workflow.id))
    .map((workflow) => ({
      ...workflow,
      name: workflowNameOverrides[workflow.id] ?? workflow.name,
    }))

  return (
    <section className="workspace-directory" aria-labelledby="workflow-directory-title">
      <header>
        <p className="panel-kicker">{workspaceName ?? workflowsQuery.data?.workspace.name ?? 'Workspace'}</p>
        <h1 id="workflow-directory-title">Workflows</h1>
        <p>{realMode ? 'Open, rename or archive a durable workflow.' : 'Open a workflow or remove it from this frontend session.'}</p>
      </header>

      {workflows.length > 0 ? (
        <ul className="workspace-card-list" data-testid="workflow-card-list">
          {workflows.map((workflow) => (
            <li
              className="workspace-card"
              data-testid={`workflow-card-${workflow.id}`}
              key={workflow.id}
            >
              <Link
                to="/workspaces/$workspaceId"
                params={{ workspaceId }}
                search={{ workflowId: workflow.id }}
                className="workspace-card-open"
                data-session-draft={sessionIds.has(workflow.id) ? 'true' : undefined}
              >
                <Workflow aria-hidden="true" size={18} />
                <span>{workflow.name}</span>
              </Link>
              <WorkflowCardActions
                name={workflow.name}
                onRename={(name) => {
                  if (!realMode) return renameWorkflow(workflow.id, name)
                  const item = managedById.get(workflow.id)
                  if (!item) return
                  updateWorkflow.mutate({ workspaceId, workflowId: workflow.id, expectedRevision: item.revision, commandId: crypto.randomUUID(), name }, {
                    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }),
                  })
                }}
                onRemove={() => {
                  if (!realMode) return removeWorkflow(workflow.id)
                  const item = managedById.get(workflow.id)
                  if (!item) return
                  archiveWorkflow.mutate({ workspaceId, workflowId: workflow.id, expectedRevision: item.revision, commandId: crypto.randomUUID() }, {
                    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }),
                  })
                }}
              />
            </li>
          ))}
        </ul>
      ) : (realMode ? managedQuery.isPending : !sessionWorkspace && workflowsQuery.isPending) ? (
        <p className="workspace-directory-state" role="status">Loading workflows…</p>
      ) : (realMode ? managedQuery.isError : !sessionWorkspace && workflowsQuery.isError) ? (
        <p className="workspace-directory-state" role="alert">Workflows unavailable</p>
      ) : (
        <div className="workspace-directory-empty" data-testid="workflow-directory-empty">
          <h2>No workflows yet</h2>
          <p>Use New workflow in the navigation to create one.</p>
        </div>
      )}
    </section>
  )
}
