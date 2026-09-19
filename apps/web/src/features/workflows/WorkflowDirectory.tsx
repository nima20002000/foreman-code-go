import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'

import {
  queryKeys, useArchiveManagedWorkflowMutation, useManagedWorkflowsQuery,
  useUpdateManagedWorkflowMutation,
} from '../../shared/api/query'
import {
  Button, Card, EmptyState, ErrorState, Icon, IconButton, LoadingState, PageHeader, TextField,
} from '../../shared/ui/nocturne'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import './workflows.css'

function WorkflowCardActions({ name, onRename, onRemove }: {
  name: string
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [nextName, setNextName] = useState(name)
  const [nameError, setNameError] = useState<string>()
  const nameInputRef = useRef<HTMLInputElement>(null)
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
          <TextField
            ref={nameInputRef}
            label="Name"
            value={nextName}
            error={nameError}
            onChange={(event) => {
              setNextName(event.target.value)
              if (nameError) setNameError(undefined)
            }}
          />
          <Button onClick={() => {
            const value = nextName.trim()
            if (!value) {
              setNameError('Enter a workflow name.')
              nameInputRef.current?.focus()
              return
            }
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
  const queryClient = useQueryClient()
  const managedQuery = useManagedWorkflowsQuery(workspaceId, true)
  const updateWorkflow = useUpdateManagedWorkflowMutation()
  const archiveWorkflow = useArchiveManagedWorkflowMutation()
  const managed = managedQuery.data?.items ?? []
  const managedById = new Map(managed.map((item) => [item.workflow.id, item]))
  const workflows = managed.map((item) => item.workflow)

  return (
    <section className="workflow-directory" aria-label="Workflows">
      <PageHeader
        eyebrow="Workspace"
        title="Workflows"
        description="Open, rename or archive a durable workflow."
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
                >
                  <Icon name="workflow" size={18} aria-hidden="true" />
                  <span>{workflow.name}</span>
                </Link>
                <WorkflowCardActions
                  name={workflow.name}
                  onRename={(name) => {
                    const item = managedById.get(workflow.id)
                    if (!item) return
                    updateWorkflow.mutate({ workspaceId, workflowId: workflow.id, expectedRevision: item.revision, commandId: crypto.randomUUID(), name }, {
                      onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }),
                    })
                  }}
                  onRemove={() => {
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
      ) : managedQuery.isPending ? (
        <LoadingState label="Loading workflows…" />
      ) : managedQuery.isError ? (
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
