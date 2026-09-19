import { useContext, useEffect, useId, useRef, useState } from 'react'
import { useCreateWorkspaceFolder, useHarnessDirectories, useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { WorkspaceFolderCreateInputSchema } from '@graphql/contracts/management'
import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { Alert, Button, Dialog, Icon, IconButton, LoadingState, TextField } from '../../shared/ui/nocturne'
import './workspaceLocation.css'

type Props = { disabled: boolean; onSelect(path: string): void | Promise<void>; value?: string; label?: string; selectionUnconfirmed?: boolean; copyValue?: string }
type Location = Parameters<typeof useHarnessDirectories>[0]
type HistoryEntry = { location: Location; selectedPath?: string; locationsOpen: boolean }

function FolderPicker({ disabled, onSelect, value, label = 'Project folder', selectionUnconfirmed = false, copyValue }: Props) {
  const [open, setOpen] = useState(false)
  const toasts = useContext(ToastContext)
  const id = useId()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const [selecting, setSelecting] = useState(false)
  const [selectionError, setSelectionError] = useState<string>()
  // Browsing, a highlighted candidate, and the saved prop are different states.
  const [selectedPath, setSelectedPath] = useState<string>()
  const [locationsOpen, setLocationsOpen] = useState(true)
  const [location, setLocation] = useState<Location>({})
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const create = useCreateWorkspaceFolder()
  const attempt = useRef(new CommandAttempt<{ parentPath: string; name: string }>())
  const inFlight = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const newFolderRef = useRef<HTMLButtonElement>(null)
  const pathRef = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef<'path' | 'new-folder' | null>(null)
  const locked = selecting || create.isPending || attempt.current.unresolved || selectionUnconfirmed
  const query = useHarnessDirectories(location, open && !disabled)
  const data = query.data
  const currentPath = data?.path ?? location.path
  const destination = selectedPath ?? (locationsOpen ? undefined : currentPath)
  const canBrowse = !locked && !disabled && !query.isFetching && !query.isError
  const destinationAllowed = Boolean(destination && data?.roots.some((root) =>
    destination === root.path || destination.startsWith(root.path.replace(/\/$/, '') + '/')))
  const canSelect = !selecting && !create.isPending && !attempt.current.unresolved && !disabled && !creating
    && destinationAllowed && (selectionUnconfirmed || (!query.isFetching && !query.isError))

  useEffect(() => { if (open && creating && !locked) nameRef.current?.focus() }, [open, creating, error, locked])
  useEffect(() => {
    // Deliberate navigation restores focus; background refreshes do not.
    if (!open || creating || !pendingFocus.current) return
    if (pendingFocus.current === 'new-folder' && newFolderRef.current?.disabled) return
    const target = pendingFocus.current === 'new-folder' ? newFolderRef.current : pathRef.current
    if (target) { target.focus(); pendingFocus.current = null }
  }, [open, creating, location, locationsOpen, data?.path, query.isFetching, query.isError])

  const openPicker = () => {
    pendingFocus.current = 'path'
    setHistory([]); setLocation({}); setLocationsOpen(true); setSelectedPath(value || undefined)
    setCreating(false); setName(''); setError(undefined); setSelectionError(undefined); setOpen(true)
  }
  const navigateFolder = (next: Location, showLocations = false) => {
    pendingFocus.current = 'path'
    setHistory((previous) => [...previous, {
      location: { ...location, rootId: data?.rootId ?? location.rootId, path: data?.path ?? location.path },
      selectedPath, locationsOpen,
    }])
    setLocation(next); setLocationsOpen(showLocations); setSelectedPath(undefined); setSelectionError(undefined)
  }
  const goBack = () => {
    if (creating) { pendingFocus.current = 'new-folder'; setCreating(false); setError(undefined); return }
    pendingFocus.current = 'path'
    const previous = history.at(-1)
    if (previous) {
      setLocation(previous.location); setLocationsOpen(previous.locationsOpen); setSelectedPath(previous.locationsOpen ? previous.selectedPath : undefined)
      setHistory((items) => items.slice(0, -1))
    } else {
      setLocation(data?.parent && data.rootId ? { rootId: data.rootId, path: data.parent } : { rootId: location.rootId })
      setLocationsOpen(false); setSelectedPath(undefined)
    }
    setSelectionError(undefined)
  }
  const selectPath = async (path: string) => {
    setSelectedPath(path); setSelecting(true); setSelectionError(undefined)
    try { await onSelect(path); setOpen(false) }
    catch (failure) { setSelectionError(failure instanceof Error ? failure.message : 'The location could not be saved.') }
    finally { setSelecting(false) }
  }
  const createFolder = async () => {
    if (inFlight.current || disabled || !creating || query.isFetching || query.isError || !data?.path) return
    const validName = WorkspaceFolderCreateInputSchema.shape.name.safeParse(name)
    if (!validName.success) { setError(validName.error.issues[0]?.message ?? 'Enter a folder name.'); nameRef.current?.focus(); return }
    inFlight.current = true
    setError(undefined)
    try {
      const result = await create.mutateAsync(attempt.current.input({ parentPath: data.path, name: name.trim() }))
      attempt.current.succeeded()
      // A created folder is selected, not opened. A failed save retries this path,
      // not the creation request or whichever directory is currently displayed.
      setSelectedPath(result.value.path); setCreating(false); setName('')
      await selectPath(result.value.path)
    } catch (failure) {
      attempt.current.failed(failure)
      setError(failure instanceof Error ? failure.message : 'The folder could not be created.')
      nameRef.current?.focus()
    } finally { inFlight.current = false }
  }
  const entries = locationsOpen
    ? data?.roots.map((root) => ({ name: root.label, path: root.path, rootId: root.id }))
    : data?.directories.map((entry) => ({ ...entry, rootId: data?.rootId }))

  return <>
    {value !== undefined ? <div className="workspace-folder-field">
      <label id={id}>{label}</label>
      <div className="workspace-folder-control">
      <button type="button" className="workspace-folder-trigger" aria-labelledby={id} aria-describedby={id + '-path'} aria-haspopup="dialog"
        disabled={disabled} onClick={openPicker}>
        <span id={id + '-path'} dir="ltr" className={value ? undefined : 'n-muted'}>{value || 'Choose a folder'}</span><Icon name="folder" size={16} />
      </button>
      {copyValue !== undefined ? <IconButton label="Copy folder path" variant="ghost" disabled={!copyValue}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(copyValue)
            toasts?.notify({ tone: 'success', title: 'Folder path copied' })
          } catch {
            toasts?.notify({ tone: 'danger', title: 'Could not copy the folder path' })
          }
        }}><Icon name="copy" size={16} /></IconButton> : null}
      </div>
    </div> : <Button leading={<Icon name="folder" size={16} />} disabled={disabled} onClick={openPicker}>Choose folder</Button>}
    <Dialog open={open} onOpenChange={(next) => { if (!locked) setOpen(next) }} busy={locked} title={creating ? 'New folder' : 'Choose folder'}
      className="workspace-folder-dialog"
      headerLeading={<Button variant="ghost" leading={<Icon name="arrow" size={16} style={{ transform: 'rotate(180deg)' }} />}
        disabled={locked || disabled || query.isFetching || (!creating && !history.length && !data?.parent && !(query.isError && location.path))}
        onClick={goBack}>Back</Button>}
      footer={<>
        <div className="workspace-folder-confirm">
          <Button variant="ghost" disabled={locked} onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={selecting || create.isPending}
            disabled={creating ? disabled || query.isFetching || query.isError || !data?.path || !name.trim() : !canSelect}
            onClick={async () => {
              if (creating) { await createFolder(); return }
              if (!canSelect || !destination || inFlight.current) return
              inFlight.current = true
              try { await selectPath(destination) } finally { inFlight.current = false }
            }}>{selecting ? 'Saving…' : create.isPending ? 'Creating…' : creating ? 'Create and select' : 'Select folder'}</Button>
        </div>
      </>}>
      <div className="workspace-folder-browser">
        {selectionError ? <Alert tone="danger" live title={selectionError}>
          {selectionUnconfirmed ? 'Saving could not be confirmed. Retry Select folder to resolve the same request.' : null}
        </Alert> : null}
        <div className="workspace-folder-destination">
          <TextField ref={pathRef} label="Destination" value={destination ?? ''} placeholder="Choose a location" readOnly />
        </div>
        {!creating ? <div className="workspace-folder-toolbar">
          {data && data.roots.length > 1 && !locationsOpen
            ? <Button variant="ghost" disabled={!canBrowse} onClick={() => navigateFolder(location, true)}>Locations</Button>
            : <h3 id={id + '-folders'}>{locationsOpen ? 'Locations' : 'Folders'}</h3>}
          {!locationsOpen && data?.path ? <Button ref={newFolderRef} variant="ghost" disabled={!canBrowse}
            onClick={() => { setName(''); setError(undefined); setCreating(true) }}>New folder</Button> : null}
        </div> : null}
        {data?.path && creating ? <div className="workspace-folder-create">
          <TextField ref={nameRef} label="Folder name" value={name} error={error} disabled={locked || disabled}
            autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="done"
            hint={name.trim() ? `${data.path.replace(/\/$/, '')}/${name.trim()}` : undefined}
            onChange={(event) => { setName(event.target.value); setError(undefined) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void createFolder() }
              if (event.key === 'Escape' && !locked) { event.preventDefault(); event.stopPropagation(); goBack() }
            }} />
          {attempt.current.unresolved && !create.isPending ? <p className="n-field-hint" role="status">Creation could not be confirmed. Retry with the same name.</p> : null}
        </div> : null}
        {!creating && (query.isFetching ? <LoadingState label="Loading folders…" /> : query.isError
          ? <Alert tone="danger" live title={query.error.message}
              action={<Button disabled={locked || disabled} onClick={() => void query.refetch()}>Retry</Button>} />
          : data?.roots.length === 0
            ? <p className="workspace-folder-empty" role="status">No folders are available to browse.</p>
            : null)}
        <p className="n-sr-only" id={id + '-help'}>Click or press Space to select. Double-click or use the Open button to browse. Select folder confirms the destination.</p>
        {!creating && !query.isError && !query.isFetching && Boolean(entries?.length) ? <ul className="workspace-folder-entries" aria-label={locationsOpen ? 'Locations' : 'Folders'}>
          {entries?.map((entry) => <li key={entry.path} className="workspace-folder-entry" data-selected={selectedPath === entry.path}>
            <Button className="workspace-folder-select" disabled={!canBrowse} variant="ghost"
              aria-pressed={selectedPath === entry.path} aria-describedby={id + '-help'} leading={<Icon name="folder" size={16} />}
              trailing={selectedPath === entry.path ? <Icon name="check" size={16} /> : undefined}
              onClick={() => { setSelectedPath(entry.path); setSelectionError(undefined) }}
              onDoubleClick={() => { if (canBrowse && entry.rootId) navigateFolder({ rootId: entry.rootId, path: entry.path }) }}>
              {entry.name}
            </Button>
            <IconButton label={`Open ${entry.name}`} variant="ghost" disabled={!canBrowse || !entry.rootId}
              onClick={() => { if (entry.rootId) navigateFolder({ rootId: entry.rootId, path: entry.path }) }}>
              <Icon name="chevron" size={16} />
            </IconButton>
          </li>)}
        </ul> : null}
        {!creating && !locationsOpen && data?.nextCursor && !query.isError ? <Button className="workspace-folder-next" variant="ghost"
          disabled={!canBrowse} onClick={() => navigateFolder({ rootId: data.rootId ?? undefined, path: data.path ?? undefined, cursor: data.nextCursor! })}>
          Next folders
        </Button> : null}
      </div>
    </Dialog>
  </>
}

export function WorkspaceFolderPicker(props: Props) {
  const epoch = useHarnessSessionEpoch()
  return <FolderPicker key={epoch} {...props} />
}
