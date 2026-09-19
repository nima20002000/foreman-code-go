import { useContext, useEffect } from 'react'
import { useIsMutating, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '../../shared/api/client'
import {
  useManagedWorkspaceQuery,
  useReloadWorkspaceLocationMutation,
  useSetWorkspaceLocationMutation,
  useValidateWorkspaceLocationMutation,
} from '../../shared/api/query'
import { locationMutationKey } from '../../shared/api/workspaceLocationCache'
import { Alert, Button, LoadingState, SettingsSection, TextField } from '../../shared/ui/nocturne'
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

const RUNNER_ID = 'runner-local'

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'The location request failed.'
}

export function WorkspaceExecutionLocationSettings({ workspaceId }: { workspaceId: string }) {
  const toasts = useContext(ToastContext)
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
    return <SettingsSection title="Execution location">
      {workspace.isError
        ? <Alert live tone="danger" title="Execution location could not be loaded." />
        : <LoadingState label="Loading execution location…" />}
    </SettingsSection>
  }
  if (current.locationValidation.status === 'restricted') {
    return <SettingsSection title="Execution location">
      <Alert live tone="danger" title="You do not have permission to read this workspace’s execution location." />
    </SettingsSection>
  }
  if (!draft) return <SettingsSection title="Execution location"><LoadingState label="Loading execution location…" /></SettingsSection>

  const conflict = locationDraftConflicts(draft, current.locationRevision)
  const archived = current.archivedAt !== null
  const writable = !busy && !archived
  const status = current.locationValidation.status
  const unavailableMessage = current.locationValidation.status === 'unavailable' ? current.locationValidation.error.message : 'validation failed'
  const statusTone = conflict || draft.dirty ? 'warning' as const : status === 'ready' ? 'success' as const : status === 'unavailable' ? 'warning' as const : 'neutral' as const
  const statusLabel = conflict
    ? 'The saved location changed elsewhere. Your unsaved path is preserved; reload the saved location to resolve the conflict.'
    : draft.dirty ? 'Unsaved location change.'
      : status === 'ready' ? 'Ready on Local Runner.'
        : status === 'unavailable' ? `Unavailable: ${unavailableMessage}`
          : 'No execution location is configured. New runs are disabled.'
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
      toasts?.notify({ tone: 'success', title: 'Execution location validated', description: 'The folder is accessible on Local Runner.' })
    } catch (error) {
      update(workspaceId, (value) => value ? { ...value, notice: message(error) } : value)
      toasts?.notify({ tone: 'danger', title: 'Could not validate location', description: message(error) })
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
      toasts?.notify({ tone: 'success', title: 'Execution location saved', description: 'Future runs will use this folder.' })
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
    <SettingsSection title="Execution location">
      <p>Workspace: <strong>{current.workspace.name}</strong> ({workspaceId})</p>
      <p>Agents start in this folder. Filesystem restrictions depend on the selected harness and future isolation support.</p>
      {archived ? <Alert live tone="danger" title="This workspace is archived. Its execution location cannot be edited." /> : null}
      <TextField label="Runner" value="Local Runner" readOnly aria-label="Execution runner" />
      <TextField label="Folder path" aria-label="Execution folder path" value={draft.rootPath} placeholder="/absolute/path/to/project" disabled={archived || reload.isPending}
        onChange={(event) => {
          const path = event.target.value
          update(workspaceId, (value) => value ? editLocationDraft(value, path) : value)
        }} />
      <Alert live tone={statusTone} title={statusLabel} />
      {draft.notice ? <p className="settings-save-status" role="status">{draft.notice}</p> : null}
      <div className="settings-location-actions">
        <Button disabled={!writable || !draft.rootPath} onClick={() => void validatePath()}>
          {validate.isPending ? 'Validating…' : 'Validate'}
        </Button>
        <Button disabled={!writable || !draft.dirty || !draft.rootPath || conflict} onClick={() => void savePath()}>
          {save.isPending ? 'Saving…' : 'Save location'}
        </Button>
        {conflict ? <Button disabled={busy} onClick={() => void reloadSaved()}>
          {reload.isPending ? 'Reloading…' : 'Reload saved location'}
        </Button> : null}
      </div>
    </SettingsSection>
  )
}
