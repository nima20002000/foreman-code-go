import { useRef, useState } from 'react'
import type { ProviderAccount, ProviderAccountAuthenticationOperation } from '@foreman-code/contracts/provider-accounts'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { Alert, Button, Dialog } from '../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import type { ProviderAccountPrepareInput, ProviderAccountCancelInput } from './providerAccountsClient'
import { useProviderAuthentication, useProviderAuthenticationWrite } from './providerAccountsQueries'

const stateLabels: Record<ProviderAccountAuthenticationOperation['state'], string> = {
  reserved: 'Preparing authentication', 'awaiting-human': 'Waiting for human sign-in',
  observing: 'Checking provider completion', completed: 'Authentication completed',
  canceled: 'Authentication canceled', expired: 'Authentication expired', failed: 'Authentication failed',
  'outcome-unknown': 'Authentication outcome unknown',
}

type Props = {
  account: ProviderAccount; revision: number; open: boolean; canManage: boolean;
  operationId?: string; onOperation(operationId: string): void; onClose(): void;
}
export function ProviderAccountAuthentication({ account, revision, open, canManage,
  operationId, onOperation, onClose }: Props) {
  const [intent, setIntent] = useState<'sign-in' | 'sign-out'>('sign-in')
  const query = useProviderAuthentication(account.binding, operationId)
  const write = useProviderAuthenticationWrite(account.binding)
  const denied = useProtectedAccessError(query, write.error)
  const operation = denied ? undefined : query.data
  const prepareAttempt = useRef(new CommandAttempt<Omit<ProviderAccountPrepareInput, 'commandId'>>()).current
  const cancelAttempt = useRef(new CommandAttempt<Omit<ProviderAccountCancelInput, 'commandId'>>()).current
  const prepareInput = useRef<Omit<ProviderAccountPrepareInput, 'commandId'> | undefined>(undefined)
  const cancelInput = useRef<Omit<ProviderAccountCancelInput, 'commandId'> | undefined>(undefined)
  const uncertain = prepareAttempt.unresolved || cancelAttempt.unresolved
  const busy = write.isPending

  async function prepare() {
    const draft = prepareInput.current ?? { expectedRevision: revision, intent,
      ...(account.binding ? { target: account.binding.target } : {}) }
    prepareInput.current ??= draft
    try {
      const result = await write.mutateAsync({ action: 'prepare', input: prepareAttempt.input(draft) })
      prepareAttempt.succeeded()
      prepareInput.current = undefined
      onOperation(result.id)
    } catch (error) {
      prepareAttempt.failed(error)
      if (!prepareAttempt.unresolved) prepareInput.current = undefined
    }
  }
  async function cancel() {
    if (!operationId) return
    const draft = cancelInput.current ?? { operationId, expectedRevision: revision,
      ...(account.binding ? { target: account.binding.target } : {}) }
    cancelInput.current ??= draft
    try {
      await write.mutateAsync({ action: 'cancel', input: cancelAttempt.input(draft) })
      cancelAttempt.succeeded()
      cancelInput.current = undefined
    } catch (error) {
      cancelAttempt.failed(error)
      if (!cancelAttempt.unresolved) cancelInput.current = undefined
    }
  }
  useUnsavedChanges({ scope: 'surface', label: `${account.name} authentication`, dirty: uncertain,
    busy, uncertain, error: write.error?.message, save: () => cancelAttempt.unresolved ? cancel() : prepare(),
    discard: () => undefined })
  const canPrepare = canManage && Boolean(account.binding) && !account.removedAt
    && ['ready', 'sign-in-required'].includes(account.observation?.readiness ?? '')
  return <Dialog open={open} title={`Authentication for ${account.name}`} busy={busy}
    description="Authentication continues on the owning computer when you hide this progress."
    onOpenChange={next => { if (!next && !busy && !uncertain) onClose() }}
    footer={<Button disabled={busy || uncertain} onClick={onClose}>Hide progress</Button>}>
    <div className="provider-account-form">
      {operationId ? <>
        {query.isPending ? <p role="status">Reading authentication progress…</p> : null}
        {operation ? <>
          <p role="status">{stateLabels[operation.state]}</p>
          <p>Last checked <time dateTime={operation.updatedAt}>{new Date(operation.updatedAt).toLocaleString()}</time></p>
          {operation.cancelRequested && !operation.nativeClosed ? <Alert tone="warning"
            title="Cancel requested. The provider has not confirmed closure." /> : null}
          {operation.nativeClosed ? <p>The provider operation is closed.</p> : null}
          {operation.humanActionRequired && !operation.cancelRequested && !operation.nativeClosed ?
            <p>Complete sign-in through the provider on the owning computer. A browser handoff is unavailable here.</p> : null}
          {operation.state === 'outcome-unknown' ? <p>Recheck this operation to find its result.</p> : null}
          {['expired', 'failed'].includes(operation.state) && !operation.nativeClosed ?
            <p>The provider may still be running. Recheck or cancel this operation before starting another.</p> : null}
          {operation.state === 'completed' ? <p>Refresh the account to read its sign-in and readiness. Its default is unchanged.</p> : null}
          {!operation.nativeClosed ? <Button disabled={!canManage || busy || prepareAttempt.unresolved}
            onClick={() => void cancel()}>{cancelAttempt.unresolved ? 'Retry original cancel' : 'Cancel authentication'}</Button> : null}
        </> : null}
        <Button disabled={query.isFetching || busy} onClick={() => void query.refetch()}>Recheck original operation</Button>
      </> : <>
        <p>Choose an authentication action for this account.</p>
        <div className="provider-account-actions">
          <Button disabled={!canPrepare || busy || uncertain} aria-pressed={intent === 'sign-in'}
            onClick={() => setIntent('sign-in')}>Sign in</Button>
          <Button disabled={!canPrepare || busy || uncertain} aria-pressed={intent === 'sign-out'}
            onClick={() => setIntent('sign-out')}>Sign out</Button>
        </div>
        <Button variant="primary" disabled={!canPrepare || busy || cancelAttempt.unresolved}
          onClick={() => void prepare()}>{prepareAttempt.unresolved ? 'Retry original authentication' : 'Prepare authentication'}</Button>
        {!canPrepare ? <p>Authentication requires manage access and qualified native support for this account.</p> : null}
        {account.status === 'login-pending' ? <p>An authentication operation may already be running. Its saved progress link is required to recheck it.</p> : null}
      </>}
      {uncertain ? <Alert tone="warning" title="The request is unconfirmed. Retry the original request before leaving." /> : null}
      {denied || query.isError || write.isError ? <Alert live tone="danger"
        title={(denied ?? write.error ?? query.error)?.message ?? 'Authentication status is unavailable.'} /> : null}
    </div>
  </Dialog>
}
