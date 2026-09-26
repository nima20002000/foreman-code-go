import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { createResourceSelection } from '../../shared/ui/resourceSelection'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { LoadMore } from '../../shared/ui/LoadMore'
import type { ManagedWorkspace, WorkspaceBatchArchiveInput } from '@graphql/contracts/management'

import {
  queryKeys, useArchiveManagedWorkspaceMutation, useWorkspacePages,
  useUpdateManagedWorkspaceMutation,
} from '../../shared/api/query'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { ApiError, apiClient } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Card, Checkbox, Dialog, EmptyState, ErrorState, Icon, IconButton, LoadingState, PageHeader, TextField } from '../../shared/ui/nocturne'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import '../../shared/ui/resourceDirectory.css'
interface CardCommand { type: 'rename' | 'archive'; workspaceId: string; expectedRevision: number; name?: string }

function WorkspaceCardActions({ workspaceId, name, revision = 0, onCommand }: {
  workspaceId: string
  name: string
  revision?: number
  onCommand: (input: CardCommand & { commandId: string }) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [nextName, setNextName] = useState(name)
  const [baseRevision, setBaseRevision] = useState(revision)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<CardCommand>())
  const lastCommand = useRef<CardCommand | undefined>(undefined)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    if (!inFlight.current && !attempt.current.unresolved) setOpen(false)
  }, [])
  useEffect(() => {
    // A refetch while the menu is open cannot attach a new revision to an old form.
    if (!open) { setNextName(name); setBaseRevision(revision) }
  }, [name, open, revision])
  useDismissableSurface({ open, onDismiss: close, surfaceRef, triggerRef })

  const submit = async (type: CardCommand['type']) => {
    if (inFlight.current) return
    const value = nextName.trim()
    if (type === 'rename' && !value) { setError('Enter a workspace name.'); return }
    inFlight.current = true
    setPending(true); setError(undefined)
    const generation = sessionGeneration()
    try {
      const input: CardCommand = attempt.current.unresolved && lastCommand.current ? lastCommand.current : {
        type, workspaceId, expectedRevision: baseRevision, ...(type === 'rename' ? { name: value } : {}),
      }
      lastCommand.current = input
      await onCommand(attempt.current.input(input))
      assertSession(generation)
      attempt.current.succeeded()
      setOpen(false)
    } catch (cause) {
      attempt.current.failed(cause)
      if (sessionGeneration() === generation) setError(cause instanceof Error ? cause.message : 'The workspace could not be updated.')
    } finally { inFlight.current = false; setPending(false) }
  }
  const uncertain = attempt.current.unresolved && !pending
  return (
    <div className="workspace-card-actions-wrap">
      <IconButton ref={triggerRef} label={`Open actions for ${name}`} variant="ghost"
        aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { if (open) close(); else { setNextName(name); setBaseRevision(revision); setError(undefined); setOpen(true) } }}>
        <Icon name="more" size={16} />
      </IconButton>
      {open ? <div ref={surfaceRef} className="workspace-card-actions" role="dialog" aria-label={`${name} actions`}>
        <TextField label="Name" disabled={pending || uncertain} value={nextName} onChange={(event) => setNextName(event.target.value)} />
        {error ? <Alert live tone="danger" title={error} /> : null}
        {uncertain ? <>
          <Alert live tone="warning" title="The previous request may have succeeded.">Retry it before making another change.</Alert>
          <Button onClick={() => void submit(lastCommand.current?.type ?? 'rename')}>Retry previous request</Button>
        </> : <>
          <Button disabled={pending} onClick={() => void submit('rename')}>Rename</Button>
          <Button variant="danger" disabled={pending} onClick={() => void submit('archive')}>Remove workspace</Button>
          <Button variant="ghost" disabled={pending} onClick={close}>Close</Button>
        </>}
      </div> : null}
    </div>
  )
}

