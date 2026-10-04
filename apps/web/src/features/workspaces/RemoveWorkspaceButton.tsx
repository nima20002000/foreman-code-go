import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkspaceArchiveInput } from '@foreman-code/contracts/management'

import { CommandAttempt } from '../../shared/api/commandAttempt'
import { queryKeys, useArchiveManagedWorkspaceMutation } from '../../shared/api/query'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog, Icon, IconButton } from '../../shared/ui/nocturne'

export function RemoveWorkspaceButton({ workspaceId, name, revision, renderTrigger }: {
  workspaceId: string
  name: string
  revision: number
  renderTrigger?: (open: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [baseRevision, setBaseRevision] = useState(revision)
  const latestRevision = useRef(revision)
  useLayoutEffect(() => { latestRevision.current = revision }, [revision])
  const mutation = useArchiveManagedWorkspaceMutation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceArchiveInput, 'commandId'>>())
  const inFlight = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const locked = mutation.isPending || attempt.current.unresolved
  const close = () => { if (!locked) { setOpen(false); mutation.reset() } }
  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      await mutation.mutateAsync(attempt.current.input({ workspaceId, expectedRevision: baseRevision }))
      assertSession(generation)
      attempt.current.succeeded()
    } catch (error) {
      attempt.current.failed(error)
      return
    } finally { inFlight.current = false }
    setOpen(false)
    void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces }).catch(() => undefined)
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) }).catch(() => undefined)
    void navigate({ to: '/workspaces', replace: true })
  }

  const show = () => {
      // A preceding unsaved-name Save may have advanced the revision before this action opens.
      setBaseRevision(latestRevision.current); mutation.reset(); setOpen(true)
  }
  return <>
    {renderTrigger ? renderTrigger(show) : <IconButton label="Remove workspace" variant="ghost" className="workspace-remove-button" onClick={show}><Icon name="trash" size={16} /></IconButton>}
    <Dialog open={open} onOpenChange={(value) => { if (!value) close() }}
      title={`Remove ${name}?`}
      description="This workspace will be removed from the list. App-created project folders and their contents will be deleted. Existing folders you selected are kept. Workflow and run history is retained. Workspaces with active runs cannot be removed."
      busy={locked} initialFocusRef={cancelRef} size="sm"
      footer={<>
        <Button ref={cancelRef} disabled={locked} onClick={close}>Cancel</Button>
        <Button variant="danger" disabled={mutation.isPending} onClick={() => void remove()}>
          {mutation.isPending ? 'Removing…' : attempt.current.unresolved ? 'Retry removal' : 'Remove workspace'}
        </Button>
      </>}>
      {mutation.isError ? <Alert tone="danger" live title={mutation.error.message} /> : null}
      {attempt.current.unresolved && !mutation.isPending ? <p role="status">The request may have succeeded. Retry removal to check its outcome safely.</p> : null}
    </Dialog>
  </>
}
