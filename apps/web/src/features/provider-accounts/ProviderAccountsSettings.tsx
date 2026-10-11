import { useState } from 'react'
import type { AccountProvider } from '@foreman-code/contracts/provider-accounts'
import { useRuntimeIdentityQuery } from '../../shared/api/runtimeIdentity'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { Alert, Button, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { ProviderAccountEditor } from './ProviderAccountEditor'
import { ProviderAccountRow } from './ProviderAccountRow'
import { ProviderAccountAuthentication } from './ProviderAccountAuthentication'
import { useProviderAccountAccess } from './providerAccountAccess'
import { providerAccountsKey, useProviderAccounts, useProviderAccountScope, useProviderAccountDetails } from './providerAccountsQueries'
import './providerAccounts.css'

export type ProviderAccountNavigation = { accountId: string; operationId?: string; provider: AccountProvider }
export function ProviderAccountsSettings({ provider, selection, onSelect }: {
  provider?: AccountProvider; selection?: ProviderAccountNavigation | undefined;
  onSelect?: ((selection: ProviderAccountNavigation | undefined) => void) | undefined;
}) {
  const identity = useRuntimeIdentityQuery()
  const scope = useProviderAccountScope(provider ? { provider } : {})
  const query = useProviderAccounts(identity.isSuccess, scope)
  const denied = useProtectedAccessError(query)
  const access = useProviderAccountAccess(scope.target)
  const scopeKey = JSON.stringify(providerAccountsKey(scope))
  const [editing, setEditing] = useState<{ scopeKey: string; provider: AccountProvider; accountId?: string }>()
  const [authentication, setAuthentication] = useState<{ scopeKey: string; accountId: string;
    provider: AccountProvider; operationId?: string; open: boolean }>()
  const edit = editing?.scopeKey === scopeKey ? editing : undefined
  const auth = authentication?.scopeKey === scopeKey ? authentication : undefined
  const selected = selection?.provider === provider ? selection : undefined
  const authAccountId = selected?.accountId ?? auth?.accountId
  const authOperationId = selected?.operationId ?? auth?.operationId
  const accounts = denied ? [] : query.data?.accounts ?? []
  const account = accounts.find(item => item.id === edit?.accountId)
  const listedAuthAccount = accounts.find(item => item.id === authAccountId)
  const authDetail = useProviderAccountDetails(query.isSuccess && !denied && !listedAuthAccount ? authAccountId : undefined, scope)
  const authDetailDenied = useProtectedAccessError(authDetail)
  const authAccount = listedAuthAccount ?? (!authDetail.isError && !authDetailDenied ? authDetail.data : undefined)
  const providers = provider ? [provider] : ['codex', 'claude'] as const
  return <section className="provider-accounts-settings" aria-label={provider
    ? `${provider === 'codex' ? 'Codex' : 'Claude'} accounts` : 'Provider accounts'}>
    <header className="provider-accounts-heading"><h3>Accounts</h3></header>
    <p>Default for new work without a saved account/profile.</p>
    {scope.target ? <p className="provider-account-note">Main · {scope.target.hostRef.mainId}
      {' · Installation '}{scope.target.applicationInstallationId}</p> : null}
    <p className="provider-account-note">Credentials stay on their owning computer. Remote account setup is unavailable here.</p>
    {denied || query.isError && !query.data || identity.isError ? <ErrorState title="Accounts are unavailable"
      description={denied?.message ?? query.error?.message ?? identity.error?.message ?? 'Refresh accounts to read their saved state.'}
      onRetry={() => { void identity.refetch(); void query.refetch() }} /> : !query.data ?
      <LoadingState label="Loading accounts…" rows={1} /> : <>
      {query.isError ? <Alert live tone="danger" title={query.error.message}
        action={<Button onClick={() => void query.refetch()}>Retry accounts</Button>} /> : null}
      {providers.map(item => <section key={item} aria-label={provider ? undefined : `${item === 'codex' ? 'Codex' : 'Claude'} accounts`}>
        <div className="provider-accounts-heading">
          {!provider ? <h4>{item === 'codex' ? 'Codex' : 'Claude'}</h4> : null}
          <Button size="sm" disabled={!access.canManage || Boolean(edit) || !scope.target}
            onClick={() => setEditing({ scopeKey, provider: item })}>Add {item === 'codex' ? 'Codex' : 'Claude'} account</Button>
        </div>
        <div className="provider-accounts-rows">{accounts.filter(value => value.provider === item).map(value =>
          <ProviderAccountRow key={`${scopeKey}:${value.id}:${value.binding?.bindingRevision ?? 0}`}
            account={value} revision={query.data!.revision} scope={scope}
            defaultRevision={query.data!.defaults?.find(current => current.provider === item)?.revision}
            onConfigure={() => setEditing({ scopeKey, provider: item, accountId: value.id })}
            onAuthenticate={() => {
              setAuthentication({ scopeKey, provider: item, accountId: value.id,
                ...(auth?.accountId === value.id && auth.operationId ? { operationId: auth.operationId } : {}), open: true })
              onSelect?.({ provider: item, accountId: value.id,
                ...(auth?.accountId === value.id && auth.operationId ? { operationId: auth.operationId } : {}) })
            }} />)}</div>
        {!accounts.some(value => value.provider === item) ? <p>No accounts added. Add one to keep its sign-in separate.</p> : null}
      </section>)}
    </>}
    {edit && !denied && query.data ? <ProviderAccountEditor key={`${scopeKey}:${edit.accountId ?? edit.provider}`}
      provider={edit.provider} accountId={edit.accountId} {...(account ? { account } : {})} scope={scope} revision={query.data.revision}
      canManage={access.canManageAccount(edit.accountId)} onClose={() => setEditing(undefined)} /> : null}
    {selected && !authAccount && !authDetail.isPending ? <ErrorState title="Saved authentication account is unavailable"
      description="The operation link is retained. Restore account access to recheck its original progress."
      onRetry={() => void authDetail.refetch()} /> : null}
    {authAccount && query.data && !denied ? <ProviderAccountAuthentication
      key={`${scopeKey}:${authAccount.id}`} account={authAccount} revision={query.data.revision}
      open={onSelect ? Boolean(selected) : Boolean(auth?.open)} canManage={access.canManageAccount(authAccount.id)}
      {...(authOperationId ? { operationId: authOperationId } : {})}
      onOperation={operationId => {
        setAuthentication({ scopeKey, provider: authAccount.provider, accountId: authAccount.id, operationId, open: true })
        onSelect?.({ provider: authAccount.provider, accountId: authAccount.id, operationId })
      }}
      onClose={() => {
        setAuthentication({ scopeKey, provider: authAccount.provider, accountId: authAccount.id,
          ...(authOperationId ? { operationId: authOperationId } : {}), open: false })
        onSelect?.(undefined)
      }} /> : null}
  </section>
}
