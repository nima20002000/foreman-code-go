import { errorMessage } from '../../shared/errorMessage'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createStore, useStore } from 'zustand'
import type { WorkspaceUpdateInput } from '@foreman-code/contracts/management'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { queryKeys, useUpdateManagedWorkspaceMutation } from '../../shared/api/query'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, TextField } from '../../shared/ui/nocturne'
import { TrashIconButton } from '../../shared/ui/ResourceCard'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { WorkspaceExecutionLocationSettings } from '../settings'
import { RemoveWorkspaceButton } from './RemoveWorkspaceButton'
import './workspaceSettingsHeader.css'

export function WorkspaceSettingsHeader({ workspaceId, name, revision, title = 'Settings', renderContent }: {
  workspaceId: string; name: string; revision: number; title?: string
  renderContent?: (actions: { rename(): void; remove(): void; chooseLocation(): void }) => ReactNode
}) {
  const [uiStore] = useState(() => createStore(() => ({ open: false, value: name, baseRevision: revision, error: undefined as string | undefined })))
  const { open, value, baseRevision, error } = useStore(uiStore)
  const setOpen = (open: boolean) => uiStore.setState({ open })
  const setValue = (value: string) => uiStore.setState({ value })
  const setBaseRevision = (baseRevision: number) => uiStore.setState({ baseRevision })
  const setError = (error: string | undefined) => uiStore.setState({ error })
  const mutation = useUpdateManagedWorkspaceMutation()
  const client = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const locationTrigger = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useEffect(() => {
    if (open) { input.current?.focus(); input.current?.select() }
    else if (wasEditing.current) trigger.current?.focus()
    wasEditing.current = open
  }, [open])
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceUpdateInput, 'commandId'>>())
  const original = useRef<Omit<WorkspaceUpdateInput, 'commandId'> | undefined>(undefined)
  const locked = mutation.isPending || attempt.current.unresolved
  const discard = () => { if (!locked) { setValue(name); setError(undefined); setOpen(false) } }
  const save = async () => {
    if (inFlight.current) return
    const next = value.trim()
    if (!next) { setError('Enter a workspace name.'); input.current?.focus(); throw new Error('Enter a workspace name.') }
    if (!attempt.current.unresolved && next === name) { setOpen(false); return }
    inFlight.current = true
    setError(undefined)
    const generation = sessionGeneration()
    try {
      original.current ??= { workspaceId, expectedRevision: baseRevision, name: next }
      const result = await mutation.mutateAsync(attempt.current.input(original.current))
      assertSession(generation)
      attempt.current.succeeded(); original.current = undefined
      client.setQueryData(queryKeys.managedWorkspace(workspaceId), result.value)
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
      void client.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
      setOpen(false)
    } catch (cause) {
      attempt.current.failed(cause)
      if (!attempt.current.unresolved) original.current = undefined
      if (generation === sessionGeneration()) setError(errorMessage(cause, 'The workspace could not be renamed.'))
      throw cause
    } finally { inFlight.current = false }
  }
  const leave = useUnsavedChanges({ scope: 'surface', label: 'workspace name', dirty: open && (value.trim() !== name || attempt.current.unresolved),
    busy: mutation.isPending, uncertain: attempt.current.unresolved, error, save, discard })
  const close = () => { if (!locked) void leave(() => setOpen(false)) }
  const rename = () => {
    if (locked) return
    if (open) { input.current?.focus(); return }
    setValue(name); setBaseRevision(revision); setError(undefined); mutation.reset(); setOpen(true)
  }
  return <>
    <RemoveWorkspaceButton workspaceId={workspaceId} name={name} revision={revision} renderTrigger={(remove) => <>
      <header className="workspace-settings-header">
      <div className="workspace-settings-identity">
        <div className="workspace-settings-name-row">
          <div className="workspace-settings-name-actions">
          {open ? <div className="workspace-settings-name-editor">
            <TextField ref={input} label="Workspace name" value={value} maxLength={200} disabled={locked} error={error}
              onChange={(event) => { setValue(event.target.value); setError(undefined) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void save().catch(() => undefined) }
                if (event.key === 'Escape') { event.preventDefault(); close() }
              }} />
            <Button size="sm" variant="primary" disabled={mutation.isPending} onClick={() => void save().catch(() => undefined)}>
              {mutation.isPending ? 'Saving…' : attempt.current.unresolved ? 'Retry rename' : 'Save name'}
            </Button>
            <Button size="sm" disabled={locked} onClick={close}>Cancel</Button>
          </div> : <>
            <button ref={trigger} type="button" className="workspace-settings-name n-eyebrow" title="Rename workspace"
              aria-label={`Rename workspace ${name}`} disabled={locked} onClick={rename}>{name}</button>
            <TrashIconButton target="workspace" action="Remove" className="workspace-settings-trash" disabled={locked} onClick={remove} />
          </>}
          </div>
          <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="compact" triggerRef={locationTrigger} />
        </div>
        {attempt.current.unresolved && !mutation.isPending ? <Alert tone="warning" title="The rename may have succeeded. Retry to confirm its outcome." /> : null}
        <h1>{title}</h1>
      </div>
      </header>
      {renderContent?.({ rename, remove: () => { if (!locked) void leave(remove) }, chooseLocation: () => { if (!locked) void leave(() => locationTrigger.current?.click()) } })}
    </>} />
  </>
}
