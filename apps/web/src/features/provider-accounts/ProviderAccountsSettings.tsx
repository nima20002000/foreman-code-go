import { useRef, useState } from 'react'
import type { AccountProvider, ProviderAccount, ProviderAccountCommandInput } from '@foreman-code/contracts/provider-accounts'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { Alert, Button, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { ProviderAccountEditor } from './ProviderAccountEditor'
import type { ProviderAccountAction } from './providerAccountsClient'
import { useProviderAccounts, useProviderAccountWrite } from './providerAccountsQueries'
import './providerAccounts.css'

const statusLabels: Record<ProviderAccount['status'], string> = {
  'signed-in': 'Signed in', 'signed-out': 'Signed out', 'login-pending': 'Sign-in pending', unavailable: 'Unavailable',
}

function AccountCard({ account, revision, onConfigure }: {
  account: ProviderAccount; revision: number; onConfigure(): void
}) {
  const write = useProviderAccountWrite()
  const attempt = useRef(new CommandAttempt<Omit<ProviderAccountCommandInput, 'commandId'>>()).current
  const original = useRef<{ action: ProviderAccountAction; expectedRevision: number } | undefined>(undefined)
  async function act(action: ProviderAccountAction) {
    const draft = original.current ?? { action, expectedRevision: revision }
    const input = attempt.input({ expectedRevision: draft.expectedRevision })
    original.current ??= draft
    try {
      await write.mutateAsync({ action: draft.action, accountId: account.id, input })
      attempt.succeeded()
      original.current = undefined
    } catch (failure) {
      attempt.failed(failure)
      if (!attempt.unresolved) original.current = undefined
    }
  }
  const locked = write.isPending || attempt.unresolved
  useUnsavedChanges({ scope: 'surface', label: `${account.name} account action`, dirty: attempt.unresolved,
    busy: write.isPending, uncertain: attempt.unresolved, error: write.error?.message,
    save: () => original.current ? act(original.current.action) : undefined, discard: () => undefined,
  })
  return <article className="settings-choice provider-account-card" aria-label={`${account.name} account`}>
    <div className="provider-account-summary">
      <header><strong>{account.name}</strong>{account.isDefault ? <small>Default</small> : null}</header>
      <dl>
        <div><dt>Status</dt><dd>{statusLabels[account.status]}</dd></div>
        <div><dt>Identity</dt><dd>{account.identity ?? 'Not available'}</dd></div>
        <div><dt>Authentication</dt><dd>{account.authMode === 'api-key' ? 'API key' : 'Subscription'}</dd></div>
      </dl>
      {account.status === 'login-pending' ? <p role="status">Complete sign-in in the provider’s browser, then refresh status.</p> : null}
    </div>
    <div className="settings-choice-footer provider-account-actions">
      <Button size="sm" disabled={locked} onClick={onConfigure}>Configure</Button>
      {!account.isDefault ? <Button size="sm" disabled={locked} onClick={() => void act('default')}>Make default</Button> : null}
      {account.authMode === 'subscription' ? <Button size="sm" disabled={locked || account.status === 'login-pending'}
        onClick={() => void act(account.status === 'signed-in' ? 'logout' : 'login')}>
        {account.status === 'signed-in' ? 'Sign out' : 'Sign in'}
      </Button> : null}
      <Button size="sm" variant="ghost" disabled={locked} onClick={() => void act('refresh')}>Refresh status</Button>
      {attempt.unresolved && !write.isPending ? <Button size="sm" onClick={() => void act(original.current!.action)}>Retry original action</Button> : null}
      {write.isPending ? <small role="status">Updating account…</small> : null}
      {write.error ? <p role="alert">{write.error.message}</p> : null}
    </div>
  </article>
}

export function ProviderAccountsSettings() {
  const query = useProviderAccounts()
  const [editing, setEditing] = useState<{ provider: AccountProvider; accountId?: string }>()
  if (query.isError && !query.data) return <ErrorState title="Provider accounts are unavailable"
    description={query.error.message} onRetry={() => void query.refetch()} />
  if (!query.data) return <LoadingState label="Loading provider accounts…" />
  const account = query.data.accounts.find(item => item.id === editing?.accountId)
  return <section className="provider-accounts-settings" aria-label="Provider accounts">
    <header className="settings-experience-heading"><h2>Provider accounts</h2>
      <p>Named accounts for Agents and the Operator. Each account keeps its credentials on this computer.</p></header>
    {query.isError ? <Alert live tone="danger" title={query.error.message}
      action={<Button onClick={() => void query.refetch()}>Retry accounts</Button>} /> : null}
    {(['codex', 'claude'] as const).map(provider => <section key={provider} aria-label={`${provider === 'codex' ? 'Codex' : 'Claude'} accounts`}>
      <div className="provider-accounts-heading"><h3>{provider === 'codex' ? 'Codex' : 'Claude'}</h3>
        <Button size="sm" disabled={Boolean(editing)} onClick={() => setEditing({ provider })}>
          Add {provider === 'codex' ? 'Codex' : 'Claude'} account
        </Button></div>
      <div className="settings-choice-grid">{query.data!.accounts.filter(item => item.provider === provider).map(item =>
        <AccountCard key={item.id} account={item} revision={query.data!.revision}
          onConfigure={() => setEditing({ provider, accountId: item.id })} />)}</div>
      {!query.data!.accounts.some(item => item.provider === provider) ? <p>No accounts added. Add one to keep its sign-in separate.</p> : null}
    </section>)}
    {editing ? <ProviderAccountEditor key={editing.accountId ?? editing.provider} provider={editing.provider}
      {...(account ? { account } : {})} revision={query.data.revision} onClose={() => setEditing(undefined)} /> : null}
  </section>
}
