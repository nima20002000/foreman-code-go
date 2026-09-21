import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
  if (detail.data.canRespond !== true) return <p>Your signed-in account can view this request but cannot respond.</p>
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
    <h3>Decision</h3>
    {interaction.status === 'pending' && !retryInput ? <div>{interaction.responseOptions.map((option) =>
      <button key={option.optionId} type="button" disabled={response.isPending} onClick={() => send(option.optionId)}
        className={option.semantic === 'reject' || option.semantic === 'cancel' ? 'danger' : ''}>
        <strong>{option.label}</strong>
        {option.persistence !== 'request' || option.affectsOtherPendingRequests || option.interruptsCurrentTurn || option.mutatesPersistentPolicy
          ? <small>{option.scopeSummary ?? approvalOptionScope(option)}</small> : null}
      </button>)}
      {interaction.responseOptions.some((option) => option.affectsOtherPendingRequests) ? <p className="approval-warning">Some choices also affect other pending requests.</p> : null}
    </div> : null}
    {recoverable && recoveryOption ? <><p>Your choice was saved, but the agent has not confirmed it yet.</p>
      <button type="button" disabled={response.isPending} onClick={() => send(recoveryOption)}>
        {response.isPending ? 'Checking…' : ['uncertain', 'submitted'].includes(interaction.deliveryState) ? 'Check delivery' : 'Try delivery again'}
      </button></> : null}
    {interaction.status === 'delivered' || interaction.status === 'canceled' ? <p>This request is {interaction.status}.</p> : null}
    {response.isError ? <p role="alert">{response.error.message}{retryInput ? ' Check the original choice before trying anything else.' : ''}</p> : null}
  </div>
}

function UserApprovalResponseContent({ interaction, onChanged }: { interaction: DurableInteraction; onChanged(): void }) {
  const [credential] = useState<UserApprovalCredential>(() => ({ id: 'browser-user', signal: sessionSignal() }))
  return <section aria-label="User approval access">
    <AuthenticatedResponse expected={interaction} credential={credential} onChanged={onChanged} />
  </section>
}

export function UserApprovalResponse(props: { interaction: DurableInteraction; onChanged(): void }) {
  // Keep User approval request state out of the broader Operator cache.
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }))
  useEffect(() => () => client.clear(), [client])
  return <QueryClientProvider client={client}><UserApprovalResponseContent {...props} /></QueryClientProvider>
}
