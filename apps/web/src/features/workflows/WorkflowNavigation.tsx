import { useCallback, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { WorkflowDefinition } from '@graphql/contracts'

import { useInteractionsQuery, useManagedWorkflowsQuery, useWorkspaceDetailsQuery } from '../../shared/api/query'
import { Badge, Button, Icon } from '../../shared/ui/nocturne'
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
  pendingCount,
}: {
  workflow: WorkflowDefinition
  workspaceId: string
  active: boolean
  session: boolean
  pendingCount: number | undefined
}) {
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
        {pendingCount === undefined && !session ? <span className="visually-hidden">Approval count unavailable</span> : null}
        {pendingCount !== undefined && pendingCount > 0 ? <Badge tone="accent" className="workflow-approval-badge">{pendingCount}</Badge> : null}
      </Link>
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
  const realMode = import.meta.env.MODE !== 'test' && (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false') && !sessionWorkspace
  const workflowsQuery = useWorkspaceDetailsQuery(workspaceId, { enabled: !sessionWorkspace && !realMode })
  const managedQuery = useManagedWorkflowsQuery(workspaceId, realMode)
  const interactionsQuery = useInteractionsQuery({ workspaceId, status: 'pending', limit: 1 }, !sessionWorkspace)
  const sessionWorkspaceName = useWorkspaceSessionStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.name,
  )
  const sessionWorkflows = useSessionWorkflowStore((state) => state.workflows)
  const workflowNameOverrides = useSessionWorkflowStore((state) => state.workflowNameOverrides)
  const hiddenWorkflowIds = useSessionWorkflowStore((state) => state.hiddenWorkflowIds)
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const closeCreateDialog = useCallback(() => {
    setCreating(false)
  }, [])

  const sessions = Object.values(sessionWorkflows).filter(
    (workflow) => workflow.workspaceId === workspaceId,
  )
  const sessionIds = new Set(sessions.map((workflow) => workflow.id))
  const hiddenIds = new Set(hiddenWorkflowIds)
  const workflows = realMode ? managedQuery.data?.items.map((item) => item.workflow) ?? [] : [...sessions, ...(workflowsQuery.data?.workflows ?? [])]
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
            const pendingCount = interactionsQuery.isError ? undefined : interactionsQuery.data?.pendingByWorkflow?.[workflow.id]
              ?? (interactionsQuery.data?.pendingByWorkflow ? 0 : undefined)
            return <WorkflowNavigationItem
              key={workflow.id}
              workflow={workflow}
              workspaceId={workspaceId}
              active={active}
              session={session}
              pendingCount={pendingCount}
            />
          })}
        </ul>
      ) : (realMode ? managedQuery.isPending : !sessionWorkspace && workflowsQuery.isPending) ? (
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

      <Button
        className="workflow-navigation-add"
        variant="ghost"
        aria-label="New workflow"
        title="New workflow"
        aria-haspopup="dialog"
        aria-expanded={creating}
        leading={<Icon name="plus" size={15} />}
        onClick={() => setCreating(true)}
      >
        <span className="nav-item-label">New workflow</span>
      </Button>

      {creating ? (
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
      ) : null}
    </section>
  )
}
