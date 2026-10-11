import type { AccountProvider } from '@foreman-code/contracts/provider-accounts'
import { Button, Select } from '../../shared/ui/nocturne'
import { useProviderAccounts } from './providerAccountsQueries'

export function ProviderAccountSelect({ provider, value, onChange, disabled = false, remote = false }: {
  provider: AccountProvider; value?: string; onChange(value: string | undefined): void
  disabled?: boolean; remote?: boolean
}) {
  const query = useProviderAccounts(!remote)
  const accounts = query.data?.accounts.filter(account => account.provider === provider && !account.removedAt) ?? []
  const defaultAccount = accounts.find(account => account.isDefault)
  const options = [
    { value: '', label: defaultAccount ? `Provider default · ${defaultAccount.name}` : 'Provider default', disabled: false },
    ...accounts.map(account => ({ value: account.id, label: `${account.name} · ${account.status.replaceAll('-', ' ')}`,
      disabled: account.status === 'unavailable' })),
  ]
  if (value && !accounts.some(account => account.id === value)) {
    options.push({ value, label: 'Saved account · unavailable', disabled: true })
  }
  return <div className="provider-account-select">
    <Select label="Account" value={value ?? ''} options={options}
      disabled={disabled || remote || !query.isSuccess}
      hint={remote ? 'Managed accounts stay on Main. Remote Agents use credentials on their selected computer.'
        : 'Credentials stay on this computer. Manage accounts in Settings > Harnesses.'}
      onChange={event => onChange(event.target.value || undefined)} />
    {query.isPending ? <small role="status">Loading accounts…</small> : null}
    {query.isError ? <div role="alert">Accounts unavailable. Your selection is kept.
      <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry accounts</Button>
    </div> : null}
    {remote && (value || defaultAccount) ? <p role="alert">This account is local to Main. Choose Main before running.</p> : null}
  </div>
}
