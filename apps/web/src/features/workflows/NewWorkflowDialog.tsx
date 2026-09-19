import { useRef, useState, type FormEvent } from 'react'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'

import { useQueryClient } from '@tanstack/react-query'
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
  const nameInputRef = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<{ workspaceId: string; name: string; description?: string }>())
  const pending = createManagedWorkflow.isPending
  const uncertain = attempt.current.unresolved && !pending
  const close = () => { if (!inFlight.current && !attempt.current.unresolved) onCancel() }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlight.current) return
    const trimmedName = name.trim()
    if (!trimmedName) { setNameError('Enter a workflow name.'); nameInputRef.current?.focus(); return }
    inFlight.current = true
    const generation = sessionGeneration()
    setNameError(undefined)
    try {
      const input = { workspaceId, name: trimmedName, ...(description ? { description } : {}) }
      const workflow = (await createManagedWorkflow.mutateAsync(attempt.current.input(input))).value.workflow
      assertSession(generation)
      attempt.current.succeeded()
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) }),
      ]).catch(() => undefined)
      onCreated(workflow.id)
    } catch (error) {
      attempt.current.failed(error)
      if (sessionGeneration() === generation) setNameError(error instanceof Error ? error.message : 'The workflow could not be created.')
    } finally { inFlight.current = false }
  }

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
      <form className="new-workflow-form" aria-label="New workflow" noValidate onSubmit={handleSubmit}>
        <p className="panel-kicker">Workspace workflow</p>

        <TextField
          ref={nameInputRef}
          id="new-workflow-name"
          label="Name"
          name="name"
          type="text"
          value={name}
          disabled={pending || uncertain}
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
          disabled={pending || uncertain}
          onChange={(event) => setDescription(event.target.value)}
        />

        <p className="new-workflow-session-note" role="note">
          This empty workflow is stored by the workspace backend.
        </p>

        {uncertain ? <p role="status">The previous request may have succeeded. Retry Create workflow to resolve it without creating a duplicate.</p> : null}
        <div className="new-workflow-actions">
          <Button onClick={close} disabled={pending || uncertain}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            Create workflow
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
