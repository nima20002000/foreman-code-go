import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'

import {
  queryKeys, useArchiveManagedWorkflowMutation, useManagedWorkflowsQuery,
  useUpdateManagedWorkflowMutation, useWorkspaceDetailsQuery,
} from '../../shared/api/query'
import {
  Button, Card, EmptyState, ErrorState, Icon, IconButton, LoadingState, PageHeader, TextField,
} from '../../shared/ui/nocturne'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import { isSessionWorkspaceId, useWorkspaceSessionStore } from '../workspaces/workspaceSessionStore'
import { useSessionWorkflowStore } from './sessionWorkflowStore'
import './workflows.css'

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
    <div className="workflow-card-actions-wrap">
      <IconButton
        ref={triggerRef}
        className="workflow-card-more"
        label={`Open actions for ${name}`}
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" size={16} />
      </IconButton>
      {open ? (
        <div ref={surfaceRef} className="workflow-card-actions" role="dialog" aria-label={`${name} actions`}>
          <TextField label="Name" value={nextName} onChange={(event) => setNextName(event.target.value)} />
          <Button onClick={() => {
            const value = nextName.trim()
            if (!value) return
            onRename(value)
            close()
          }}>Rename</Button>
          <Button variant="danger" onClick={onRemove}>Remove workflow</Button>
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
    <section className="workflow-directory" aria-label="Workflows">
      <PageHeader
        eyebrow={workspaceName ?? workflowsQuery.data?.workspace.name ?? 'Workspace'}
        title="Workflows"
        description={realMode ? 'Open, rename or archive a durable workflow.' : 'Open a workflow or remove it from this frontend session.'}
      />

      {workflows.length > 0 ? (
        <ul className="workflow-card-list" data-testid="workflow-card-list">
          {workflows.map((workflow) => (
            <li
              className="workflow-card-item"
              data-testid={`workflow-card-${workflow.id}`}
              key={workflow.id}
            >
              <Card className="workflow-card">
                <Link
                  to="/workspaces/$workspaceId"
                  params={{ workspaceId }}
                  search={{ workflowId: workflow.id }}
                  className="workflow-card-open"
                  data-session-draft={sessionIds.has(workflow.id) ? 'true' : undefined}
                >
                  <Icon name="workflow" size={18} aria-hidden="true" />
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
              </Card>
            </li>
          ))}
        </ul>
      ) : (realMode ? managedQuery.isPending : !sessionWorkspace && workflowsQuery.isPending) ? (
        <LoadingState label="Loading workflows…" />
      ) : (realMode ? managedQuery.isError : !sessionWorkspace && workflowsQuery.isError) ? (
        <ErrorState title="Workflows unavailable" description="" />
      ) : (
        <div data-testid="workflow-directory-empty">
          <EmptyState
            icon="workflow"
            title="No workflows yet"
            description="Use New workflow in the navigation to create one."
          />
        </div>
      )}
    </section>
  )
}
