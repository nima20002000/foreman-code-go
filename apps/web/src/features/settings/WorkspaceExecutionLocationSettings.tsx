import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { useContext, useEffect } from 'react'
import { useIsMutating, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '../../shared/api/client'
import {
  useManagedWorkspaceQuery,
  useReloadWorkspaceLocationMutation,
  useSetWorkspaceLocationMutation,
} from '../../shared/api/query'
import { locationMutationKey } from '../../shared/api/workspaceLocationCache'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'
import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import {
  acknowledgeLocationSave,
  editLocationDraft,
  hydrateLocationDraft,
  locationDraftConflicts,
  locationDraftFor,
  reloadLocationDraft,
  useWorkspaceLocationDraftStore,
} from './workspaceLocationDraftStore'

import { WorkspaceFolderPicker } from './WorkspaceFolderPicker'

const RUNNER_ID = 'runner-local'

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'The location request failed.'
}

export function WorkspaceExecutionLocationSettings({ workspaceId }: { workspaceId: string }) {
  const toasts = useContext(ToastContext)
  const queryClient = useQueryClient()
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const save = useSetWorkspaceLocationMutation(workspaceId)
  const reload = useReloadWorkspaceLocationMutation(workspaceId)
  const busy = useIsMutating({ mutationKey: locationMutationKey(workspaceId) }) > 0
  const draft = useWorkspaceLocationDraftStore((state) => locationDraftFor(state, workspaceId))
  const update = useWorkspaceLocationDraftStore((state) => state.update)
  const current = workspace.data?.workspace.id === workspaceId ? workspace.data : undefined

  useEffect(() => {
    if (current) update(workspaceId, (previous) => hydrateLocationDraft(previous, current))
  }, [current, draft, update, workspaceId])

  // A draft alone is not authority to write: the selected workspace must have
  // loaded its own saved record. Never render A's form while B is loading.
  if (!current) {
    return <section className="workspace-location-form" aria-label="Project folder">
      {workspace.isError
        ? <Alert live tone="danger" title="Execution location could not be loaded." />
        : <LoadingState label="Loading execution location…" />}
    </section>
  }
  if (current.locationValidation.status === 'restricted') {
    return <section className="workspace-location-form" aria-label="Project folder">
      <Alert live tone="danger" title="You do not have permission to read this workspace’s execution location." />
    </section>
  }
  if (!draft) return <section className="workspace-location-form" aria-label="Project folder"><LoadingState label="Loading execution location…" /></section>

  const conflict = locationDraftConflicts(draft, current.locationRevision)
  const archived = current.archivedAt !== null
  const writable = !busy && !archived
  const status = current.locationValidation.status
  const unavailableMessage = current.locationValidation.status === 'unavailable' ? current.locationValidation.error.message : 'validation failed'
  const submittedDraft = () => {
    if (archived || queryClient.isMutating({ mutationKey: locationMutationKey(workspaceId) })) return undefined
    return locationDraftFor(useWorkspaceLocationDraftStore.getState(), workspaceId)
  }

  const savePath = async () => {
    const submitted = submittedDraft()
    if (!submitted?.dirty || !submitted.rootPath || locationDraftConflicts(submitted, current.locationRevision)) return false
    update(workspaceId, (value) => value ? { ...value, notice: undefined } : value)
    try {
      // mutateAsync settles even after this route unmounts. Apply the result to
      // its submitted workspace's draft, never the workspace navigated to later.
      const result = await save.mutateAsync({
        workspaceId, runnerId: RUNNER_ID, rootPath: submitted.rootPath,
        expectedLocationRevision: submitted.baseRevision, commandId: crypto.randomUUID(),
      })
      update(workspaceId, (value) => value ? acknowledgeLocationSave(
        value, submitted.editVersion, result.value.executionLocation.rootPath, result.value.locationRevision,
      ) : value)
      toasts?.notify({ tone: 'success', title: 'Execution location saved', description: 'Future runs will use this folder.' })
      return true
    } catch (error) {
      update(workspaceId, (value) => {
        if (!value) return value
        const revision = error instanceof ApiError ? error.details?.currentLocationRevision : undefined
        return {
          ...value,
          conflictRevision: error instanceof ApiError && error.code === 'LOCATION_REVISION_CONFLICT'
            ? Math.max(value.conflictRevision ?? 0, typeof revision === 'number' ? revision : submitted.baseRevision + 1)
            : value.conflictRevision,
          notice: message(error),
        }
      })
      toasts?.notify({ tone: 'danger', title: 'Execution location not saved', description: message(error) })
      return false
    }
  }

  const reloadSaved = async () => {
    const submitted = submittedDraft()
    if (!submitted) return
    try {
      const saved = await reload.mutateAsync({ workspaceId })
      if (saved.workspace.id !== workspaceId) throw new Error('The reloaded location belongs to another workspace.')
      update(workspaceId, (value) => value ? reloadLocationDraft(value, submitted.editVersion, saved) : value)
      toasts?.notify({ tone: 'info', title: 'Saved location reloaded' })
    } catch (error) {
      update(workspaceId, (value) => value ? { ...value, notice: `${message(error)} Your local edit was preserved.` } : value)
      toasts?.notify({ tone: 'danger', title: 'Could not reload location', description: message(error) })
    }
  }

  return (
    <section className="workspace-location-form" aria-label="Project folder">
      <UnsavedEditorGuard editor={{ label: 'execution location', dirty: draft.dirty, busy,
        saveDisabled: archived || conflict || !draft.rootPath,
        error: conflict ? 'The saved location changed. Keep editing to resolve the conflict.' : save.isError ? message(save.error) : undefined,
        save: async () => { await savePath() },
        discard: () => update(workspaceId, () => hydrateLocationDraft(undefined, current)),
      }} />
      {archived ? <Alert live tone="danger" title="This workspace is archived. Its execution location cannot be edited." /> : null}
      <WorkspaceFolderPicker key={workspaceId} value={draft.rootPath} disabled={!writable || conflict} onSelect={async (path) => {
        update(workspaceId, (value) => value ? editLocationDraft(value, path) : value)
        if (!await savePath()) {
          throw new Error(locationDraftFor(useWorkspaceLocationDraftStore.getState(), workspaceId)?.notice
            ?? 'The saved location changed. Close this dialog and reload the saved location.')
        }
      }} />
      {conflict ? <Alert live tone="warning" title="The saved location changed elsewhere. Reload it to resolve the conflict." />
        : status === 'unavailable' && !draft.dirty ? <Alert live tone="warning" title={unavailableMessage} /> : null}
      {draft.notice ? <p className="settings-save-status" role="status">{draft.notice}</p> : null}
      <div className="settings-location-actions">
        {conflict ? <Button disabled={busy} onClick={() => void reloadSaved()}>
          {reload.isPending ? 'Reloading…' : 'Reload saved location'}
        </Button> : null}
      </div>
    </section>
  )
}
