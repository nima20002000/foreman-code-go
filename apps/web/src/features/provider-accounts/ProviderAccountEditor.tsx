import { useRef, useState } from 'react'
import {
  ProviderAccountApiKeyInputSchema, type AccountProvider, type ProviderAccount,
  type ProviderAccountAuthMode, type ProviderAccountCommandInput,
  type ProviderAccountCreateInput, type ProviderAccountRenameInput,
} from '@foreman-code/contracts/provider-accounts'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { Alert, Button, Dialog, Select, TextField } from '../../shared/ui/nocturne'
import { type ProviderAccountScope, useProviderAccountWrite } from './providerAccountsQueries'

export function ProviderAccountEditor({ provider, account, revision, onClose, scope = {}, canManage = true, accountId = account?.id }: {
  provider: AccountProvider; account?: ProviderAccount; revision: number; onClose(): void; scope?: ProviderAccountScope; canManage?: boolean; accountId?: string | undefined
}) {
  const [name, setName] = useState(account?.name ?? '')
  const [savedName, setSavedName] = useState(account?.name ?? '')
  const [authMode, setAuthMode] = useState<ProviderAccountAuthMode>(account?.authMode ?? 'subscription')
  const [apiKey, setApiKey] = useState('')
  const [validation, setValidation] = useState<string>()
  const keyField = useRef<HTMLInputElement>(null)
  const write = useProviderAccountWrite(() => keyField.current?.value ?? '', scope)
  type NameInput = Omit<ProviderAccountCreateInput | ProviderAccountRenameInput, 'commandId'>
  const nameAttempt = useRef(new CommandAttempt<NameInput>()).current
  const nameInput = useRef<NameInput | undefined>(undefined)
  const keyAttempt = useRef(new CommandAttempt<Omit<ProviderAccountCommandInput, 'commandId'>>()).current
  const keyInput = useRef<Omit<ProviderAccountCommandInput, 'commandId'> | undefined>(undefined)
  const uncertain = nameAttempt.unresolved || keyAttempt.unresolved
  const missingAccount = Boolean(accountId && !account)
  const locked = !canManage || missingAccount || write.isPending || uncertain
  const dirty = name !== savedName || apiKey !== '' || (!accountId && authMode !== 'subscription')
  const error = validation ?? write.error?.message

  async function saveName() {
    if (!name.trim()) {
      setValidation('Enter an account name.')
      return
    }
    const commonInput = { name: name.trim(), expectedRevision: revision,
      ...(scope.target ? { target: scope.target } : {}) }
    const draft = accountId ? { ...commonInput, ...(account ? { expectedLabelRevision: account.revision } : {}) }
      : { ...commonInput, provider, authMode }
    const input = nameAttempt.input(nameInput.current ?? draft)
    nameInput.current ??= draft
    try {
      if (accountId) await write.mutateAsync({ action: 'rename', accountId, input })
      else await write.mutateAsync({ action: 'create', input: { ...input, provider, authMode } })
      nameAttempt.succeeded()
      nameInput.current = undefined
      setSavedName(name)
      if (!accountId) onClose()
    } catch (failure) {
      nameAttempt.failed(failure)
      if (!nameAttempt.unresolved) nameInput.current = undefined
    }
  }
  async function saveKey() {
    if (!accountId) return
    const draft = keyInput.current ?? { expectedRevision: revision, ...(scope.target ? { target: scope.target } : {}) }
    const valid = ProviderAccountApiKeyInputSchema.safeParse({ ...draft, commandId: 'validate-key', apiKey })
    if (!valid.success) { setValidation('Enter a valid API key (at least 20 characters, without spaces).'); return }
    const input = keyAttempt.input(draft)
    keyInput.current ??= draft
    try {
      await write.mutateAsync({ action: 'api-key', accountId, input })
      keyAttempt.succeeded()
      keyInput.current = undefined
      if (keyField.current) keyField.current.value = ''
      setApiKey('')
    } catch (failure) {
      keyAttempt.failed(failure)
      if (!keyAttempt.unresolved) keyInput.current = undefined
    }
  }
  const save = () => keyAttempt.unresolved || (apiKey && !nameAttempt.unresolved && name === savedName)
    ? saveKey() : saveName()
  const leave = useUnsavedChanges({ scope: 'surface', label: 'provider account', dirty, busy: write.isPending,
    uncertain, error, save, discard: () => { setApiKey(''); onClose() },
  })
  function close() {
    if (!write.isPending && !uncertain) void leave(onClose)
  }
  const configureTitle = accountId ? `Configure ${account?.name ?? 'saved account'}` : undefined
  return <Dialog open title={configureTitle ?? `Add ${provider === 'codex' ? 'Codex' : 'Claude'} account`}
    description={accountId ? "Changes apply to this account on its owning computer."
      : "Add a fresh isolated account on the selected computer. Adding it does not sign in or qualify its profile."}
    busy={write.isPending} onOpenChange={open => { if (!open) close() }} size="sm"
    footer={<>
      <Button disabled={write.isPending || uncertain} onClick={close}>Cancel</Button>
      <Button variant="primary" disabled={!canManage || write.isPending || keyAttempt.unresolved || (missingAccount && !nameAttempt.unresolved) || (!name.trim())
        || (Boolean(accountId) && name === savedName && !nameAttempt.unresolved)}
        onClick={() => void saveName()}>{nameAttempt.unresolved ? 'Retry original save' : accountId ? 'Save name' : 'Add account'}</Button>
    </>}>
    <div className="provider-account-form">
      <TextField label="Account name" value={name} maxLength={100} disabled={locked}
        onChange={event => { setName(event.target.value); setValidation(undefined) }} />
      <Select label="Authentication" value={authMode} disabled={Boolean(accountId) || locked}
        options={provider === 'codex' ? [{ value: 'subscription', label: 'ChatGPT subscription login' }] : [
          { value: 'subscription', label: 'Claude subscription login' }, { value: 'api-key', label: 'API key · separate billing' },
        ]} hint={accountId ? 'Authentication is chosen when the account is added.' : undefined}
        onChange={event => setAuthMode(event.target.value as ProviderAccountAuthMode)} />
      {account && authMode === 'api-key' ? <>
        <TextField ref={keyField} label="New API key" type="password" value={apiKey} autoComplete="off" spellCheck={false}
          disabled={locked} maxLength={4096} hint="Write-only. The saved key is never shown or returned."
          onChange={event => { setApiKey(event.target.value); setValidation(undefined) }} />
        <Button disabled={!canManage || write.isPending || nameAttempt.unresolved || !apiKey.trim()}
          onClick={() => void saveKey()}>{keyAttempt.unresolved ? 'Retry original key save' : 'Save API key'}</Button>
      </> : null}
      {missingAccount ? <p role="alert">The saved account is unavailable. Your input is kept; restore account access before saving.</p> : null}
      {!accountId ? <p>Existing-profile registration is unavailable until this computer supplies qualified profile choices.</p> : null}
      {!accountId && authMode === 'api-key' ? <p>Add the account, then configure its API key.</p> : null}
      {account?.authMode === 'subscription' ? <p>Use Authentication progress on the account row to prepare or recheck provider sign-in.</p> : null}
      {uncertain && !write.isPending ? <Alert tone="warning" title="The previous save is unconfirmed. Retry it before editing or leaving." /> : null}
      {error ? <Alert live tone="danger" title={error} /> : null}
    </div>
  </Dialog>
}
