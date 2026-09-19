import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { ManagedWorkspace } from '@graphql/contracts/management'

import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { useSessionWorkflowStore } from '../workflows/sessionWorkflowStore'
import {
  queryKeys, useArchiveManagedWorkspaceMutation, useManagedWorkspacesQuery,
  useUpdateManagedWorkspaceMutation, useWorkspaceDetailsQuery,
} from '../../shared/api/query'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Card, EmptyState, ErrorState, Icon, IconButton, LoadingState, PageHeader, TextField } from '../../shared/ui/nocturne'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import { useNavigationUiStore } from './navigationUiStore'
import { useWorkspaceSessionStore } from './workspaceSessionStore'

const DEFAULT_WORKSPACE_ID = 'workspace-1'
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
      <IconButton ref={triggerRef} label={`Open actions for ${name}`}
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
  const realMode = import.meta.env.MODE !== 'test' && (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false')
  const queryClient = useQueryClient()
  const workspaceQuery = useWorkspaceDetailsQuery(DEFAULT_WORKSPACE_ID, { enabled: !realMode })
  const managedQuery = useManagedWorkspacesQuery(realMode)
  const updateWorkspace = useUpdateManagedWorkspaceMutation()
  const archiveWorkspace = useArchiveManagedWorkspaceMutation()
  const sessionWorkspaces = useWorkspaceSessionStore((state) => state.workspaces)
  const knownWorkspaces = useWorkspaceSessionStore((state) => state.knownWorkspaces)
  const hiddenWorkspaceIds = useWorkspaceSessionStore((state) => state.hiddenWorkspaceIds)
  const workspaceNameOverrides = useWorkspaceSessionStore((state) => state.workspaceNameOverrides)
  const registerWorkspace = useWorkspaceSessionStore((state) => state.registerWorkspace)
  const removeWorkspace = useWorkspaceSessionStore((state) => state.removeWorkspace)
  const renameWorkspace = useWorkspaceSessionStore((state) => state.renameWorkspace)
  const removeWorkspaceState = useNavigationUiStore((state) => state.removeWorkspaceState)
  const removeWorkspaceAgents = useAgentDirectoryStore((state) => state.removeWorkspace)
  const removeWorkspaceWorkflows = useSessionWorkflowStore((state) => state.removeWorkspaceWorkflows)

  useEffect(() => {
    if (workspaceQuery.data?.workspace) registerWorkspace(workspaceQuery.data.workspace)
  }, [registerWorkspace, workspaceQuery.data?.workspace])

  const workspaces = useMemo(() => {
    if (realMode) return managedQuery.isError ? [] : managedQuery.data?.items.map((item) => item.workspace) ?? []
    const hidden = new Set(hiddenWorkspaceIds)
    const entries = [...(workspaceQuery.data?.workspace ? [workspaceQuery.data.workspace] : []), ...knownWorkspaces, ...sessionWorkspaces]
    return [...new Map(entries.filter((workspace) => !hidden.has(workspace.id)).map((workspace) => [workspace.id, {
      ...workspace, name: workspaceNameOverrides[workspace.id] ?? workspace.name,
    }])).values()]
  }, [hiddenWorkspaceIds, knownWorkspaces, managedQuery.data?.items, managedQuery.isError, realMode,
    sessionWorkspaces, workspaceNameOverrides, workspaceQuery.data?.workspace])
  const managedById = new Map(managedQuery.data?.items.map((item) => [item.workspace.id, item]))

  const execute = async (input: CardCommand & { commandId: string }) => {
    const { workspaceId, commandId, expectedRevision } = input
    if (realMode) {
      const response = input.type === 'rename'
        ? await updateWorkspace.mutateAsync({ workspaceId, commandId, expectedRevision, name: input.name! })
        : await archiveWorkspace.mutateAsync({ workspaceId, commandId, expectedRevision })
      // The write has committed. Cache refresh failure must not turn it into a retryable write.
      queryClient.setQueryData<{ items: ManagedWorkspace[]; pageInfo: { nextCursor: string | null } }>(queryKeys.managedWorkspaces, (current) => current ? {
        ...current,
        items: input.type === 'archive' ? current.items.filter((item) => item.workspace.id !== workspaceId)
          : current.items.map((item) => item.workspace.id === workspaceId ? response.value : item),
      } : current)
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) }),
      ]).catch(() => undefined)
      return
    }
    if (input.type === 'rename') { renameWorkspace(workspaceId, input.name!); return }
    removeWorkspace(workspaceId); removeWorkspaceState(workspaceId)
    removeWorkspaceAgents(workspaceId); removeWorkspaceWorkflows(workspaceId)
  }
  const failed = realMode ? managedQuery.isError : workspaceQuery.isError && hiddenWorkspaceIds.length === 0
  const loading = realMode ? managedQuery.isPending : workspaceQuery.isPending
  const needsAccess = realMode && failed && ApiError.is(managedQuery.error) && managedQuery.error.status === 401
  return (
    <section className="workspace-directory n-theme" aria-label="Workspaces">
      <PageHeader
        eyebrow="GraphQL"
        title="Workspaces"
        description={realMode ? 'Open, rename or archive a durable workspace.' : 'Open a workspace or remove it from this frontend session.'}
      />
      {needsAccess ? <EmptyState icon="warning" title="Connect this browser"
        description="App access is required to load workspaces."
        action={<Link to="/settings/operator-access" className="n-button n-button--primary">Open App access</Link>} />
        : realMode && failed ? <ErrorState title="Workspaces unavailable" description="The workspace list could not be loaded."
          onRetry={() => void managedQuery.refetch()} /> : workspaces.length > 0 ? (
        <ul className="workspace-card-list" data-testid="workspace-card-list">
          {workspaces.map((workspace) => <li key={workspace.id}>
            <Card className="workspace-card" data-testid={`workspace-card-${workspace.id}`}>
              <Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} search={{}} className="workspace-card-open">
                <Icon name="grid" size={18} /><span>{workspace.name}</span>
              </Link>
              <WorkspaceCardActions workspaceId={workspace.id} name={workspace.name}
                revision={managedById.get(workspace.id)?.revision} onCommand={execute} />
            </Card>
          </li>)}
        </ul>
      ) : loading ? <LoadingState label="Loading workspaces…" />
        : failed ? <Alert live tone="danger" title="Workspaces unavailable" />
          : <div data-testid="workspace-directory-empty">
            <EmptyState icon="folder" title="No workspaces yet" description="Use New workspace in the navigation to create one." />
          </div>}
    </section>
  )
}
