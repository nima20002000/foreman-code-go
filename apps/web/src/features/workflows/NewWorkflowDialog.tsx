import { useRef, useState, type FormEvent } from 'react'

import { useSessionWorkflowStore } from './sessionWorkflowStore'

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
  const createSessionWorkflow = useSessionWorkflowStore((state) => state.createSessionWorkflow)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [nameError, setNameError] = useState<string>()
  const nameInputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError('Enter a workflow name.')
      nameInputRef.current?.focus()
      return
    }
    const workflow = createSessionWorkflow({ workspaceId, name: trimmedName, description })
    onCreated(workflow.id)
  }

  return (
    <div className="new-workflow-dialog-content">
      <header>
        <p className="panel-kicker">Workspace workflow</p>
        <h1 id="new-workflow-title">New workflow</h1>
        <p>
          Start an empty workflow{workspaceName ? ` in ${workspaceName}` : ''} and open its graph
          editor. You can add agent steps after the draft is created.
        </p>
      </header>

      <form className="new-workflow-form" aria-label="New workflow" noValidate onSubmit={handleSubmit}>
        <label htmlFor="new-workflow-name">Name</label>
        <input
          ref={nameInputRef}
          id="new-workflow-name"
          name="name"
          type="text"
          value={name}
          autoFocus
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

        <label htmlFor="new-workflow-description">
          Description <span>(optional)</span>
        </label>
        <textarea
          id="new-workflow-description"
          name="description"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

        <p className="new-workflow-session-note" role="note">
          This draft lives only in this browser session. It is not sent to the workspace backend,
          and it disappears when you refresh or close the tab.
        </p>

        <div className="new-workflow-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="new-workflow-create">
            Create workflow
          </button>
        </div>
      </form>
    </div>
  )
}
