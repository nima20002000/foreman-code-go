import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, Inbox, ShieldCheck, XCircle } from 'lucide-react'
import type { ApprovalInboxView, DurableInteraction } from '@graphql/contracts'
import { Link } from '@tanstack/react-router'

import { useInteractionQuery, useInfiniteInteractionsQuery, useRespondToInteractionMutation, useWorkspaceDetailsQuery } from '../../shared/api/query'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { canRecoverInteraction, interactionMatchesScope } from './approvalState'
import { approvalReadOnlyReason, approvalStatuses, summarizeApprovalRequest } from './approvalPresentation'
import { ApprovalRequestSummary } from './ApprovalRequestSummary'
import './approvals.css'

export interface ApprovalInboxProps {
  workspaceId?: string
  workflowId?: string
  selectedInteractionId?: string
  onSelectInteraction?(interactionId?: string): void
  view?: ApprovalInboxView
  onChangeView?(view: ApprovalInboxView): void
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

function useApprovalNames(interaction: DurableInteraction) {
  const query = useWorkspaceDetailsQuery(interaction.workspaceId, { retry: false })
  const context = !query.isError && query.data?.workspace.id === interaction.workspaceId ? query.data : undefined
  return {
    workspace: context?.workspace.name ?? 'Workspace name unavailable',
    workflow: context?.workflows.find((workflow) => workflow.id === interaction.workflowId)?.name ?? 'Workflow name unavailable',
    agent: context?.agents.find((agent) => agent.id === interaction.requestingAgentId)?.name ?? 'Agent name unavailable',
  }
}

function ApprovalNames({ interaction }: { interaction: DurableInteraction }) {
  const names = useApprovalNames(interaction)
  return <dl className="approval-context">
    <div><dt>Requesting agent</dt><dd>{names.agent}</dd></div>
    <div><dt>Workflow</dt><dd><Link to="/workspaces/$workspaceId" params={{ workspaceId: interaction.workspaceId }} search={{ workflowId: interaction.workflowId }}>{names.workflow} · Open workflow</Link></dd></div>
    <div><dt>Workspace</dt><dd>{names.workspace}</dd></div>
    <div><dt>Assigned reviewer</dt><dd>{interaction.approval.handler === 'user' ? 'User' : interaction.approval.handler === 'operator' ? 'Operator agent' : 'Orchestrator agent'}</dd></div>
  </dl>
}

function ApprovalDetail({ interactionId, workspaceId, workflowId, onClear }: {
  interactionId: string; workspaceId?: string; workflowId?: string; onClear(): void
}) {
  const detail = useInteractionQuery(interactionId)
  const respond = useRespondToInteractionMutation()
  const [attempt] = useState(() => new CommandAttempt<ResponseInput>())
  const [retryInput, setRetryInput] = useState<ResponseInput>()
  const inFlight = useRef(false)
  // Never authorize a response from stale detail after an access/error response.
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
  const readOnlyReason = approvalReadOnlyReason(selected, detail.data.canRespond === true)
  return <article className="approval-detail">
    <header><div><p className="panel-kicker">{selected.harness === 'codex' ? 'Codex' : 'OpenCode'} permission request</p><h2>{summarizeApprovalRequest(selected.request, selected.nativeRequestType).operation}</h2></div><span className={`approval-state approval-state-${selected.status}`}><StateIcon state={selected.status} />{stateLabels[selected.status]}</span></header>
    <ApprovalNames interaction={selected} />
    <ApprovalRequestSummary request={selected.request} nativeRequestType={selected.nativeRequestType} />
    <details className="approval-request"><summary>Technical details</summary>
      <dl className="approval-context">
        <div><dt>Workspace ID</dt><dd>{selected.workspaceId}</dd></div><div><dt>Workflow ID</dt><dd>{selected.workflowId}</dd></div>
        <div><dt>Requesting agent ID</dt><dd>{selected.requestingAgentId}</dd></div><div><dt>Run / execution IDs</dt><dd>{selected.runId} / {selected.executionId}</dd></div>
        <div><dt>Native request type</dt><dd>{selected.nativeRequestType}</dd></div><div><dt>Provider version</dt><dd>{selected.providerVersion}</dd></div>
        <div><dt>Accepted handler</dt><dd>{selected.approval.handler}{selected.approval.designatedOrchestratorAgentId ? ` · ${selected.approval.designatedOrchestratorAgentId}` : ''}</dd></div>
        <div><dt>Native delivery</dt><dd>{selected.deliveryState.replaceAll('_', ' ')}</dd></div>
      </dl>
      <h3>Request details</h3><pre>{JSON.stringify(selected.request, null, 2)}</pre>
    </details>
    {readOnlyReason ? <p className="approval-reviewer-note">{readOnlyReason}</p> : null}
    {canRespond && selected.status === 'pending' && !retryInput ? <div className="approval-actions"><h3>Response</h3><div>
      {selected.responseOptions.map((option) => <button key={option.optionId} type="button" disabled={respond.isPending} className={option.semantic === 'reject' || option.semantic === 'cancel' ? 'danger' : ''} onClick={() => send(option.optionId)}>
        <strong>{option.label}</strong><small>{option.scopeSummary ?? `Applies to: ${option.persistence}`}{option.mutatesPersistentPolicy ? ' — changes persistent native policy' : ''}</small>
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

function ApprovalListItem({ item, selected, onSelect }: { item: DurableInteraction; selected: boolean; onSelect(button: HTMLButtonElement): void }) {
  const names = useApprovalNames(item)
  return <li><button type="button" className={selected ? 'selected' : ''} aria-current={selected ? 'true' : undefined} onClick={(event) => onSelect(event.currentTarget)}>
    <span className={`approval-state approval-state-${item.status}`}><StateIcon state={item.status} />{stateLabels[item.status]}</span>
    <strong>{names.agent} · {summarizeApprovalRequest(item.request, item.nativeRequestType).operation}</strong>
    <small>{names.workflow}</small><span className="approval-handler">Handled by {item.approval.handler}</span>
  </button></li>
}

export function ApprovalInbox({ workspaceId, workflowId, selectedInteractionId, onSelectInteraction, view = 'pending', onChangeView }: ApprovalInboxProps) {
  // Each status has its own server cursor. Never filter only the first 100 historical records.
  const scope = { workspaceId, workflowId, limit: 100 }
  const queues = {
    pending: useInfiniteInteractionsQuery({ ...scope, status: 'pending' }, view === 'pending'),
    decided: useInfiniteInteractionsQuery({ ...scope, status: 'decided' }, view === 'delivery'),
    delivery_pending: useInfiniteInteractionsQuery({ ...scope, status: 'delivery_pending' }, view === 'delivery'),
    delivery_failed: useInfiniteInteractionsQuery({ ...scope, status: 'delivery_failed' }, view === 'delivery'),
    delivered: useInfiniteInteractionsQuery({ ...scope, status: 'delivered' }, view === 'history'),
    canceled: useInfiniteInteractionsQuery({ ...scope, status: 'canceled' }, view === 'history'),
  }
  const statuses = approvalStatuses(view)
  const activeQueues = statuses.map((status) => queues[status])
  const pages = activeQueues.flatMap((queue) => queue.data?.pages ?? [])
  const isError = activeQueues.some((queue) => queue.isError)
  const isPending = activeQueues.some((queue) => queue.isPending)
  const byId = new Map<string, DurableInteraction>()
  for (const page of pages) for (const item of page.items) {
    if (!interactionMatchesScope(item, { workspaceId, workflowId })) continue
    const current = byId.get(item.id)
    if (!current || item.revision >= current.revision) byId.set(item.id, item)
  }
  const interactions = [...byId.values()].filter((item) => statuses.includes(item.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  const pendingCount = pages.find((page) => page.pendingCount !== undefined)?.pendingCount
  const detailPanel = useRef<HTMLDivElement>(null)
  const listPanel = useRef<HTMLDivElement>(null)
  const selectionTrigger = useRef<HTMLButtonElement | null>(null)
  const previousId = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (selectedInteractionId) {
      if (detailPanel.current) detailPanel.current.scrollTop = 0
      detailPanel.current?.focus({ preventScroll: true })
      detailPanel.current?.scrollIntoView?.({ block: 'nearest' })
    } else if (previousId.current) {
      const target = selectionTrigger.current?.isConnected ? selectionTrigger.current : listPanel.current
      target?.focus()
    }
    previousId.current = selectedInteractionId
  }, [selectedInteractionId, workspaceId, workflowId])
  useEffect(() => {
    if (!selectedInteractionId || !window.matchMedia) return
    const media = window.matchMedia('(max-width: 760px)')
    const reveal = () => { if (media.matches) detailPanel.current?.focus() }
    media.addEventListener('change', reveal)
    return () => media.removeEventListener('change', reveal)
  }, [selectedInteractionId])
  const changeView = (next: ApprovalInboxView) => onChangeView?.(next)
  return <section className="approval-inbox" aria-labelledby="approval-inbox-title">
    <header className="approval-inbox-header"><div><p className="panel-kicker">Review queue</p><h1 id="approval-inbox-title">Approval Inbox</h1><p>{workflowId ? 'Requests for this workflow.' : workspaceId ? 'Requests across this workspace.' : 'Requests across every authorized workspace.'}</p></div>
      <button type="button" className="approval-count" onClick={() => changeView('pending')}><Inbox size={17} />{pendingCount === undefined || isError ? 'Pending count unavailable' : `${pendingCount} pending`}</button></header>
    <nav className="approval-filters" aria-label="Approval views">
      {(['pending', 'delivery', 'history'] as const).map((item) => <button type="button" key={item} aria-pressed={view === item} onClick={() => changeView(item)}>{item === 'pending' ? 'Pending' : item === 'delivery' ? 'Delivery problems' : 'History'}</button>)}
    </nav>
    <div className="approval-layout" data-has-selection={Boolean(selectedInteractionId)}>
      <div ref={listPanel} tabIndex={-1} className="approval-list-pane" aria-label="Request list">
        {view === 'delivery' ? <p>Recorded decisions awaiting delivery, reconciliation, or retry.</p> : null}
        {isError ? <div className="approval-empty" role="alert"><AlertTriangle /><h2>Inbox refresh failed</h2><p>Available requests are preserved. {activeQueues.find((queue) => queue.error)?.error?.message}</p><button type="button" onClick={() => { for (const queue of activeQueues) void queue.refetch() }}>Retry Inbox</button></div> : null}
        {isPending ? <p role="status">Loading approvals…</p> : null}
        {!isPending && !isError && interactions.length === 0 ? <div className="approval-empty"><ShieldCheck /><h2>{view === 'pending' ? 'No pending requests' : view === 'delivery' ? 'No delivery problems' : 'No approval history'}</h2><p>No matching requests were found in this authorized scope.</p></div> : null}
        <ol className="approval-list" aria-label="Approval requests">{interactions.map((item) => <ApprovalListItem key={item.id} item={item} selected={selectedInteractionId === item.id} onSelect={(button) => { selectionTrigger.current = button; onSelectInteraction?.(item.id) }} />)}</ol>
        {activeQueues.some((queue) => queue.hasNextPage) ? <button type="button" disabled={activeQueues.some((queue) => queue.isFetchingNextPage)} onClick={() => { for (const queue of activeQueues) if (queue.hasNextPage && !queue.isFetchingNextPage) void queue.fetchNextPage() }}>{activeQueues.some((queue) => queue.isFetchingNextPage) ? 'Loading more…' : 'Load more requests'}</button> : null}
        {activeQueues.some((queue) => queue.isFetchNextPageError) ? <p role="alert">The next page could not be loaded. Retry Load more requests.</p> : null}
      </div>
      <div ref={detailPanel} tabIndex={-1} className="approval-detail-pane" aria-label="Selected request details">
        {selectedInteractionId ? <><button type="button" className="approval-back" onClick={() => onSelectInteraction?.(undefined)}>Back to requests</button><ApprovalDetail key={`${workspaceId ?? 'all'}:${workflowId ?? 'all'}:${selectedInteractionId}`} interactionId={selectedInteractionId} workspaceId={workspaceId} workflowId={workflowId} onClear={() => onSelectInteraction?.(undefined)} /></>
          : <article className="approval-detail"><div className="approval-detail-placeholder"><Inbox /><h2>Select a request</h2><p>Inspect its scope, native choices and delivery history.</p></div></article>}
      </div>
    </div>
  </section>
}
