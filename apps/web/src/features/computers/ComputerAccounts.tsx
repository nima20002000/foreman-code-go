import { useEffect } from 'react'
import { Bot, Cloud, CodeXml, GitBranch, Sparkles } from 'lucide-react'
import type { ComputerAccount, ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { computerKey } from '../../shared/api/computerActivity'
import { Button } from '../../shared/ui/nocturne'
import { GitHubSignInDialog } from './GitHubSignIn'
import { DriveConnectDialog } from './DriveConnect'
import { useComputerUi } from './computerUiStore'

const TOOLS: Record<ComputerAccount['tool'], { label: string; icon: React.ReactNode }> = {
  codex: { label: 'Codex', icon: <CodeXml size={13} /> },
  claude: { label: 'Claude', icon: <Sparkles size={13} /> },
  opencode: { label: 'OpenCode', icon: <Bot size={13} /> },
  github: { label: 'GitHub', icon: <GitBranch size={13} /> },
  drive: { label: 'Google Drive', icon: <Cloud size={13} /> },
}

function accountSummary(account: ComputerAccount) {
  const name = TOOLS[account.tool].label
  if (!account.installed) return `${name}: not installed`
  if (account.signedIn === null) return `${name}: ${account.details[0] ?? 'sign-in unknown'}`
  if (!account.signedIn) return `${name}: signed out`
  const who = account.account ?? account.details.join(', ')
  return who ? `${name}: ${who}` : `${name}: signed in`
}

function accountState(account: ComputerAccount) {
  if (!account.installed) return 'missing'
  if (account.signedIn) return 'signed-in'
  if (account.signedIn === false) return 'signed-out'
  return 'unknown'
}

export function ComputerAccountChips({ accounts, onGitHub, onDrive, onRetry, retrying }: {
  accounts: ComputerAccounts | null | undefined
  onGitHub?: (() => void) | undefined
  onDrive?: (() => void) | undefined
  onRetry?: (() => void) | undefined
  retrying?: boolean | undefined
}) {
  const managed = { github: onGitHub, drive: onDrive }
  return <div className="computer-accounts" role="group" aria-label="Accounts">
    {accounts?.accounts.filter(account => account.tool !== 'github' && account.tool !== 'drive').map(account => {
      const summary = accountSummary(account)
      return <details key={account.tool} className="computer-account-details">
        <summary className="computer-account" data-state={accountState(account)} title={summary} aria-label={summary}>
          {TOOLS[account.tool].icon}
        </summary>
        <div className="computer-account-description">{summary}</div>
      </details>
    })}
    {(['github', 'drive'] as const).map(tool => {
      const account = accounts?.accounts.find(value => value.tool === tool)
      const summary = account ? accountSummary(account) : `${TOOLS[tool].label}: account state unavailable`
      return <button key={tool} type="button" className="computer-account"
        data-state={account ? accountState(account) : 'unknown'} title={summary}
        aria-label={`${summary}. Manage ${TOOLS[tool].label}`} onClick={managed[tool]} disabled={!managed[tool]}>
        {TOOLS[tool].icon}
      </button>
    })}
    {!accounts && <span className="computer-list-feedback"><span>Account state unavailable</span>
      {onRetry && <Button size="sm" variant="ghost" disabled={retrying} onClick={onRetry}>Retry accounts</Button>}
    </span>}
  </div>
}

// The parent keys this group by the full registration so old flow bodies are unmounted on re-pairing.
export function ComputerAccountControls({ target, name, accounts, onRetry, retrying }: {
  target: DeviceProvisioningTarget
  name: string
  accounts: ComputerAccounts | null | undefined
  onRetry: () => void
  retrying: boolean
}) {
  const key = computerKey(target)
  const openGitHub = useComputerUi(state => state.openGitHub)
  const openDrive = useComputerUi(state => state.openDrive)
  useEffect(() => () => {
    const ui = useComputerUi.getState()
    if (ui.github?.key === key) ui.closeGitHub()
    if (ui.drive?.key === key) ui.closeDrive()
  }, [key])
  return <>
    <ComputerAccountChips accounts={accounts} onGitHub={() => openGitHub(key)} onDrive={() => openDrive(key)}
      onRetry={onRetry} retrying={retrying} />
    <GitHubSignInDialog target={target} name={name} account={accounts?.accounts.find(value => value.tool === 'github')} />
    <DriveConnectDialog target={target} name={name} account={accounts?.accounts.find(value => value.tool === 'drive')} />
  </>
}
