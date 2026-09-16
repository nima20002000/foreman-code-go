import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, Inbox, ShieldCheck, XCircle } from 'lucide-react'
import type { DurableInteraction } from '@graphql/contracts'

import { useInteractionQuery, useInfiniteInteractionsQuery, useRespondToInteractionMutation } from '../../shared/api/query'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { canRecoverInteraction, interactionMatchesScope } from './approvalState'
import './approvals.css'

export interface ApprovalInboxProps {
  workspaceId?: string
  workflowId?: string
  selectedInteractionId?: string
  onSelectInteraction?(interactionId?: string): void
}
const stateLabels = {
  pending: 'Waiting for decision', decided: 'Decision accepted', delivery_pending: 'Delivering',
  delivered: 'Delivered', delivery_failed: 'Delivery failed', canceled: 'Canceled',
} as const
function StateIcon({ state }: { state: keyof typeof stateLabels }) {
  if (state === 'delivered') return <CheckCircle2 aria-hidden="true" size={16} />
  if (state === 'delivery_failed' || state === 'canceled') return <XCircle aria-hidden="true" size={16} />
  return <Clock3 aria-hidden="true" size={16} />
}
type ResponseInput = { interactionId: string; optionId: string; expectedRevision: number }

function ApprovalDetail({ interactionId, workspaceId, workflowId, onClear }: {
  interactionId: string; workspaceId?: string; workflowId?: string; onClear(): void
}) {
  const detail = useInteractionQuery(interactionId)
  const respond = useRespondToInteractionMutation()
  const [attempt] = useState(() => new CommandAttempt<ResponseInput>())
  const [retryInput, setRetryInput] = useState<ResponseInput>()
  const inFlight = useRef(false)
  if (detail.isError) return <article className="approval-detail"><div role="alert"><h2>Request unavailable</h2><p>{detail.error.message}</p><button type="button" onClick={() => void detail.refetch()}>Retry request</button></div></article>
  if (detail.isPending || !detail.data) return <article className="approval-detail"><p role="status">Loading request…</p></article>
  const selected = detail.data.interaction
  if (selected.id !== interactionId || !interactionMatchesScope(selected, { workspaceId, workflowId })) {
    return <article className="approval-detail"><p role="alert">This request is outside the selected Inbox scope.</p><button type="button" onClick={onClear}>Clear selection</button></article>
  }
  const canRespond = selected.approval.handler === 'user' && detail.data.canRespond === true
  const send = (optionId: string) => {
    if (inFlight.current) return
    const input = retryInput ?? { interactionId: selected.id, optionId, expectedRevision: selected.revision }
    attempt.input(input)
    inFlight.current = true
    setRetryInput(input)
    respond.mutate(input, {
      onSuccess: () => { inFlight.current = false; attempt.succeeded(); setRetryInput(undefined) },
      onError: (error) => { inFlight.current = false; attempt.failed(error); if (!attempt.unresolved) setRetryInput(undefined) },
    })
  }
  const recoverable = canRespond && selected.status !== 'canceled' && selected.status !== 'delivered'
    && (canRecoverInteraction(selected) || Boolean(retryInput))
  const recoveryOption = retryInput?.optionId ?? selected.selectedOptionId
  const selectedLabel = selected.responseOptions.find((option) => option.optionId === selected.selectedOptionId)?.label
  return <article className="approval-detail">
    <header><div><p className="panel-kicker">{selected.harness} {selected.providerVersion}</p><h2>{selected.nativeRequestType}</h2></div><span className={`approval-state approval-state-${selected.status}`}><StateIcon state={selected.status} />{stateLabels[selected.status]}</span></header>
    <dl className="approval-context">
      <div><dt>Workspace</dt><dd>{selected.workspaceId}</dd></div><div><dt>Workflow</dt><dd>{selected.workflowId}</dd></div>
      <div><dt>Requesting Agent</dt><dd>{selected.requestingAgentId}</dd></div><div><dt>Run / execution</dt><dd>{selected.runId} / {selected.executionId}</dd></div>
      <div><dt>Accepted handler</dt><dd>{selected.approval.handler}{selected.approval.designatedOrchestratorAgentId ? ` · ${selected.approval.designatedOrchestratorAgentId}` : ''}</dd></div>
      <div><dt>Native delivery</dt><dd>{selected.deliveryState.replaceAll('_', ' ')}</dd></div>
    </dl>
    <div className="approval-request"><h3>Request details</h3><pre>{JSON.stringify(selected.request, null, 2)}</pre></div>
    {!canRespond ? <p className="approval-reviewer-note">Read-only monitoring. This request is assigned to {selected.approval.handler}; no human override is available.</p> : null}
    {canRespond && selected.status === 'pending' && !retryInput ? <div className="approval-actions"><h3>Response</h3><div>
      {selected.responseOptions.map((option) => <button key={option.optionId} type="button" disabled={respond.isPending} className={option.semantic === 'reject' || option.semantic === 'cancel' ? 'danger' : ''} onClick={() => send(option.optionId)}>
        <strong>{option.label}</strong>{option.scopeSummary ? <small>{option.scopeSummary}</small> : null}
      </button>)}
      </div>{selected.responseOptions.some((option) => option.affectsOtherPendingRequests) ? <p className="approval-warning"><AlertTriangle size={15} />A provider choice may affect other pending requests. Review its scope before responding.</p> : null}
    </div> : null}
    {recoverable && recoveryOption ? <div className="approval-actions"><h3>Delivery recovery</h3><p>A recorded decision is not proof of native delivery. Only the original choice can be retried; alternative choices stay closed.</p>
      <button type="button" disabled={respond.isPending} onClick={() => send(recoveryOption)}>{respond.isPending ? 'Checking delivery…' : selected.deliveryState === 'uncertain' || selected.deliveryState === 'submitted' ? 'Reconcile delivery' : 'Retry selected response'}</button>
    </div> : null}
    {selected.selectedOptionId ? <div className="approval-history"><h3>Decision history</h3><p><strong>{selectedLabel ?? selected.selectedOptionId}</strong> accepted at {selected.decidedAt ?? 'unknown time'}.</p><p>Delivery: {selected.deliveryState.replaceAll('_', ' ')}{selected.deliveredAt ? ` at ${selected.deliveredAt}` : ''}.</p></div> : null}
    {respond.isError ? <p className="approval-warning" role="alert"><AlertTriangle size={15} />{respond.error.message}{retryInput ? ' Retry the original choice to resolve its outcome.' : ' Refresh the request before choosing again.'}</p> : null}
    <button type="button" onClick={() => void detail.refetch()}>Refresh request</button>
  </article>
}

