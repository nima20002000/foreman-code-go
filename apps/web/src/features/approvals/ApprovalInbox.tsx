import { AlertTriangle, CheckCircle2, Clock3, Inbox, ShieldCheck, XCircle } from 'lucide-react'

import { useInteractionQuery, useInteractionsQuery, useRespondToInteractionMutation } from '../../shared/api/query'
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

export function ApprovalInbox({ workspaceId, workflowId, selectedInteractionId, onSelectInteraction }: ApprovalInboxProps) {
  const list = useInteractionsQuery({ limit: 100 })
  const detail = useInteractionQuery(selectedInteractionId)
  const respond = useRespondToInteractionMutation()
  const interactions = (list.data?.items ?? []).filter((item) =>
    (!workspaceId || item.workspaceId === workspaceId) && (!workflowId || item.workflowId === workflowId))
  const selected = detail.data?.interaction ?? interactions.find((item) => item.id === selectedInteractionId)
  const pendingCount = interactions.filter((item) => item.status === 'pending').length

  return <section className="approval-inbox" aria-labelledby="approval-inbox-title">
    <header className="approval-inbox-header"><div><p className="panel-kicker">Review queue</p><h1 id="approval-inbox-title">Approval Inbox</h1><p>{workflowId ? 'Requests for this workflow.' : workspaceId ? 'Requests across this workspace.' : 'Requests across every authorized workspace.'}</p></div>
      <span className="approval-count" aria-label={`${pendingCount} pending approvals`}><Inbox size={17} />{pendingCount} pending</span></header>
    {list.isError ? <div className="approval-empty" role="alert"><AlertTriangle /><h2>Inbox unavailable</h2><p>{list.error.message}</p></div> : null}
    {list.isPending ? <p className="approval-loading" role="status">Loading approvals…</p> : null}
    {!list.isPending && !list.isError && interactions.length === 0 ? <div className="approval-empty"><ShieldCheck /><h2>No approval history</h2><p>Waiting requests and their delivery history will appear here.</p></div> : null}
    {interactions.length > 0 ? <div className="approval-layout">
      <ol className="approval-list" aria-label="Approval requests">
        {interactions.map((item) => <li key={item.id}><button type="button" className={selectedInteractionId === item.id ? 'selected' : ''} onClick={() => onSelectInteraction?.(item.id)}>
          <span className={`approval-state approval-state-${item.status}`}><StateIcon state={item.status} />{stateLabels[item.status]}</span>
          <strong>{item.harness === 'codex' ? 'Codex' : 'OpenCode'} · {item.nativeRequestType}</strong>
          <small>Agent {item.requestingAgentId} · Run {item.runId}</small>
          <span className="approval-handler">Handled by {item.approval.handler}</span>
        </button></li>)}
      </ol>
      <article className="approval-detail">
        {!selected ? <div className="approval-detail-placeholder"><Inbox /><h2>Select a request</h2><p>Inspect its scope, native choices and delivery history.</p></div> : <>
          <header><div><p className="panel-kicker">{selected.harness} {selected.providerVersion}</p><h2>{selected.nativeRequestType}</h2></div><span className={`approval-state approval-state-${selected.status}`}><StateIcon state={selected.status} />{stateLabels[selected.status]}</span></header>
          <dl className="approval-context">
            <div><dt>Workspace</dt><dd>{selected.workspaceId}</dd></div><div><dt>Workflow</dt><dd>{selected.workflowId}</dd></div>
            <div><dt>Requesting Agent</dt><dd>{selected.requestingAgentId}</dd></div><div><dt>Run / execution</dt><dd>{selected.runId} / {selected.executionId}</dd></div>
            <div><dt>Accepted handler</dt><dd>{selected.approval.handler}{selected.approval.designatedOrchestratorAgentId ? ` · ${selected.approval.designatedOrchestratorAgentId}` : ''}</dd></div>
            <div><dt>Native delivery</dt><dd>{selected.deliveryState.replace('_', ' ')}</dd></div>
          </dl>
          <div className="approval-request"><h3>Request details</h3><pre>{JSON.stringify(selected.request, null, 2)}</pre></div>
          {selected.approval.handler !== 'user' && selected.status === 'pending' ? <p className="approval-reviewer-note">This request is assigned to the configured {selected.approval.handler}. Human response is unavailable to prevent a competing decision.</p> : null}
          {selected.status === 'pending' && selected.approval.handler === 'user' ? <div className="approval-actions"><h3>Response</h3><div>
            {selected.responseOptions.map((option) => <button key={option.optionId} type="button" disabled={respond.isPending} className={option.semantic === 'reject' || option.semantic === 'cancel' ? 'danger' : ''} onClick={() => respond.mutate({ interactionId: selected.id, optionId: option.optionId, expectedRevision: selected.revision })}>
              <strong>{option.label}</strong>{option.scopeSummary ? <small>{option.scopeSummary}</small> : null}
            </button>)}
          </div>{selected.responseOptions.some((option) => option.affectsOtherPendingRequests) ? <p className="approval-warning"><AlertTriangle size={15} />A provider choice may affect other pending requests. Review its scope before responding.</p> : null}</div> : null}
          {selected.selectedOptionId ? <div className="approval-history"><h3>Decision history</h3><p><strong>{selected.responseOptions.find((option) => option.optionId === selected.selectedOptionId)?.label ?? selected.selectedOptionId}</strong> accepted at {selected.decidedAt ?? 'unknown time'}.</p><p>Delivery: {selected.deliveryState.replace('_', ' ')}{selected.deliveredAt ? ` at ${selected.deliveredAt}` : ''}.</p></div> : null}
          {respond.isError ? <p className="approval-warning" role="alert"><AlertTriangle size={15} />{respond.error.message} Refresh before trying another choice.</p> : null}
        </>}
      </article>
    </div> : null}
  </section>
}
