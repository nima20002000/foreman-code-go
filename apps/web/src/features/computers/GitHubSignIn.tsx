import { Copy, ExternalLink, GitBranch } from 'lucide-react'
import type { ComputerAccount } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useGitHubLogin } from '../../shared/api/computerGitHub'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog, LoadingState } from '../../shared/ui/nocturne'
import { useComputerUi } from './computerUiStore'

/** GitHub sign-in for one computer: a one-time code to enter at github.com, then the signed-in account. */
export function GitHubSignInDialog({ target, name, account }: {
  target: DeviceProvisioningTarget; name: string; account: ComputerAccount | undefined
}) {
  const key = useComputerUi(state => state.github)
  const close = useComputerUi(state => state.closeGitHub)
  const open = key?.session === sessionGeneration() && key.key === `${target.hostRef.mainId}:${target.hostRef.kind === 'main' ? 'main' : target.hostRef.deviceId}`
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }} title={`GitHub on ${name}`}
    headerLeading={<GitBranch size={20} aria-hidden="true" />} size="sm">
    {open && <GitHubSignInBody target={target} account={account} />}
  </Dialog>
}

function GitHubSignInBody({ target, account }: { target: DeviceProvisioningTarget; account: ComputerAccount | undefined }) {
  const { start, logout, current } = useGitHubLogin(target)
  const signedIn = current?.state === 'signed-in' ? current.account : current?.state === 'signed-out' ? null
    : account?.signedIn ? account.account : null
  if (account && !account.installed) return <Alert tone="warning" title="Install the GitHub CLI (gh) on this computer first." />
  if (start.isPending) return <LoadingState label="Asking GitHub for a code…" />
  if (current?.state === 'waiting' && current.code) return <div className="github-sign-in">
    <p>Enter this code at GitHub:</p>
    <div className="github-code"><strong aria-label="One-time code">{current.code}</strong>
      <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(current.code!)}>
        <Copy size={14} aria-hidden="true" /> Copy</Button></div>
    <a className="github-link" href={current.verificationUrl ?? 'https://github.com/login/device'} target="_blank" rel="noreferrer">
      Open github.com/login/device <ExternalLink size={13} aria-hidden="true" /></a>
    <LoadingState label="Waiting for GitHub…" />
  </div>
  return <div className="github-sign-in">
    {(start.isError || logout.isError) && <Alert tone="danger" title="GitHub could not finish. Try again." />}
    {current && ['failed', 'expired'].includes(current.state) && <Alert tone="warning" title={current.message ?? 'Sign-in did not finish.'} />}
    {signedIn ? <>
      <p>Signed in as <strong>{signedIn}</strong></p>
      <div className="github-actions">
        <Button size="sm" onClick={() => start.mutate()}>Switch account</Button>
        <Button size="sm" variant="ghost" disabled={logout.isPending} onClick={() => logout.mutate()}>Sign out</Button>
      </div>
    </> : <Button variant="primary" onClick={() => start.mutate()}>Connect GitHub</Button>}
  </div>
}
