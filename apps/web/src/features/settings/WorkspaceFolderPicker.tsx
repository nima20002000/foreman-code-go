import { useEffect, useId, useRef, useState } from 'react'
import { useCreateWorkspaceFolder, useHarnessDirectories, useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { WorkspaceFolderCreateInputSchema } from '@graphql/contracts/management'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { Button, Dialog, Icon, LoadingState, Select, TextField } from '../../shared/ui/nocturne'
import './workspaceLocation.css'

type Props = { disabled: boolean; onSelect(path: string): void | Promise<void>; value?: string; label?: string }

function FolderPicker({ disabled, onSelect, value, label = 'Project folder' }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const [selecting, setSelecting] = useState(false)
  const [selectionError, setSelectionError] = useState<string>()
  const create = useCreateWorkspaceFolder()
  const attempt = useRef(new CommandAttempt<{ parentPath: string; name: string }>())
  const inFlight = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const newFolderRef = useRef<HTMLButtonElement>(null)
  const locked = selecting || create.isPending || attempt.current.unresolved
  useEffect(() => { if (creating && !locked) nameRef.current?.focus() }, [creating, error, locked])
  const [location, setLocation] = useState<Parameters<typeof useHarnessDirectories>[0]>({})
  const [history, setHistory] = useState<Array<Parameters<typeof useHarnessDirectories>[0]>>([])
  const query = useHarnessDirectories(location, open && !disabled)
  const data = query.data
  const pathRef = useRef<HTMLSpanElement>(null)
  const initialPath = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!open || !initialPath.current || !data || query.isFetching || query.isError) return
    const path = initialPath.current
    initialPath.current = undefined
    const root = [...data.roots].sort((a, b) => b.path.length - a.path.length)
      .find((item) => path === item.path || path.startsWith(item.path.replace(/\/$/, '') + '/'))
    if (root && data.path !== path) setLocation({ rootId: root.id, path })
  }, [open, data, query.isFetching, query.isError])
  useEffect(() => {
    if (open && !creating) pathRef.current?.focus()
  }, [open, creating, location, data?.path, query.isFetching, query.isError])
  const canSelect = !locked && !creating && !disabled && !query.isFetching && !query.isError && Boolean(data?.path)

  const openPicker = () => { initialPath.current = value; setHistory([]); setLocation({}); setCreating(false); setName(''); setError(undefined); setSelectionError(undefined); setOpen(true) }
  const navigateFolder = (next: Parameters<typeof useHarnessDirectories>[0]) => {
    setHistory((previous) => [...previous, { ...location, rootId: data?.rootId ?? location.rootId, path: data?.path ?? location.path }])
    setLocation(next); setSelectionError(undefined)
  }
  const goBack = () => {
    if (creating) { setCreating(false); setError(undefined); return }
    const previous = history.at(-1)
    if (previous) { setLocation(previous); setHistory((items) => items.slice(0, -1)) }
    else if (data?.parent && data.rootId) setLocation({ rootId: data.rootId, path: data.parent })
    else setLocation({ rootId: location.rootId })
    setSelectionError(undefined)
  }
  const selectPath = async (path: string) => {
    setSelecting(true); setSelectionError(undefined)
    try { await onSelect(path); setOpen(false) }
    catch (failure) { setSelectionError(failure instanceof Error ? failure.message : 'The location could not be saved.') }
    finally { setSelecting(false) }
  }
  const createFolder = async () => {
    if (inFlight.current || !data?.path) return
    const validName = WorkspaceFolderCreateInputSchema.shape.name.safeParse(name)
    if (!validName.success) { setError(validName.error.issues[0]?.message ?? 'Enter a folder name.'); nameRef.current?.focus(); return }
    inFlight.current = true
    setError(undefined)
    try {
      const result = await create.mutateAsync(attempt.current.input({ parentPath: data.path, name: name.trim() }))
      attempt.current.succeeded()
      navigateFolder({ rootId: data.rootId ?? undefined, path: result.value.path })
      setCreating(false); setName('')
      await selectPath(result.value.path)
    } catch (failure) {
      attempt.current.failed(failure)
      setError(failure instanceof Error ? failure.message : 'The folder could not be created.')
      nameRef.current?.focus()
    } finally { inFlight.current = false }
  }

  return <>
    {value !== undefined ? <div className="workspace-folder-field">
      <label id={id}>{label}</label>
      <button type="button" className="workspace-folder-trigger" aria-labelledby={id} aria-describedby={id + '-path'} aria-haspopup="dialog"
        disabled={disabled} onClick={openPicker}>
        <span id={id + '-path'} className={value ? undefined : 'n-muted'}>{value || 'Choose a folder'}</span><Icon name="folder" />
      </button>
    </div> : <Button leading={<Icon name="folder" />} disabled={disabled} onClick={openPicker}>Choose folder</Button>}
    <Dialog open={open} onOpenChange={(next) => { if (!locked) setOpen(next) }} busy={locked} title={creating ? "New folder" : "Choose folder"}
      className="workspace-folder-dialog"
      headerLeading={<Button variant="ghost" size="sm" leading={<Icon name="arrow" style={{ transform: 'rotate(180deg)' }} />}
        disabled={locked || query.isFetching || (!creating && !history.length && !data?.parent && !(query.isError && location.path))}
        onClick={goBack}>Back</Button>}
      footer={<><Button disabled={locked} onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary"
          disabled={creating ? create.isPending || selecting || query.isFetching || !name.trim() : !canSelect}
          onClick={async () => {
            if (creating) { await createFolder(); return }
            if (!canSelect || !data?.path || inFlight.current) return
            inFlight.current = true
            try { await selectPath(data.path) } finally { inFlight.current = false }
          }}>{selecting ? 'Saving…' : create.isPending ? 'Creating…' : creating ? 'Create and use' : 'Use this folder'}</Button></>}>
      <div className="workspace-folder-browser">
        {selectionError ? <p role="alert">{selectionError}</p> : null}
        {!creating && data && data.roots.length > 1 ? <Select label="Location" value={data.rootId ?? ''}
          disabled={query.isFetching || locked || creating} options={data.roots.map((root) => ({ value: root.id, label: root.path }))}
          onChange={(event) => navigateFolder({ rootId: event.target.value })} /> : null}
        {data?.path || history.length || location.path ? <div className="workspace-folder-current-row">
          <span ref={pathRef} tabIndex={-1} className="workspace-folder-current">
            <strong>{(data?.path ?? location.path)?.split('/').filter(Boolean).at(-1) ?? '/'}</strong>
            <span>{data?.path ?? location.path}</span>
          </span>
          {!creating && data?.path ? <Button ref={newFolderRef} size="sm" variant="ghost"
            disabled={query.isError || query.isFetching || locked} leading={<Icon name="plus" />}
            onClick={() => { setName(''); setError(undefined); setCreating(true) }}>New folder</Button> : null}
        </div> : null}
        {data?.path ? creating ? <div className="workspace-folder-create">
          <TextField ref={nameRef} label="Folder name" value={name} error={error} disabled={locked}
            onChange={(event) => { setName(event.target.value); setError(undefined) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void createFolder() }
              if (event.key === 'Escape' && !locked) { event.preventDefault(); event.stopPropagation(); setCreating(false); newFolderRef.current?.focus() }
            }} />
          {attempt.current.unresolved && !create.isPending ? <p role="status">Creation could not be confirmed. Retry with the same name.</p> : null}
        </div> : null : null}
        {!creating && (query.isFetching ? <LoadingState label="Loading folders…" /> : query.isError
          ? <div role="alert"><p>{query.error.message}</p><Button onClick={() => void query.refetch()}>Retry</Button></div>
          : data?.roots.length === 0
            ? <p>No folders are available to browse.</p>
            : data?.directories.length === 0 ? <p>No subfolders.</p> : null)}
        {!creating && !query.isError && !query.isFetching ? <div className="workspace-folder-entries">
          {data?.directories.map((entry) => <Button key={entry.path} disabled={locked || creating} variant="ghost" leading={<Icon name="folder" />} trailing={<span aria-hidden="true">›</span>}
            onClick={() => { if (data.rootId) navigateFolder({ rootId: data.rootId, path: entry.path }) }}>
            {entry.name}
          </Button>)}
        </div> : null}
        {!creating && data?.nextCursor && !query.isError ? <Button disabled={query.isFetching || locked || creating} onClick={() => {
          navigateFolder({ rootId: data.rootId ?? undefined, path: data.path ?? undefined, cursor: data.nextCursor! })
        }}>Next folders</Button> : null}
      </div>
    </Dialog>
  </>
}

export function WorkspaceFolderPicker(props: Props) {
  const epoch = useHarnessSessionEpoch()
  return <FolderPicker key={epoch} {...props} />
}
