import { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useComputerSync } from '../../shared/api/computerSync'
import { computerKey } from '../../shared/api/computerActivity'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog, LoadingState, Switch } from '../../shared/ui/nocturne'
import { useComputerUi } from './computerUiStore'

export function ComputerSyncControls({ target, name }: { target: DeviceProvisioningTarget; name: string }) {
  const { status, update, change, retry, uncertain, refresh } = useComputerSync(target)
  const selected = useComputerUi(state => state.sync)
  const openSync = useComputerUi(state => state.openSync)
  const close = useComputerUi(state => state.closeSync)
  const key = computerKey(target)
  useEffect(() => () => {
    const ui = useComputerUi.getState()
    if (ui.sync?.key === key) ui.closeSync()
  }, [key])
  const open = selected?.session === sessionGeneration() && selected.key === computerKey(target)
  const folders = status.data?.folders.filter(folder => folder.participating && folder.enabled) ?? []
  let summary = 'Sync unavailable'
  if (status.isPending) summary = 'Loading sync…'
  if (status.data && !status.isError) {
    summary = 'Sync not running'
    if (status.data.message) summary = 'Sync unavailable'
    else if (!status.data.installed) summary = 'Sync not installed'
    else if (status.data.running) {
      summary = folders.some(folder => folder.status?.connected) ? 'Sync connected' : 'Sync disconnected'
      if (folders.some(folder => folder.status?.state === 'syncing')) summary += ' · syncing'
      if (folders.some(folder => folder.status?.state === 'error')) summary += ' · error'
      const conflicts = folders.reduce((count, folder) => count + (folder.status?.conflicts.length ?? 0), 0)
      if (conflicts) summary += ` · ${conflicts} conflicts`
    }
  }
  return <>
    <Button size="sm" variant="ghost" aria-label={`${summary}. Manage shared files on ${name}`}
      onClick={() => openSync(computerKey(target))}><RefreshCw size={13} aria-hidden="true" />{summary}</Button>
    <Dialog open={open} title={`Shared files on ${name}`} size="md"
      dismissible={!update.isPending} onOpenChange={value => { if (!value) close() }}>
      <p>Syncthing shares local workspace folders over Tailscale. Main connects the computers.
        Turning sync off keeps local files. Turning it off on Main stops sharing that workspace.</p>
      {status.isPending && <LoadingState label="Reading sync status…" />}
      {status.isError && <Alert tone="danger" title={status.error.message} />}
      {status.data?.message && <Alert tone="warning" title={status.data.message} />}
      <Button size="sm" disabled={status.isFetching || update.isPending} onClick={() => void refresh()}>Refresh sync status</Button>
      {update.isError && <Alert tone="danger" title={update.error.message}>
        {uncertain && <Button size="sm" disabled={update.isPending} onClick={retry}>Retry sync save</Button>}
      </Alert>}
      {status.data?.folders.map(folder => <section key={folder.workspaceId} className="computer-sync-folder"
        aria-label={`Shared files for ${folder.name}`}>
        <Switch label={`Sync ${folder.name}`} checked={folder.enabled}
          disabled={update.isPending || update.isError || status.isError}
          onChange={event => change(folder.workspaceId, event.target.checked, folder.revision)} />
        {!folder.participating && <p>Sync starts when an Agent from this workspace runs on this computer.</p>}
        {folder.status && <>
          <p>{folder.status.connected ? 'Connected' : 'Disconnected'} · {folder.status.state}</p>
          <code className="computer-sync-path">{folder.status.path}</code>
          {folder.status.message && <Alert tone="danger" title={folder.status.message} />}
          {folder.status.conflicts.length > 0 && <div><p>Conflicting copies need your review:</p>
            <ul>{folder.status.conflicts.map(file => <li key={file}>{file}</li>)}</ul></div>}
        </>}
      </section>)}
      {status.data && !status.data.folders.length && <p>Create a workspace to share files.</p>}
    </Dialog>
  </>
}
