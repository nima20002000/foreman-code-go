import { useEffect } from 'react'
import { useIsMutating, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '../../shared/api/client'
import {
  useManagedWorkspaceQuery,
  useReloadWorkspaceLocationMutation,
  useSetWorkspaceLocationMutation,
  useValidateWorkspaceLocationMutation,
} from '../../shared/api/query'
import { locationMutationKey } from '../../shared/api/workspaceLocationCache'
import {
  acknowledgeLocationSave,
  editLocationDraft,
  hydrateLocationDraft,
  locationDraftConflicts,
  locationDraftFor,
  reloadLocationDraft,
  useWorkspaceLocationDraftStore,
} from './workspaceLocationDraftStore'

const RUNNER_ID = 'runner-local'

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'The location request failed.'
}

export function WorkspaceExecutionLocationSettings({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const validate = useValidateWorkspaceLocationMutation(workspaceId)
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
    return <section className="settings-section">
      <p role={workspace.isError ? 'alert' : 'status'}>{workspace.isError
        ? 'Execution location could not be loaded.' : 'Loading execution location…'}</p>
    </section>
  }
  if (current.locationValidation.status === 'restricted') {
    return <section className="settings-section"><p role="alert">You do not have permission to read this workspace’s execution location.</p></section>
  }
  if (!draft) return <section className="settings-section"><p role="status">Loading execution location…</p></section>

  const conflict = locationDraftConflicts(draft, current.locationRevision)
  const archived = current.archivedAt !== null
  const writable = !busy && !archived
  const status = current.locationValidation.status
  const unavailableMessage = current.locationValidation.status === 'unavailable' ? current.locationValidation.error.message : 'validation failed'
  const submittedDraft = () => {
    if (archived || queryClient.isMutating({ mutationKey: locationMutationKey(workspaceId) })) return undefined
    return locationDraftFor(useWorkspaceLocationDraftStore.getState(), workspaceId)
  }

  const validatePath = async () => {
    const submitted = submittedDraft()
    if (!submitted?.rootPath) return
    update(workspaceId, (value) => value ? { ...value, notice: undefined } : value)
    try {
      const result = await validate.mutateAsync({ workspaceId, runnerId: RUNNER_ID, rootPath: submitted.rootPath, accessMode: 'read-only' })
      if (result.workspaceId !== workspaceId) throw new Error('The validated location belongs to another workspace.')
      update(workspaceId, (value) => value ? {
        ...value,
        rootPath: value.editVersion === submitted.editVersion ? result.location.rootPath : value.rootPath,
        dirty: true,
        notice: value.editVersion === submitted.editVersion
          ? 'Location is valid on Local Runner.'
          : 'The submitted location is valid. Your newer unsaved path was preserved.',
      } : value)
    } catch (error) {
      update(workspaceId, (value) => value ? { ...value, notice: message(error) } : value)
    }
  }

  const savePath = async () => {
    const submitted = submittedDraft()
    if (!submitted?.dirty || !submitted.rootPath || locationDraftConflicts(submitted, current.locationRevision)) return
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
    }
  }

  const reloadSaved = async () => {
    const submitted = submittedDraft()
    if (!submitted) return
    try {
      const saved = await reload.mutateAsync({ workspaceId })
      if (saved.workspace.id !== workspaceId) throw new Error('The reloaded location belongs to another workspace.')
      update(workspaceId, (value) => value ? reloadLocationDraft(value, submitted.editVersion, saved) : value)
    } catch (error) {
      update(workspaceId, (value) => value ? { ...value, notice: `${message(error)} Your local edit was preserved.` } : value)
    }
  }

  return (
    <section className="settings-section" aria-labelledby="execution-location-title">
      <h2 id="execution-location-title">Execution location</h2>
      <p>Workspace: <strong>{current.workspace.name}</strong> ({workspaceId})</p>
      <p>Agents start in this folder. Filesystem restrictions depend on the selected harness and future isolation support.</p>
      {archived ? <p role="alert">This workspace is archived. Its execution location cannot be edited.</p> : null}
      <div className="settings-control">
        <span>Runner</span>
        <input aria-label="Execution runner" value="Local Runner" readOnly />
      </div>
      <div className="settings-control">
        <span>Folder path</span>
        <input
          aria-label="Execution folder path"
          value={draft.rootPath}
          placeholder="/absolute/path/to/project"
          disabled={archived || reload.isPending}
          onChange={(event) => {
            const path = event.target.value
            update(workspaceId, (value) => value ? editLocationDraft(value, path) : value)
          }}
        />
      </div>
      <p className="settings-save-status" role="status">
        {conflict
          ? 'The saved location changed elsewhere. Your unsaved path is preserved; reload the saved location to resolve the conflict.'
          : draft.dirty ? 'Unsaved location change.'
            : status === 'ready' ? 'Ready on Local Runner.'
              : status === 'unavailable' ? `Unavailable: ${unavailableMessage}`
                : 'No execution location is configured. New runs are disabled.'}
      </p>
      {draft.notice ? <p className="settings-save-status" role="status">{draft.notice}</p> : null}
      <div className="settings-actions">
        <button type="button" disabled={!writable || !draft.rootPath} onClick={() => void validatePath()}>
          {validate.isPending ? 'Validating…' : 'Validate'}
        </button>
        <button type="button" disabled={!writable || !draft.dirty || !draft.rootPath || conflict} onClick={() => void savePath()}>
          {save.isPending ? 'Saving…' : 'Save location'}
        </button>
        {conflict ? <button type="button" disabled={busy} onClick={() => void reloadSaved()}>
          {reload.isPending ? 'Reloading…' : 'Reload saved location'}
        </button> : null}
      </div>
    </section>
  )
}
