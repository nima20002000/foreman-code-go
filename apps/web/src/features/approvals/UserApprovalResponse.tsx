import { useEffect, useId, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import type { DurableInteraction } from '@graphql/contracts'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { sessionSignal } from '../../shared/api/sessionBoundary'
import {
  useUserInteractionQuery, useUserInteractionResponse,
  type UserApprovalCredential, type UserApprovalResponseInput,
} from '../../shared/api/userApprovals'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { canRecoverInteraction } from './approvalState'

function AuthenticatedResponse({ expected, credential, onChanged }: {
  expected: DurableInteraction; credential: UserApprovalCredential; onChanged(): void
}) {
  const detail = useUserInteractionQuery(expected.id, credential)
  const response = useUserInteractionResponse(credential)
  const [attempt] = useState(() => new CommandAttempt<UserApprovalResponseInput>())
  const [retryInput, setRetryInput] = useState<UserApprovalResponseInput>()
  const inFlight = useRef(false)
  if (detail.isError) return <div role="alert"><p>User access could not be verified: {detail.error.message}</p><button type="button" onClick={() => void detail.refetch()}>Check User access again</button></div>
  if (detail.isPending || !detail.data) return <p role="status">Checking User access…</p>
  const interaction = detail.data.interaction
  if (interaction.id !== expected.id || interaction.workspaceId !== expected.workspaceId
    || interaction.workflowId !== expected.workflowId || interaction.runId !== expected.runId
    || interaction.approval.handler !== 'user') return <p role="alert">The User response does not match this request.</p>
  if (detail.data.canRespond !== true) return <p>This User credential can view the request but cannot respond.</p>
  const send = (optionId: string) => {
    if (inFlight.current || credential.signal.aborted) return
    const input = retryInput ?? { interactionId: interaction.id, optionId, expectedRevision: interaction.revision }
    attempt.input(input)
    inFlight.current = true
    setRetryInput(input)
    response.mutate(input, {
      onSuccess: () => { inFlight.current = false; attempt.succeeded(); setRetryInput(undefined); onChanged() },
      onError: (error) => { inFlight.current = false; attempt.failed(error); if (!attempt.unresolved) setRetryInput(undefined) },
    })
  }
  const recoveryOption = retryInput?.optionId ?? interaction.selectedOptionId
  const recoverable = interaction.status !== 'canceled' && interaction.status !== 'delivered'
    && (canRecoverInteraction(interaction) || Boolean(retryInput))
  return <div className="approval-actions">
    <h3>Respond as User</h3>
    {interaction.status === 'pending' && !retryInput ? <div>{interaction.responseOptions.map((option) =>
      <button key={option.optionId} type="button" disabled={response.isPending} onClick={() => send(option.optionId)}
        className={option.semantic === 'reject' || option.semantic === 'cancel' ? 'danger' : ''}>
        <strong>{option.label}</strong><small>{approvalOptionScope(option)}</small>
        {option.scopeSummary ? <small>{option.scopeSummary}</small> : null}
      </button>)}
      {interaction.responseOptions.some((option) => option.affectsOtherPendingRequests) ? <p className="approval-warning">Some choices affect other pending requests. Review each choice’s scope.</p> : null}
    </div> : null}
    {recoverable && recoveryOption ? <><p>The original choice is preserved. Reconciliation never resends an uncertain response.</p>
      <button type="button" disabled={response.isPending} onClick={() => send(recoveryOption)}>
        {response.isPending ? 'Checking delivery…' : ['uncertain', 'submitted'].includes(interaction.deliveryState) ? 'Reconcile delivery' : 'Retry original choice'}
      </button></> : null}
    {interaction.status === 'delivered' || interaction.status === 'canceled' ? <p>This request is {interaction.status}.</p> : null}
    {response.isError ? <p role="alert">{response.error.message}{retryInput ? ' Check the original choice before trying anything else.' : ''}</p> : null}
  </div>
}

function UserApprovalResponseContent({ interaction, onChanged }: { interaction: DurableInteraction; onChanged(): void }) {
  const id = useId()
  const client = useQueryClient()
  const [credential, setCredential] = useState<(UserApprovalCredential & { controller: AbortController })>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!credential) return
    const clear = () => setCredential(undefined)
    credential.signal.addEventListener('abort', clear, { once: true })
    if (credential.signal.aborted) clear()
    return () => {
      credential.signal.removeEventListener('abort', clear)
      credential.controller.abort()
      void client.cancelQueries({ queryKey: ['user-approval', credential.id] })
      client.removeQueries({ queryKey: ['user-approval', credential.id] })
    }
  }, [client, credential])
  return <section aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>User approval access</h3>
    {credential ? <>
      <AuthenticatedResponse key={credential.id} expected={interaction} credential={credential} onChanged={onChanged} />
      <button type="button" onClick={() => setCredential(undefined)}>Forget User credential</button>
    </> : <form onSubmit={(event) => {
      event.preventDefault()
      const form = event.currentTarget
      const token = String(new FormData(form).get('userCredential') ?? '').trim()
      if (!token || /\s/.test(token)) { setError('Enter a User bearer credential without spaces.'); return }
      const controller = new AbortController()
      setCredential({ id: crypto.randomUUID(), token, controller, signal: AbortSignal.any([controller.signal, sessionSignal()]) })
      setError('')
      form.reset()
    }}>
      <p>Use a separate User credential to approve this request. Your Operator session is only used for monitoring. This credential is kept in memory and forgotten when you leave this request.</p>
      <label htmlFor={`${id}-token`}>User bearer credential</label>
      <input id={`${id}-token`} name="userCredential" type="password" required autoComplete="off" spellCheck={false} aria-describedby={`${id}-error`} />
      <button type="submit">Verify User access</button>
      <p id={`${id}-error`} role={error ? 'alert' : undefined}>{error}</p>
    </form>}
  </section>
}

export function UserApprovalResponse(props: { interaction: DurableInteraction; onChanged(): void }) {
  // Keep responses made with the separate User credential out of the Operator cache.
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }))
  useEffect(() => () => client.clear(), [client])
  return <QueryClientProvider client={client}><UserApprovalResponseContent {...props} /></QueryClientProvider>
}
