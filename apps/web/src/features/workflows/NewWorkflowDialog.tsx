import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useRef, useState } from 'react'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'

import { useQueryClient } from '@tanstack/react-query'
import type { WorkflowDefinition, WorkspaceDetailsResponse } from '@graphql/contracts'
import { getWorkspaceDetails } from '../../shared/api/client'
import { queryKeys, useCreateManagedWorkflowMutation } from '../../shared/api/query'
import { Button, Dialog, Textarea, TextField } from '../../shared/ui/nocturne'

export interface NewWorkflowDialogProps {
  workspaceId: string
  workspaceName?: string
  onCreated: (workflowId: string) => void
  onCancel: () => void
}

/** Compact form used by the New workflow dialog. */
export function NewWorkflowDialog({
  workspaceId,
  workspaceName,
  onCreated,
  onCancel,
}: NewWorkflowDialogProps) {
  const queryClient = useQueryClient()
  const createManagedWorkflow = useCreateManagedWorkflowMutation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [nameError, setNameError] = useState<string>()
  const [createdWorkflow, setCreatedWorkflow] = useState<WorkflowDefinition>()
  const [openError, setOpenError] = useState<string>()
  const [opening, setOpening] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const created = useRef(false)
  const attempt = useRef(new CommandAttempt<{ workspaceId: string; name: string; description?: string }>())
  const pending = createManagedWorkflow.isPending || opening
  const uncertain = attempt.current.unresolved && !pending

  const openCreated = async (workflow: WorkflowDefinition) => {
    if (inFlight.current) return
    inFlight.current = true
    setOpening(true)
    setOpenError(undefined)
    try {
      const detailsKey = queryKeys.workspaceDetails(workspaceId)
      // A pending older read must not replace the accepted create response.
      await queryClient.cancelQueries({ queryKey: detailsKey })
      if (!queryClient.getQueryData(detailsKey)) {
        await queryClient.fetchQuery({
          queryKey: detailsKey,
          queryFn: ({ signal }) => getWorkspaceDetails({ workspaceId }, { signal }),
        })
      }
      queryClient.setQueryData<WorkspaceDetailsResponse>(detailsKey, (current) => current && ({
        ...current,
        workflows: current.workflows.some((item) => item.id === workflow.id)
          ? current.workflows.map((item) => item.id === workflow.id ? workflow : item)
          : [...current.workflows, workflow],
      }))
      void queryClient.invalidateQueries({ queryKey: detailsKey, refetchType: 'none' }).catch(() => undefined)
      onCreated(workflow.id)
    } catch {
      setOpenError('Workflow created, but its graph could not be opened. Retry opening it.')
    } finally {
      inFlight.current = false
      setOpening(false)
    }
  }

  const create = async () => {
    if (inFlight.current) return
    if (createdWorkflow) { await openCreated(createdWorkflow); return }
    const trimmedName = name.trim()
    if (!trimmedName) { setNameError('Enter a workflow name.'); nameInputRef.current?.focus(); return }
    inFlight.current = true
    const generation = sessionGeneration()
    setNameError(undefined)
    let workflow: WorkflowDefinition | undefined
    try {
      const input = { workspaceId, name: trimmedName, ...(description ? { description } : {}) }
      workflow = (await createManagedWorkflow.mutateAsync(attempt.current.input(input))).value.workflow
      assertSession(generation)
      attempt.current.succeeded()
      created.current = true
      setCreatedWorkflow(workflow)
      void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }).catch(() => undefined)
    } catch (error) {
      attempt.current.failed(error)
      if (sessionGeneration() === generation) setNameError(error instanceof Error ? error.message : 'The workflow could not be created.')
    } finally { inFlight.current = false }
    if (workflow && created.current) await openCreated(workflow)
  }

  const leave = useUnsavedChanges({ scope: 'surface', label: 'new workflow', get dirty() { return !created.current && Boolean(name || description) },
    get busy() { return inFlight.current && !created.current }, uncertain, error: nameError, save: create,
    discard: () => { setName(''); setDescription(''); setNameError(undefined) },
  })
  const close = () => { if (!inFlight.current && !attempt.current.unresolved) void leave(onCancel) }

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => { if (!nextOpen) close() }}
      title="New workflow"
      description={`Start an empty workflow${workspaceName ? ` in ${workspaceName}` : ''} and open its graph editor. You can add agent steps after the draft is created.`}
      busy={pending || uncertain}
      closeOnOutsideClick
      initialFocusRef={nameInputRef}
    >
      <form className="new-workflow-form" aria-label="New workflow" noValidate onSubmit={(event) => { event.preventDefault(); void create() }}>
        <p className="panel-kicker">Workspace workflow</p>

        <TextField
          ref={nameInputRef}
          id="new-workflow-name"
          label="Name"
          name="name"
          type="text"
          value={name}
          disabled={pending || uncertain || Boolean(createdWorkflow)}
          required
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'new-workflow-name-error' : undefined}
          onChange={(event) => {
            setName(event.target.value)
            if (nameError) setNameError(undefined)
          }}
        />
        {nameError ? (
          <p id="new-workflow-name-error" className="new-workflow-error" role="alert">
            {nameError}
          </p>
        ) : null}

        <Textarea
          id="new-workflow-description"
          label="Description"
          hint="(optional)"
          name="description"
          rows={3}
          value={description}
          disabled={pending || uncertain || Boolean(createdWorkflow)}
          onChange={(event) => setDescription(event.target.value)}
        />

        <p className="new-workflow-session-note" role="note">
          This empty workflow is stored by the workspace backend.
        </p>

        {uncertain ? <p role="status">The previous request may have succeeded. Retry Create workflow to resolve it without creating a duplicate.</p> : null}
        {openError ? <p role="alert">{openError}</p> : null}
        <div className="new-workflow-actions">
          <Button onClick={close} disabled={pending || uncertain}>
            {createdWorkflow ? 'Close' : 'Cancel'}
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {createdWorkflow ? 'Open workflow' : 'Create workflow'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
