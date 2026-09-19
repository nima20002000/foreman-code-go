import { useEffect, useRef, useState } from 'react'
import { useHarnessDirectories, useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { Button, Dialog, Icon, LoadingState, Select } from '../../shared/ui/nocturne'
import './workspaceLocation.css'

type Props = { disabled: boolean; onSelect(path: string): void }

function FolderPicker({ disabled, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const [location, setLocation] = useState<Parameters<typeof useHarnessDirectories>[0]>({})
  const query = useHarnessDirectories(location, open && !disabled)
  const data = query.data
  const pathRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (open && !query.isFetching && !query.isError) pathRef.current?.focus()
  }, [open, data?.path, query.isFetching, query.isError])
  const canSelect = !disabled && !query.isFetching && !query.isError && Boolean(data?.path)

  return <>
    <Button leading={<Icon name="folder" />} disabled={disabled} onClick={() => { setLocation({}); setOpen(true) }}>
      Choose folder
    </Button>
    <Dialog open={open && !disabled} onOpenChange={setOpen} title="Choose workspace folder"
      description="Folders on Local Runner."
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" disabled={!canSelect} onClick={() => {
          if (canSelect && data?.path) { onSelect(data.path); setOpen(false) }
        }}>Use this folder</Button></>}>
      <div className="workspace-folder-browser">
        {data?.roots.length ? <Select label="Location" value={data.rootId ?? ''}
          disabled={query.isFetching} options={data.roots.map((root) => ({ value: root.id, label: root.path }))}
          onChange={(event) => setLocation({ rootId: event.target.value })} /> : null}
        {data?.path ? <div className="workspace-folder-path">
          <Button size="sm" disabled={!data.parent || query.isFetching} onClick={() => {
            if (data.parent && data.rootId) setLocation({ rootId: data.rootId, path: data.parent })
          }}>Up one folder</Button><span ref={pathRef} tabIndex={-1}>{data.path}</span>
        </div> : null}
        {query.isFetching ? <LoadingState label="Loading folders…" /> : query.isError
          ? <div role="alert"><p>{query.error.message}</p><Button onClick={() => void query.refetch()}>Retry</Button></div>
          : data?.roots.length === 0
            ? <p>No folders are available to browse. You can enter a folder path in workspace settings.</p>
            : data?.directories.length === 0 ? <p>No subfolders. You can use this folder.</p> : null}
        {!query.isError && !query.isFetching ? <div className="workspace-folder-entries">
          {data?.directories.map((entry) => <Button key={entry.path} variant="ghost" leading={<Icon name="folder" />} trailing={<span aria-hidden="true">›</span>}
            onClick={() => { if (data.rootId) setLocation({ rootId: data.rootId, path: entry.path }) }}>
            {entry.name}
          </Button>)}
        </div> : null}
        {data?.nextCursor && !query.isError ? <Button disabled={query.isFetching} onClick={() => {
          setLocation({ rootId: data.rootId ?? undefined, path: data.path ?? undefined, cursor: data.nextCursor! })
        }}>Next folders</Button> : null}
      </div>
    </Dialog>
  </>
}

export function WorkspaceFolderPicker(props: Props) {
  const epoch = useHarnessSessionEpoch()
  return <FolderPicker key={epoch} {...props} />
}
