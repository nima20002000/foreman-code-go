import { useState } from 'react'
import { Cloud } from 'lucide-react'
import type { ComputerAccount } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useDriveConnection } from '../../shared/api/computerDrive'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog, LoadingState, Textarea } from '../../shared/ui/nocturne'
import { useComputerUi } from './computerUiStore'

/** Connect and manage the Google Drive mount on one computer. */
export function DriveConnectDialog({ target, name, account }: {
  target: DeviceProvisioningTarget; name: string; account: ComputerAccount | undefined
}) {
  const key = useComputerUi(state => state.drive)
  const close = useComputerUi(state => state.closeDrive)
  const open = key?.session === sessionGeneration() && key.key === `${target.hostRef.mainId}:${target.hostRef.kind === 'main' ? 'main' : target.hostRef.deviceId}`
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }} title={`Google Drive on ${name}`}
    headerLeading={<Cloud size={20} aria-hidden="true" />} size="sm">
    {open && <DriveConnectBody account={account} target={target} onCancel={close} />}
  </Dialog>
}

function DriveConnectBody({ target, account, onCancel }: {
  target: DeviceProvisioningTarget; account: ComputerAccount | undefined; onCancel: () => void
}) {
  const { start, complete, disconnect, cancel, status, terminalStatus, current } = useDriveConnection(target)
  const [token, setToken] = useState('')
  let connected = account?.signedIn ? account.account ?? 'Google Drive' : null
  if (current?.state === 'connected') connected = current.account ?? 'Google Drive'
  if (current?.state === 'waiting') connected = current.account
  if (current?.state === 'disconnected') connected = null
  const error = start.error ?? complete.error ?? disconnect.error ?? cancel.error ?? status.error
  let startLabel = connected ? 'Switch account' : 'Connect Google Drive'
  if (current?.state === 'failed') startLabel = 'Start again'
  const busy = start.isPending || complete.isPending || cancel.isPending
  const restart = () => {
    setToken('')
    start.mutate()
  }
  return <div className="github-sign-in">
    {error && <Alert tone="danger" title={error.message} />}
    {status.isError && !terminalStatus && <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>Retry status</Button>}
    {!error && current && ['failed', 'expired', 'cancelled'].includes(current.state)
      && <Alert tone="warning" title={current.message ?? 'Sign-in did not finish. Start again.'} />}
    {start.isPending && <LoadingState label="Preparing Google sign-in (installs rclone if needed)…" />}
    {(complete.isPending || current?.state === 'connecting') && <LoadingState label="Mounting Google Drive…" />}
    {current?.state === 'waiting' && !busy && <>
      <p>On a computer with <a href="https://rclone.org/install/" target="_blank" rel="noreferrer">rclone installed</a>
        {' '}and a browser, run this command and finish Google sign-in.
        This can be a different computer from Main.</p>
      <code className="github-code">{current.authorizationCommand}</code>
      <p>Paste the result printed between the paste markers. It is sent only to the selected computer.</p>
      <Textarea label="Authorization result" id="drive-authorization" autoComplete="off" value={token}
        onChange={event => setToken(event.target.value)} rows={3} />
      <Button variant="primary" disabled={!token.trim()} onClick={() => {
        complete.mutate(token.trim())
        setToken('')
      }}>Finish connecting</Button>
      <Button size="sm" variant="ghost" onClick={restart}>Start again</Button>
    </>}
    {loginCanCancel(current?.state) && <Button size="sm" variant="ghost" disabled={cancel.isPending}
      onClick={() => {
        setToken('')
        if (terminalStatus) onCancel()
        else cancel.mutate(onCancel)
      }}>Cancel sign-in</Button>}
    {connected && <p>Connected as <strong>{connected}</strong>
      {current?.mountPath ? <> at <code>{current.mountPath}</code></> : null}</p>}
    {current?.state !== 'waiting' && <Button size="sm" variant="primary" disabled={busy} onClick={restart}>
      {startLabel}
    </Button>}
    {(connected || current?.state === 'waiting' || current?.state === 'connecting')
      && <Button size="sm" variant="ghost" disabled={start.isPending || disconnect.isPending}
        onClick={() => { setToken(''); disconnect.mutate() }}>Disconnect</Button>}
  </div>
}

function loginCanCancel(state: string | undefined): boolean {
  return state !== undefined && ['waiting', 'connecting', 'failed', 'expired'].includes(state)
}
