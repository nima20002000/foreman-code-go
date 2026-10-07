import { Bot, Cloud, CodeXml, GitBranch, Sparkles } from 'lucide-react'
import type { ComputerAccount, ComputerAccounts } from '@foreman-code/contracts/computer-accounts'

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
  if (account.signedIn === null) return `${name}: sign-in unknown`
  if (!account.signedIn) return `${name}: signed out`
  const who = account.account ?? account.details.join(', ')
  return who ? `${name}: ${who}` : `${name}: signed in`
}

/** One small chip per tool; the account shows on hover and to screen readers. */
export function ComputerAccountChips({ accounts, onGitHub }: {
  accounts: ComputerAccounts | null | undefined; onGitHub?: (() => void) | undefined
}) {
  if (!accounts) return null
  return <div className="computer-accounts" role="group" aria-label="Accounts">
    {accounts.accounts.map(account => {
      const state = !account.installed ? 'missing' : account.signedIn ? 'signed-in' : account.signedIn === false ? 'signed-out' : 'unknown'
      const summary = accountSummary(account)
      if (account.tool === 'github' && onGitHub) return <button key={account.tool} type="button" className="computer-account"
        data-state={state} title={summary} aria-label={`${summary}. Manage GitHub`} onClick={onGitHub}>{TOOLS[account.tool].icon}</button>
      return <span key={account.tool} className="computer-account" data-state={state} title={summary} role="img" aria-label={summary}>
        {TOOLS[account.tool].icon}
      </span>
    })}
  </div>
}
