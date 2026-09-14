import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { MoreHorizontal, Plus } from 'lucide-react'
import type { WorkflowDefinition } from '@graphql/contracts'

import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import { isSessionWorkspaceId, useWorkspaceSessionStore } from '../workspaces/workspaceSessionStore'
import { NewWorkflowDialog } from './NewWorkflowDialog'
import { useSessionWorkflowStore } from './sessionWorkflowStore'
import './workflows.css'

export interface WorkflowNavigationProps {
  workspaceId: string
  /** URL-owned selection; undefined means no workflow is selected in the URL. */
  activeWorkflowId?: string
}

function WorkflowNavigationItem({
  workflow,
  workspaceId,
  active,
  session,
  onRename,
  onRemove,
}: {
  workflow: WorkflowDefinition
  workspaceId: string
  active: boolean
  session: boolean
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(workflow.name)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => setName(workflow.name), [workflow.name])
  useDismissableSurface({ open, onDismiss: close, surfaceRef, triggerRef })

  return (
    <li className="workflow-navigation-row">
      <Link
        to="/workspaces/$workspaceId"
        params={{ workspaceId }}
        search={(previous) => {
          const next = { ...previous, workflowId: workflow.id }
          delete next.agentId
          return next
        }}
        className={`nav-item workflow-navigation-item${active ? ' nav-item-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        data-session-draft={session ? 'true' : undefined}
        title={workflow.name}
      >
        <span className="nav-item-label">{workflow.name}</span>
      </Link>
      <button
        ref={triggerRef}
        type="button"
        className="workflow-navigation-more"
        aria-label={`Open actions for ${workflow.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </button>
      {open ? (
        <div ref={surfaceRef} className="workflow-navigation-actions" role="dialog" aria-label={`${workflow.name} actions`}>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="button" onClick={() => {
            const nextName = name.trim()
            if (!nextName) return
            onRename(nextName)
            close()
          }}>Rename</button>
          <button type="button" onClick={() => {
            onRemove()
            close()
          }}>Remove workflow</button>
        </div>
      ) : null}
    </li>
  )
}

/**
 * The nested workflow submenu for one workspace. Saved workflows come from the
 * workspace query projection, session-created drafts come from the local
 * Zustand store, and the selected workflow stays in the URL. New workflow
 * opens a compact creation dialog in the active workspace.
 */
export function WorkflowNavigation({ workspaceId, activeWorkflowId }: WorkflowNavigationProps) {
  const sessionWorkspace = isSessionWorkspaceId(workspaceId)
  const workflowsQuery = useWorkspaceDetailsQuery(workspaceId, { enabled: !sessionWorkspace })
  const sessionWorkspaceName = useWorkspaceSessionStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.name,
  )
  const sessionWorkflows = useSessionWorkflowStore((state) => state.workflows)
  const workflowNameOverrides = useSessionWorkflowStore((state) => state.workflowNameOverrides)
  const hiddenWorkflowIds = useSessionWorkflowStore((state) => state.hiddenWorkflowIds)
  const renameWorkflow = useSessionWorkflowStore((state) => state.renameWorkflow)
  const removeWorkflow = useSessionWorkflowStore((state) => state.removeWorkflow)
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const closeCreateDialog = useCallback(() => {
    setCreating(false)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!creating) return
    dialogRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
  }, [creating])

  useDismissableSurface({
    open: creating,
    onDismiss: closeCreateDialog,
    surfaceRef: dialogRef,
    triggerRef,
  })

  const sessions = Object.values(sessionWorkflows).filter(
    (workflow) => workflow.workspaceId === workspaceId,
  )
  const sessionIds = new Set(sessions.map((workflow) => workflow.id))
  const hiddenIds = new Set(hiddenWorkflowIds)
  const workflows = [...sessions, ...(workflowsQuery.data?.workflows ?? [])]
    .filter((workflow) => !hiddenIds.has(workflow.id))
    .map((workflow) => ({
      ...workflow,
      name: workflowNameOverrides[workflow.id] ?? workflow.name,
    }))
  const hasWorkflows = workflows.length > 0

  return (
    <section
      className="workflow-navigation"
      data-testid="workflow-navigation"
      aria-label="Workspace workflows"
    >
      {hasWorkflows ? (
        <ul className="nav-submenu workflow-navigation-list">
          {workflows.map((workflow) => {
            const active = workflow.id === activeWorkflowId
            const session = sessionIds.has(workflow.id)
            return <WorkflowNavigationItem
              key={workflow.id}
              workflow={workflow}
              workspaceId={workspaceId}
              active={active}
              session={session}
              onRename={(name) => renameWorkflow(workflow.id, name)}
              onRemove={() => removeWorkflow(workflow.id)}
            />
          })}
        </ul>
      ) : !sessionWorkspace && workflowsQuery.isPending ? (
        <p className="workflow-navigation-state" role="status">
          Loading workflows…
        </p>
      ) : !sessionWorkspace && workflowsQuery.isError ? (
        <p
          className="workflow-navigation-state workflow-navigation-state-error"
          data-testid="workflow-navigation-error"
          role="alert"
        >
          Workflows unavailable
        </p>
      ) : (
        <p className="workflow-navigation-state" data-testid="workflow-navigation-empty">
          No workflows yet
        </p>
      )}

      {hasWorkflows && workflowsQuery.isError ? (
        <p
          className="workflow-navigation-state workflow-navigation-state-error"
          data-testid="workflow-navigation-error"
          role="alert"
        >
          Workflows unavailable
        </p>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        className="workflow-navigation-add"
        aria-label="New workflow"
        title="New workflow"
        aria-haspopup="dialog"
        aria-expanded={creating}
        onClick={() => setCreating(true)}
      >
        <Plus aria-hidden="true" size={15} />
        <span className="nav-item-label">New workflow</span>
      </button>

      {creating ? (
        <div className="workflow-create-backdrop">
          <div
            ref={dialogRef}
            className="workflow-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-workflow-title"
          >
            <NewWorkflowDialog
              workspaceId={workspaceId}
              workspaceName={sessionWorkspaceName ?? workflowsQuery.data?.workspace.name}
              onCancel={closeCreateDialog}
              onCreated={(workflowId) => {
                closeCreateDialog()
                void navigate({
                  to: '/workspaces/$workspaceId',
                  params: { workspaceId },
                  search: (previous) => {
                    const next = { ...previous, workflowId }
                    delete next.agentId
                    return next
                  },
                })
              }}
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}
