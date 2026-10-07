import { Cloud, ExternalLink } from 'lucide-react'
import type { ComputerAccount } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useDriveConnection } from '../../shared/api/computerDrive'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog, LoadingState } from '../../shared/ui/nocturne'
import { useComputerUi } from './computerUiStore'

/** Google Drive for one computer: sign in to Google in this browser, then Drive mounts on that computer. */
export function DriveConnectDialog({ target, name, account }: {
  target: DeviceProvisioningTarget; name: string; account: ComputerAccount | undefined
}) {
  const key = useComputerUi(state => state.drive)
  const close = useComputerUi(state => state.closeDrive)
  const open = key?.session === sessionGeneration() && key.key === `${target.hostRef.mainId}:${target.hostRef.kind === 'main' ? 'main' : target.hostRef.deviceId}`
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }} title={`Google Drive on ${name}`}
    headerLeading={<Cloud size={20} aria-hidden="true" />} size="sm">
    {open && <DriveConnectBody account={account} target={target} />}
  </Dialog>
}

function DriveConnectBody({ target, account }: { target: DeviceProvisioningTarget; account: ComputerAccount | undefined }) {
  const { start, disconnect, current } = useDriveConnection(target)
  const connected = current?.state === 'connected' ? current.account ?? 'Google Drive'
    : current?.state === 'disconnected' ? null : account?.signedIn ? account.account ?? 'Google Drive' : null
  if (start.isPending) return <LoadingState label="Preparing Google sign-in (installs rclone if needed)…" />
  if (current?.state === 'waiting' && current.authorizationUrl) return <div className="github-sign-in">
    <p>Sign in to Google in this browser. Drive then mounts on the computer.</p>
    <a className="github-link" href={current.authorizationUrl} target="_blank" rel="noreferrer">
      Open Google sign-in <ExternalLink size={13} aria-hidden="true" /></a>
    <LoadingState label="Waiting for Google…" />
  </div>
  if (current?.state === 'connecting') return <LoadingState label="Mounting Google Drive…" />
  return <div className="github-sign-in">
    {(start.isError || disconnect.isError) && <Alert tone="danger" title={(start.error ?? disconnect.error)?.message ?? 'Google Drive could not finish.'} />}
    {current && ['failed', 'expired'].includes(current.state) && <Alert tone="warning" title={current.message ?? 'Sign-in did not finish.'} />}
    {connected ? <>
      <p>Connected as <strong>{connected}</strong>{current?.mountPath ? <> at <code>{current.mountPath}</code></> : null}</p>
      <div className="github-actions">
        <Button size="sm" onClick={() => start.mutate()}>Switch account</Button>
        <Button size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button>
      </div>
    </> : <Button variant="primary" onClick={() => start.mutate()}>Connect Google Drive</Button>}
  </div>
}