export function ApprovalInbox({ workspaceId, workflowId, selectedInteractionId, onSelectInteraction }: ApprovalInboxProps) {
  const list = useInfiniteInteractionsQuery({ workspaceId, workflowId, limit: 100 })
  const byId = new Map<string, DurableInteraction>()
  for (const page of list.data?.pages ?? []) for (const item of page.items) {
    if (!interactionMatchesScope(item, { workspaceId, workflowId })) continue
    const current = byId.get(item.id)
    if (!current || item.revision >= current.revision) byId.set(item.id, item)
  }
  const interactions = [...byId.values()]
  const pendingCount = list.data?.pages[0]?.pendingCount
  return <section className="approval-inbox" aria-labelledby="approval-inbox-title">
    <header className="approval-inbox-header"><div><p className="panel-kicker">Review queue</p><h1 id="approval-inbox-title">Approval Inbox</h1><p>{workflowId ? 'Requests for this workflow.' : workspaceId ? 'Requests across this workspace.' : 'Requests across every authorized workspace.'}</p></div>
      <span className="approval-count"><Inbox size={17} />{pendingCount === undefined || list.isError ? 'Pending count unavailable' : `${pendingCount} pending`}</span></header>
    <div className="approval-layout"><div>
      {list.isError ? <div className="approval-empty" role="alert"><AlertTriangle /><h2>Inbox unavailable</h2><p>{list.error.message}</p><button type="button" onClick={() => void list.refetch()}>Retry Inbox</button></div> : null}
      {list.isPending ? <p role="status">Loading approvals…</p> : null}
      {!list.isPending && !list.isError && interactions.length === 0 ? <div className="approval-empty"><ShieldCheck /><h2>No approval history</h2><p>No requests were found in this authorized scope.</p></div> : null}
      <ol className="approval-list" aria-label="Approval requests">{interactions.map((item) => <li key={item.id}><button type="button" className={selectedInteractionId === item.id ? 'selected' : ''} onClick={() => onSelectInteraction?.(item.id)}>
        <span className={`approval-state approval-state-${item.status}`}><StateIcon state={item.status} />{stateLabels[item.status]}</span><strong>{item.harness === 'codex' ? 'Codex' : 'OpenCode'} · {item.nativeRequestType}</strong>
        <small>Agent {item.requestingAgentId} · Run {item.runId}</small><span className="approval-handler">Handled by {item.approval.handler}</span>
      </button></li>)}</ol>
      {list.hasNextPage ? <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading more…' : 'Load more requests'}</button> : null}
      {list.isFetchNextPageError ? <p role="alert">The next page could not be loaded. Retry Load more requests.</p> : null}
    </div>
      {selectedInteractionId ? <ApprovalDetail key={`${workspaceId ?? 'all'}:${workflowId ?? 'all'}:${selectedInteractionId}`} interactionId={selectedInteractionId} workspaceId={workspaceId} workflowId={workflowId} onClear={() => onSelectInteraction?.(undefined)} />
        : <article className="approval-detail"><div className="approval-detail-placeholder"><Inbox /><h2>Select a request</h2><p>Inspect its scope, native choices and delivery history.</p></div></article>}
    </div>
  </section>
}
