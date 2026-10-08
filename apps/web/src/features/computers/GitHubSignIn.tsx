import { useState } from 'react'
import { Copy, ExternalLink, GitBranch } from 'lucide-react'
import type { ComputerAccount } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useGitHubLogin } from '../../shared/api/computerGitHub'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog, LoadingState, TextField } from '../../shared/ui/nocturne'
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
  const { start, logout, setup, status, current } = useGitHubLogin(target)
  let signedIn = account?.signedIn ? account.account : null
  if (current?.state === 'signed-out') signedIn = null
  if (current && ['signed-in', 'git-setup-failed'].includes(current.state)) signedIn = current.account
  if (account && !account.installed) return <Alert tone="warning" title="Install the GitHub CLI (gh) on this computer first." />
  if (start.isPending) return <LoadingState label="Asking GitHub for a code…" />
  if (status.isError) return <div className="github-sign-in">
    <Alert tone="danger" title={status.error.message} />
    <div className="github-actions">
      <Button onClick={() => void status.refetch()} disabled={status.isFetching}>Retry status</Button>
      <Button onClick={() => start.mutate()}>Start again</Button>
    </div>
  </div>
  if (current?.state === 'waiting' && current.code) return <div className="github-sign-in">
    <p>Enter this code at GitHub:</p>
    <GitHubCode key={current.code} code={current.code} />
    <a className="github-link" href={current.verificationUrl ?? 'https://github.com/login/device'} target="_blank" rel="noreferrer">
      Open github.com/login/device <ExternalLink size={13} aria-hidden="true" /></a>
    <LoadingState label="Waiting for GitHub…" />
  </div>
  if (current?.state === 'waiting') return <LoadingState label="Finishing GitHub sign-in…" />
  return <div className="github-sign-in">
    {(start.isError || logout.isError || setup.isError) && <Alert tone="danger" title={start.error?.message ?? logout.error?.message ?? setup.error?.message ?? 'GitHub could not finish. Try again.'} />}
    {current && ['failed', 'expired'].includes(current.state) && <Alert tone="warning" title={current.message ?? 'Sign-in did not finish.'} />}
    {current?.state === 'git-setup-failed' && <>
      <Alert tone="warning" title={current.message ?? 'Signed in, but Git setup failed.'} />
      <Button disabled={setup.isPending} onClick={() => setup.mutate()}>Retry Git setup</Button>
    </>}
    {signedIn ? <>
      <p>Signed in as <strong>{signedIn}</strong></p>
      {current?.state === 'signed-in' && current.message && <p role="status">{current.message}</p>}
      <div className="github-actions">
        <Button size="sm" disabled={logout.isPending || setup.isPending} onClick={() => start.mutate()}>Switch account</Button>
        <Button size="sm" variant="ghost" disabled={logout.isPending || setup.isPending} onClick={() => logout.mutate()}>Sign out</Button>
      </div>
    </> : <Button variant="primary" onClick={() => start.mutate()}>
      {current && ['failed', 'expired'].includes(current.state) ? 'Start again' : 'Connect GitHub'}
    </Button>}
  </div>
}


function GitHubCode({ code }: { code: string }) {
  const [copied, setCopied] = useState<'done' | 'blocked'>()
  const copy = async () => {
    try {
      if (!navigator.clipboard) {
        setCopied('blocked')
        return
      }
      await navigator.clipboard.writeText(code)
      setCopied('done')
    } catch { setCopied('blocked') }
  }
  return <>
    <div className="github-code"><strong aria-label="One-time code">{code}</strong>
      <Button size="sm" variant="ghost" onClick={() => void copy()}>
        <Copy size={14} aria-hidden="true" /> Copy</Button></div>
    {copied && <p role="status">{copied === 'done' ? 'Copied. Paste it into GitHub.'
      : 'Copy was blocked. Select the code and copy it manually.'}</p>}
    {copied === 'blocked' && <TextField label="Code to copy manually" readOnly value={code}
      onFocus={event => event.currentTarget.select()} />}
  </>
}
