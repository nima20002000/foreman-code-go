import { Link } from '@tanstack/react-router'
import type { WorkflowDefinition } from '@graphql/contracts'

import { useInteractionsQuery, useWorkflowPages, useManagedWorkflowQuery } from '../../shared/api/query'
import { LoadMore } from '../../shared/ui/LoadMore'
import { Badge } from '../../shared/ui/nocturne'
import { NewWorkflowAction } from './NewWorkflowAction'
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
  pendingCount,
}: {
  workflow: WorkflowDefinition
  workspaceId: string
  active: boolean
  pendingCount: number | undefined
}) {
  return (
    <li className="workflow-navigation-row">
      <Link
        to="/workspaces/$workspaceId"
        params={{ workspaceId }}
        search={{ workflowId: workflow.id }}
        className={`nav-item workflow-navigation-item${active ? ' nav-item-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        title={workflow.name}
      >
        <span className="nav-item-label">{workflow.name}</span>
        {pendingCount === undefined ? <span className="visually-hidden">Approval count unavailable</span> : null}
        {pendingCount !== undefined && pendingCount > 0 ? <Badge tone="accent" className="workflow-approval-badge">{pendingCount}</Badge> : null}
      </Link>
    </li>
  )
}

/**
 * The nested workflow submenu for one workspace. Saved workflows come from the
 * managed API projection, and the selected workflow stays in the URL. New
 * workflow opens a compact creation dialog in the active workspace.
 */
export function WorkflowNavigation({ workspaceId, activeWorkflowId }: WorkflowNavigationProps) {
  const managedQuery = useWorkflowPages(workspaceId, true)
  const interactionsQuery = useInteractionsQuery({ workspaceId, status: 'pending', limit: 1 }, true)

  const workflows = managedQuery.data?.pages.flatMap((page) => page.items.map((item) => item.workflow)) ?? []
  const activeMissing = Boolean(activeWorkflowId && !workflows.some((workflow) => workflow.id === activeWorkflowId))
  const activeQuery = useManagedWorkflowQuery(workspaceId, activeWorkflowId ?? '', activeMissing)
  if (activeMissing && activeQuery.data && !activeQuery.data.archivedAt) {
    const visibleCount = Math.max(1, workflows.length)
    workflows.unshift(activeQuery.data.workflow)
    workflows.length = visibleCount
  }
  const hasWorkflows = workflows.length > 0

  return (
    <section
      className="workflow-navigation"
      data-testid="workflow-navigation"
      aria-label="Workspace workflows"
    >
      <NewWorkflowAction workspaceId={workspaceId} navigation />
      {hasWorkflows ? (
        <ul className="nav-submenu workflow-navigation-list">
          {workflows.map((workflow) => {
            const active = workflow.id === activeWorkflowId
            const pendingCount = interactionsQuery.isError ? undefined : interactionsQuery.data?.pendingByWorkflow?.[workflow.id]
              ?? (interactionsQuery.data?.pendingByWorkflow ? 0 : undefined)
            return <WorkflowNavigationItem
              key={workflow.id}
              workflow={workflow}
              workspaceId={workspaceId}
              active={active}
              pendingCount={pendingCount}
            />
          })}
        </ul>
      ) : managedQuery.isPending ? (
        <p className="workflow-navigation-state" role="status">
          Loading workflows…
        </p>
      ) : managedQuery.isError ? (
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

      {hasWorkflows && managedQuery.isError ? (
        <p
          className="workflow-navigation-state workflow-navigation-state-error"
          data-testid="workflow-navigation-error"
          role="alert"
        >
          Workflows unavailable
        </p>
      ) : null}

      <LoadMore label="workflows" query={managedQuery} />
    </section>
  )
}
