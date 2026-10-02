import { useRef, useState } from 'react'
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { WorkspaceStorageFolder, WorkspaceStorageFolderDeleteInput } from '@graphql/contracts/management'
import { ApiError, apiClient } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { queryKeys, useWorkspaceStorageFolderPages } from '../../shared/api/query'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Card, Dialog, ErrorState, Icon, LoadingState } from '../../shared/ui/nocturne'
import { LoadMore } from '../../shared/ui/LoadMore'

function FolderCard({ folder }: { folder: WorkspaceStorageFolder }) {
  const [confirming, setConfirming] = useState(false)
  const queryClient = useQueryClient()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceStorageFolderDeleteInput, 'commandId'>>())
  const target = useRef(folder)
  const removal = useMutation({ mutationFn: (input: WorkspaceStorageFolderDeleteInput) => apiClient.deleteWorkspaceStorageFolder(input) })
  const locked = removal.isPending || attempt.current.unresolved
  const close = () => { if (!locked) { setConfirming(false); removal.reset() } }
  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      const result = await removal.mutateAsync(attempt.current.input({ path: target.current.path, expectedIdentity: target.current.identity }))
      assertSession(generation)
      attempt.current.succeeded()
      queryClient.setQueryData<InfiniteData<Awaited<ReturnType<typeof apiClient.listWorkspaceStorageFolderPage>>>>(
        queryKeys.workspaceStorageFolders, (current) => current ? {
          ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.path !== result.value.path) })),
        } : current,
      )
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceStorageFolders })
    } catch (error) { attempt.current.failed(error) }
    finally { inFlight.current = false }
  }
  return <Card className="workspace-card resource-card">
    <div className="workspace-card-open resource-card-open">
      <Icon name="folder" size={16} />
      <span className="resource-card-copy">
        <span className="resource-card-name">{folder.name}</span>
        <small dir="ltr">{folder.path}</small>
        <small>Folder on disk · Not in the active workspace list</small>
        {folder.deletion.status === 'protected' ? <small>{folder.deletion.message}</small> : null}
      </span>
    </div>
    <Button variant="danger" size="sm" disabled={folder.deletion.status === 'protected'}
      onClick={() => { target.current = folder; setConfirming(true) }}>Delete folder</Button>
    <Dialog open={confirming} onOpenChange={(open) => { if (!open) close() }}
      title={`Delete ${target.current.name}?`} busy={locked} initialFocusRef={cancelRef} size="sm"
      description="This permanently deletes this workspace folder and all its files and subfolders. It cannot be undone."
      footer={<>
        <Button ref={cancelRef} disabled={locked} onClick={close}>Cancel</Button>
        <Button variant="danger" disabled={removal.isPending} onClick={() => void remove()}>
          {removal.isPending ? 'Deleting…' : attempt.current.unresolved ? 'Retry deletion' : 'Delete folder and contents'}
        </Button>
      </>}>
      <p dir="ltr">{target.current.path}</p>
      {removal.isError ? <Alert live tone="danger" title={removal.error.message} /> : null}
      {attempt.current.unresolved && !removal.isPending ? <p role="status">The request may have succeeded. Retry deletion to check its outcome safely.</p> : null}
    </Dialog>
  </Card>
}

export function WorkspaceStorageFolderCards({ enabled }: { enabled: boolean }) {
  const folders = useWorkspaceStorageFolderPages(enabled)
  // Workspace-scoped readers cannot browse unrelated folders on the runner.
  if (!enabled || (folders.isError && ApiError.is(folders.error) && folders.error.status === 403)) return null
  const items = folders.data?.pages.flatMap((page) => page.items) ?? []
  if (folders.isPending) return <LoadingState label="Checking workspace folders…" />
  if (folders.isError && !folders.isFetchNextPageError) return <ErrorState title="Workspace folders unavailable"
    description="Folders on disk could not be checked." onRetry={() => void folders.refetch()} />
  if (!items.length) return null
  return <section aria-label="Workspace folders on disk">
    <h2>Workspace folders on disk</h2>
    <p>Other folders in the app’s Workspaces location. Folders still used by workspace settings or active runs are protected.</p>
    <ul className="workspace-card-list resource-card-list">
      {items.map((folder) => <li key={folder.path}><FolderCard folder={folder} /></li>)}
    </ul>
    <LoadMore label="workspace folders" query={folders} />
  </section>
}