export function WorkspaceDirectory() {
  const queryClient = useQueryClient()
  const managedQuery = useWorkspacePages(true)
  const updateWorkspace = useUpdateManagedWorkspaceMutation()
  const archiveWorkspace = useArchiveManagedWorkspaceMutation()

  const [selectionStore] = useState(createResourceSelection)
  const selection = useStore(selectionStore)
  const count = Object.keys(selection.selected).length
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceBatchArchiveInput, 'commandId'>>())
  const inFlight = useRef(false)
  const selectRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const wasSelecting = useRef(false)
  useEffect(() => {
    if (wasSelecting.current && !selection.selecting) selectRef.current?.focus()
    wasSelecting.current = selection.selecting
  }, [selection.selecting])
  const batch = useMutation({
    mutationFn: (input: WorkspaceBatchArchiveInput) => apiClient.archiveManagedWorkspaceBatch(input),
    onError: (error) => attempt.current.failed(error),
  })
  const locked = batch.isPending || attempt.current.unresolved
  const closeConfirmation = () => { if (!locked) { selection.confirm(false); batch.reset() } }
  const deleteSelected = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      const result = await batch.mutateAsync(attempt.current.input({
        workspaces: Object.entries(selection.selected).map(([workspaceId, expectedRevision]) => ({ workspaceId, expectedRevision })),
      }))
      assertSession(generation)
      attempt.current.succeeded()
      const deleted = new Set(result.value.workspaceIds)
      queryClient.setQueryData<InfiniteData<Awaited<ReturnType<typeof apiClient.listManagedWorkspacePage>>>>(
        [...queryKeys.managedWorkspaces, 'pages'], (current) => current ? {
          ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.filter((item) => !deleted.has(item.workspace.id)) })),
        } : current,
      )
      selection.clear(`${deleted.size} ${deleted.size === 1 ? 'workspace' : 'workspaces'} deleted.`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
      // Refresh cached details for every removed workspace without per-item HTTP reads.
      queryClient.removeQueries({ predicate: (query) => deleted.has(String(query.queryKey[3]))
        && query.queryKey[1] === 'management' && query.queryKey[2] === 'workspace' })
    } catch (error) { attempt.current.failed(error) }
    finally { inFlight.current = false }
  }

  const items = useMemo(() => managedQuery.data?.pages.flatMap((page) => page.items) ?? [], [managedQuery.data])
  const workspaces = useMemo(
    () => items.map((item) => item.workspace),
    [items],
  )
  const selectable = items.slice(0, 100).map((item) => ({ id: item.workspace.id, revision: item.revision }))
  const allShownSelected = selectable.length > 0 && selectable.every((item) => item.id in selection.selected)
  const managedById = new Map(items.map((item) => [item.workspace.id, item]))

  const execute = async (input: CardCommand & { commandId: string }) => {
    const { workspaceId, commandId, expectedRevision } = input
    const response = input.type === 'rename'
      ? await updateWorkspace.mutateAsync({ workspaceId, commandId, expectedRevision, name: input.name! })
      : await archiveWorkspace.mutateAsync({ workspaceId, commandId, expectedRevision })
    // The write has committed. Cache refresh failure must not turn it into a retryable write.
    queryClient.setQueryData<InfiniteData<{ items: ManagedWorkspace[]; pageInfo: { nextCursor: string | null } }>>([...queryKeys.managedWorkspaces, 'pages'], (current) => current ? {
      ...current,
      pages: current.pages.map((page) => ({ ...page, items: input.type === 'archive' ? page.items.filter((item) => item.workspace.id !== workspaceId)
        : page.items.map((item) => item.workspace.id === workspaceId ? response.value : item) })),
    } : current)
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) }),
    ]).catch(() => undefined)
  }
  const failed = managedQuery.isError && !managedQuery.isFetchNextPageError
  const loading = managedQuery.isPending
  const needsAccess = failed && ApiError.is(managedQuery.error) && managedQuery.error.status === 401
  return (
    <section className="workspace-directory resource-directory" aria-label="Workspaces">
      <PageHeader
        title="Workspaces"
        actions={workspaces.length > 0 && !failed ? <div className="resource-directory-actions">
          {!selection.selecting ? <Button ref={selectRef} onClick={selection.start}>Select workspaces</Button> : <>
            <span role="status">{count} selected</span>
            <Button disabled={locked} onClick={() => allShownSelected ? selection.deselectAll() : selection.selectMany(selectable)}>
              {allShownSelected ? 'Clear selection' : items.length > 100 ? 'Select first 100 shown' : 'Select all shown'}
            </Button>
            <Button variant="danger" disabled={!count || locked} onClick={() => selection.confirm(true)}>Delete selected{count ? ` (${count})` : ''}</Button>
            <Button disabled={locked} onClick={() => selection.clear()}>Cancel selection</Button>
          </>}
        </div> : undefined}
      />
      {selection.notice ? <p role="status">{selection.notice}</p> : null}
      {selection.selecting ? <p className="resource-selection-hint">Select workspaces to delete. You can show more and keep your selection. Up to 100 at a time.</p> : null}
      {needsAccess ? <EmptyState icon="warning" title="Connect this browser"
        description="App access is required to load workspaces."
        action={<Link to="/settings/operator-access" className="n-button n-button--primary">Open App access</Link>} />
        : failed ? <ErrorState title="Workspaces unavailable" description="The workspace list could not be loaded."
          onRetry={() => void managedQuery.refetch()} /> : workspaces.length > 0 ? (
        <ul className="workspace-card-list resource-card-list" data-testid="workspace-card-list">
          {workspaces.map((workspace) => <li key={workspace.id}>
            <Card className={`workspace-card resource-card${workspace.id in selection.selected ? ' is-selected' : ''}`} data-testid={`workspace-card-${workspace.id}`}>
              {selection.selecting ? <Checkbox className="resource-card-select" label={workspace.name}
                aria-label={`Select ${workspace.name}`} checked={workspace.id in selection.selected}
                disabled={locked || (count >= 100 && !(workspace.id in selection.selected))}
                onChange={() => selection.toggle(workspace.id, managedById.get(workspace.id)!.revision)} /> : <>
              <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId: workspace.id }} search={{}} className="workspace-card-open resource-card-open" aria-label={workspace.name}>
                <Icon name="grid" size={16} />
                <span className="resource-card-copy">
                  <span className="resource-card-name">{workspace.name}</span>
                  <small dir="ltr">{managedById.get(workspace.id)?.locationValidation.status === 'restricted'
                    ? 'Location restricted' : managedById.get(workspace.id)?.executionLocation?.rootPath || 'Choose a destination'}</small>
                </span>
              </Link>
              <WorkspaceCardActions workspaceId={workspace.id} name={workspace.name}
                revision={managedById.get(workspace.id)?.revision} onCommand={execute} /></>}
            </Card>
          </li>)}
        </ul>
      ) : loading ? <LoadingState label="Loading workspaces…" />
        : failed ? <Alert live tone="danger" title="Workspaces unavailable" />
          : <div data-testid="workspace-directory-empty">
            <EmptyState icon="folder" title="No workspaces yet" description="Use New workspace in the navigation to create one." />
          </div>}
      <LoadMore label="workspaces" query={managedQuery} />
      <Dialog open={selection.confirming} onOpenChange={(open) => { if (!open) closeConfirmation() }}
        title={`Delete ${count} ${count === 1 ? 'workspace' : 'workspaces'}?`}
        description="Selected workspaces will be removed from the list. Workflows, run history and project files are retained. Workspaces with active runs cannot be deleted."
        busy={locked} initialFocusRef={cancelRef} size="sm"
        footer={<>
          <Button ref={cancelRef} disabled={locked} onClick={closeConfirmation}>Cancel</Button>
          <Button variant="danger" disabled={batch.isPending} onClick={() => void deleteSelected()}>
            {batch.isPending ? 'Deleting…' : attempt.current.unresolved ? 'Retry deletion' : `Delete ${count} ${count === 1 ? 'workspace' : 'workspaces'}`}
          </Button>
        </>}>
        {batch.isError ? <Alert tone="danger" live title={batch.error.message} /> : null}
        {attempt.current.unresolved && !batch.isPending ? <p role="status">The request may have succeeded. Retry deletion to check its outcome safely.</p> : null}
      </Dialog>
    </section>
  )
}
