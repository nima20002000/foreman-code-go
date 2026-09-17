import { useEffect, useRef } from 'react'
import type { ApprovalInboxView, DurableInteraction } from '@graphql/contracts'
import { Link } from '@tanstack/react-router'

import { useInteractionQuery, useInfiniteInteractionsQuery, useWorkspaceDetailsQuery } from '../../shared/api/query'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { Alert, Badge, Button, EmptyState, ErrorState, Icon, LoadingState, PageHeader } from '../../shared/ui/nocturne'
import { interactionMatchesScope } from './approvalState'
import { UserApprovalResponse } from './UserApprovalResponse'
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
function StateBadge({ state }: { state: keyof typeof stateLabels }) {
  const tone = state === 'delivered' ? 'success' : state === 'delivery_failed' || state === 'canceled' ? 'danger' : 'warning'
  return <Badge className={`approval-state approval-state-${state}`} tone={tone} dot>{stateLabels[state]}</Badge>
}

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
  // Never authorize a response from stale detail after an access/error response.
  if (detail.isError) return <article className="approval-detail"><ErrorState title="Request unavailable" description={detail.error.message} onRetry={() => void detail.refetch()} retrying={detail.isFetching} /></article>
  if (detail.isPending || !detail.data) return <article className="approval-detail"><LoadingState label="Loading request…" rows={4} /></article>
  const selected = detail.data.interaction
  if (selected.id !== interactionId || !interactionMatchesScope(selected, { workspaceId, workflowId })) {
    return <article className="approval-detail"><ErrorState title="Request outside this Inbox" description="This request is outside the selected Inbox scope." /><Button onClick={onClear}>Clear selection</Button></article>
  }
  const selectedOption = selected.responseOptions.find((option) => option.optionId === selected.selectedOptionId)
  const selectedLabel = selectedOption?.label
  const readOnlyReason = approvalReadOnlyReason(selected, false)
  return <article className="approval-detail">
    <header><div><p className="panel-kicker">{selected.harness === 'codex' ? 'Codex' : 'OpenCode'} permission request</p><h2>{summarizeApprovalRequest(selected.request, selected.nativeRequestType).operation}</h2></div><StateBadge state={selected.status} /></header>
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
    {selected.approval.handler === 'user' ? <UserApprovalResponse key={selected.id} interaction={selected}
      onChanged={() => { void detail.refetch() }} /> : null}
    {selected.selectedOptionId ? <div className="approval-history"><h3>Decision history</h3><p><strong>{selectedLabel ?? selected.selectedOptionId}</strong> accepted at {selected.decidedAt ?? 'unknown time'}.</p>{selectedOption ? <p>{approvalOptionScope(selectedOption)}</p> : null}<p>Delivery: {selected.deliveryState.replaceAll('_', ' ')}{selected.deliveredAt ? ` at ${selected.deliveredAt}` : ''}.</p></div> : null}
    <Button variant="ghost" leading={<Icon name="refresh" size={15} />} onClick={() => void detail.refetch()}>Refresh request</Button>
  </article>
}

function ApprovalListItem({ item, selected, onSelect }: { item: DurableInteraction; selected: boolean; onSelect(button: HTMLButtonElement): void }) {
  const names = useApprovalNames(item)
  return <li><button type="button" className={selected ? 'selected' : ''} aria-current={selected ? 'true' : undefined} onClick={(event) => onSelect(event.currentTarget)}>
    <StateBadge state={item.status} />
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
  return <section className="approval-inbox" aria-label="Approval Inbox">
    <PageHeader eyebrow="Review queue" title="Approval Inbox" description={workflowId ? 'Requests for this workflow.' : workspaceId ? 'Requests across this workspace.' : 'Requests across every authorized workspace.'} actions={
      <Button variant="secondary" className="approval-count" leading={<Icon name="shield" size={17} />} onClick={() => changeView('pending')}>{pendingCount === undefined || isError ? 'Pending count unavailable' : `${pendingCount} pending`}</Button>
    } />
    <nav className="approval-filters" aria-label="Approval views">
      {(['pending', 'delivery', 'history'] as const).map((item) => <Button variant={view === item ? 'primary' : 'secondary'} size="sm" key={item} aria-pressed={view === item} onClick={() => changeView(item)}>{item === 'pending' ? 'Pending' : item === 'delivery' ? 'Delivery problems' : 'History'}</Button>)}
    </nav>
    <div className="approval-layout" data-has-selection={Boolean(selectedInteractionId)}>
      <div ref={listPanel} tabIndex={-1} className="approval-list-pane" aria-label="Request list">
        {view === 'delivery' ? <p>Recorded decisions awaiting delivery, reconciliation, or retry.</p> : null}
        {isError ? <ErrorState title="Inbox refresh failed" description={`Available requests are preserved. ${activeQueues.find((queue) => queue.error)?.error?.message ?? ''}`} onRetry={() => { for (const queue of activeQueues) void queue.refetch() }} retrying={activeQueues.some((queue) => queue.isFetching)} /> : null}
        {isPending ? <LoadingState label="Loading approvals…" rows={4} /> : null}
        {!isPending && !isError && interactions.length === 0 ? <EmptyState icon="shield" title={view === 'pending' ? 'No pending requests' : view === 'delivery' ? 'No delivery problems' : 'No approval history'} description="No matching requests were found in this authorized scope." /> : null}
        <ol className="approval-list" aria-label="Approval requests">{interactions.map((item) => <ApprovalListItem key={item.id} item={item} selected={selectedInteractionId === item.id} onSelect={(button) => { selectionTrigger.current = button; onSelectInteraction?.(item.id) }} />)}</ol>
        {activeQueues.some((queue) => queue.hasNextPage) ? <Button disabled={activeQueues.some((queue) => queue.isFetchingNextPage)} loading={activeQueues.some((queue) => queue.isFetchingNextPage)} loadingLabel="Loading more…" onClick={() => { for (const queue of activeQueues) if (queue.hasNextPage && !queue.isFetchingNextPage) void queue.fetchNextPage() }}>Load more requests</Button> : null}
        {activeQueues.some((queue) => queue.isFetchNextPageError) ? <Alert live tone="danger" title="The next page could not be loaded">Retry Load more requests.</Alert> : null}
      </div>
      <div ref={detailPanel} tabIndex={-1} className="approval-detail-pane" aria-label="Selected request details">
        {selectedInteractionId ? <><Button variant="ghost" className="approval-back" onClick={() => onSelectInteraction?.(undefined)}>Back to requests</Button><ApprovalDetail key={`${workspaceId ?? 'all'}:${workflowId ?? 'all'}:${selectedInteractionId}`} interactionId={selectedInteractionId} workspaceId={workspaceId} workflowId={workflowId} onClear={() => onSelectInteraction?.(undefined)} /></>
          : <article className="approval-detail"><EmptyState icon="shield" title="Select a request" description="Inspect its scope, native choices and delivery history." /></article>}
      </div>
    </div>
  </section>
}
