import { useEffect, useMemo, useState } from 'react'
import type { DurableInteraction } from '@graphql/contracts'
import { useInfiniteInteractionsQuery, useInteractionQuery, useWorkspaceDetailsQuery } from '../../shared/api/query'
import { sessionSignal } from '../../shared/api/sessionBoundary'
import { useUserInteractionResponse, type UserApprovalCredential } from '../../shared/api/userApprovals'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { Alert, Badge, Button, Dialog, EmptyState, ErrorState, Icon, IconButton, LoadingState } from '../../shared/ui/nocturne'
import { usePresence } from '../../shared/ui/usePresence'
import { interactionMatchesScope } from './approvalState'
import { UserApprovalResponse } from './UserApprovalResponse'
import { summarizeApprovalRequest } from './approvalPresentation'
import { ApprovalRequestSummary } from './ApprovalRequestSummary'
import { approvalResizeEdges, useApprovalInboxResize } from './useApprovalInboxResize'
import { useApprovalInboxStore } from './approvalInboxStore'
import './approvals.css'

const credential = (): UserApprovalCredential => ({ id: 'browser-user', signal: sessionSignal() })

function ApprovalContext({ interaction }: { interaction: DurableInteraction }) {
  const query = useWorkspaceDetailsQuery(interaction.workspaceId, { retry: false })
  const context = !query.isError && query.data?.workspace.id === interaction.workspaceId ? query.data : undefined
  const agent = context?.agents.find((item) => item.id === interaction.requestingAgentId)?.name ?? 'Unknown agent'
  const workflow = context?.workflows.find((item) => item.id === interaction.workflowId)?.name
  return <p className="approval-detail-context">Requested by <strong>{agent}</strong>{workflow ? ` in ${workflow}` : ''} · {interaction.harness === 'codex' ? 'Codex' : 'OpenCode'}</p>
}

function ApprovalDetail({ interactionId, workspaceId, workflowId, onChanged }: {
  interactionId: string; workspaceId: string; workflowId?: string; onChanged(): void
}) {
  const detail = useInteractionQuery(interactionId)
  if (detail.isError) return <ErrorState title="Request unavailable" description={detail.error.message} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
  if (detail.isPending || !detail.data) return <LoadingState label="Loading request…" rows={4} />
  const selected = detail.data.interaction
  if (selected.id !== interactionId || selected.approval.handler !== 'user' || !interactionMatchesScope(selected, { workspaceId, workflowId })) {
    return <ErrorState title="Request unavailable here" description="This is not a human approval request in the current board scope." />
  }
  const selectedOption = selected.responseOptions.find((option) => option.optionId === selected.selectedOptionId)
  return <article className="approval-detail">
    <ApprovalContext interaction={selected} />
    <ApprovalRequestSummary request={selected.request} nativeRequestType={selected.nativeRequestType} reviewContext={selected.reviewContext} />
    <UserApprovalResponse key={selected.id} interaction={selected} onChanged={() => { void detail.refetch(); onChanged() }} />
    {selected.selectedOptionId ? <div className="approval-history"><h3>Recorded choice</h3><p><strong>{selectedOption?.label ?? selected.selectedOptionId}</strong>{selected.decidedAt ? ` · ${new Date(selected.decidedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</p>{selectedOption ? <p>{approvalOptionScope(selectedOption)}</p> : null}</div> : null}
  </article>
}

function QuickApprovalActions({ interaction, onChanged }: { interaction: DurableInteraction; onChanged(): void }) {
  const [userCredential] = useState(credential)
  const response = useUserInteractionResponse(userCredential)
  const approve = interaction.responseOptions.find((option) => option.semantic === 'approve_once')
    ?? interaction.responseOptions.find((option) => option.semantic === 'allow_turn')
  const reject = interaction.responseOptions.find((option) => option.semantic === 'reject')
    ?? interaction.responseOptions.find((option) => option.semantic === 'cancel')
  const send = (optionId: string) => response.mutate({ interactionId: interaction.id, optionId, expectedRevision: interaction.revision }, { onSuccess: onChanged })
  return <div className="approval-row-actions" aria-label={`Respond to ${summarizeApprovalRequest(interaction.request, interaction.nativeRequestType).operation}`}>
    {approve ? <Button size="sm" disabled={response.isPending} loading={response.isPending && response.variables?.optionId === approve.optionId}
      title={approvalOptionScope(approve)} onClick={() => send(approve.optionId)}>Approve</Button> : null}
    {reject ? <Button size="sm" variant="ghost" disabled={response.isPending} loading={response.isPending && response.variables?.optionId === reject.optionId}
      title={`${reject.scopeSummary ? `${reject.scopeSummary}. ` : ''}${approvalOptionScope(reject)}`} onClick={() => send(reject.optionId)}>Reject</Button> : null}
    {response.isError ? <span role="alert" className="approval-row-error">{response.error.message}</span> : null}
  </div>
}

function RequestRow({ interaction, onOpen, onChanged }: { interaction: DurableInteraction; onOpen(): void; onChanged(): void }) {
  const summary = summarizeApprovalRequest(interaction.request, interaction.nativeRequestType)
  return <li className="approval-request-row">
    <QuickApprovalActions interaction={interaction} onChanged={onChanged} />
    <button type="button" className="approval-request-open" onClick={onOpen} aria-haspopup="dialog">
      <strong>{summary.operation}</strong>
      <span>{summary.command ?? summary.target ?? summary.explanation ?? 'Open request details'}</span>
      <small>{interaction.harness === 'codex' ? 'Codex' : 'OpenCode'} · {new Date(interaction.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
    </button>
  </li>
}

function ApprovalInboxPanel({ open, exiting }: { open: boolean; exiting: boolean }) {
  const sidebarOpen = useApprovalInboxStore((state) => state.sidebarOpen)
  const workspaceId = useApprovalInboxStore((state) => state.workspaceId)
  const workflowId = useApprovalInboxStore((state) => state.workflowId)
  const interactionId = useApprovalInboxStore((state) => state.interactionId)
  const closeInbox = useApprovalInboxStore((state) => state.closeInbox)
  const setSidebarOpen = useApprovalInboxStore((state) => state.setSidebarOpen)
  const selectInteraction = useApprovalInboxStore((state) => state.selectInteraction)
  const { panelRef, style, moveGrip, grip } = useApprovalInboxResize()
  const queue = useInfiniteInteractionsQuery({ workspaceId: workspaceId || undefined, workflowId, status: 'pending', limit: 100 }, open && Boolean(workspaceId))
  const workspace = useWorkspaceDetailsQuery(workspaceId, { enabled: open && Boolean(workspaceId), retry: false })
  const [selectedAgentId, setSelectedAgentId] = useState<string>()
  const pages = queue.data?.pages ?? []
  const interactions = useMemo(() => {
    const byId = new Map<string, DurableInteraction>()
    for (const page of pages) for (const item of page.items) {
      if (item.status !== 'pending' || item.approval.handler !== 'user' || !interactionMatchesScope(item, { workspaceId, workflowId })) continue
      const current = byId.get(item.id)
      if (!current || item.revision >= current.revision) byId.set(item.id, item)
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }, [pages, workspaceId, workflowId])
  const agentIds = useMemo(() => [...new Set(interactions.map((item) => item.requestingAgentId))], [interactions])
  useEffect(() => {
    if (!open) return
    if (!selectedAgentId || !agentIds.includes(selectedAgentId)) setSelectedAgentId(agentIds[0])
  }, [agentIds, open, selectedAgentId])
  const refetch = () => void queue.refetch()
  const selectedRequests = interactions.filter((item) => item.requestingAgentId === selectedAgentId)
  const selectedInteraction = interactions.find((item) => item.id === interactionId)
  const agentName = (agentId: string) => workspace.data?.agents.find((agent) => agent.id === agentId)?.name ?? 'Unknown agent'
  return <div className="approval-inbox-root">
    <section ref={panelRef} style={style} className="approval-inbox-panel" data-state={exiting ? 'closing' : 'open'} role="dialog" aria-modal="false" aria-label="Human approval inbox"
      aria-hidden={exiting} inert={exiting}
      onKeyDown={(event) => { if (event.key === 'Escape' && !interactionId) closeInbox() }}>
      {approvalResizeEdges.map((edge) => <button key={edge} type="button" className={`approval-inbox-resize approval-inbox-resize-${edge}`} {...grip(edge)} />)}
      <div className="approval-inbox-navigation">
        <IconButton label={sidebarOpen ? 'Close agent sidebar' : 'Open agent sidebar'} variant="ghost" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="menu" /></IconButton>
        <button type="button" className="approval-inbox-move" title="Drag to move approval inbox" {...moveGrip}><span aria-hidden="true" /></button>
        <IconButton label="Close approval inbox" variant="ghost" onClick={closeInbox}><Icon name="close" /></IconButton>
      </div>
      <div className={`approval-inbox-body${sidebarOpen ? ' approval-inbox-sidebar-open' : ''}`}>
        <aside aria-label="Agents with human approval requests" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
          <p>Agents</p>
          {agentIds.map((agentId) => <button key={agentId} type="button" aria-current={selectedAgentId === agentId ? 'true' : undefined} onClick={() => setSelectedAgentId(agentId)}>
            <span>{agentName(agentId)}</span><Badge tone="accent">{interactions.filter((item) => item.requestingAgentId === agentId).length}</Badge>
          </button>)}
        </aside>
        <main>
          <header><div><p className="panel-kicker">Human review</p><h2>{selectedAgentId ? agentName(selectedAgentId) : 'Approval requests'}</h2></div>
            <IconButton label="Refresh approval requests" variant="ghost" disabled={queue.isFetching} onClick={refetch}><Icon name="refresh" /></IconButton></header>
          {queue.isError ? <ErrorState title="Requests unavailable" description={queue.error.message} onRetry={refetch} retrying={queue.isFetching} /> : null}
          {queue.isPending ? <LoadingState label="Loading human approvals…" rows={4} /> : null}
          {!queue.isPending && !queue.isError && interactions.length === 0 ? <EmptyState icon="shield" title="No human approvals waiting" description="Requests assigned to agents or the Operator are not shown here." /> : null}
          {selectedRequests.length ? <ol className="approval-request-list">{selectedRequests.map((interaction) => <RequestRow key={interaction.id} interaction={interaction} onChanged={refetch} onOpen={() => selectInteraction(interaction.id)} />)}</ol> : null}
          {queue.hasNextPage ? <Button size="sm" disabled={queue.isFetchingNextPage} loading={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>Load more</Button> : null}
          {queue.isFetchNextPageError ? <Alert live tone="danger" title="More requests could not be loaded">Try Load more again.</Alert> : null}
        </main>
      </div>
    </section>
    <Dialog open={Boolean(interactionId)} onOpenChange={(next) => { if (!next) selectInteraction(undefined) }}
      title={selectedInteraction ? summarizeApprovalRequest(selectedInteraction.request, selectedInteraction.nativeRequestType).operation : 'Approval request'}
      size="md" closeOnOutsideClick className="approval-detail-dialog">
      {interactionId ? <ApprovalDetail interactionId={interactionId} workspaceId={workspaceId} workflowId={workflowId} onChanged={refetch} /> : null}
    </Dialog>
  </div>
}

export function ApprovalInbox() {
  const open = useApprovalInboxStore((state) => state.open)
  const presence = usePresence(open)
  return presence.mounted ? <ApprovalInboxPanel open={open} exiting={presence.exiting} /> : null
}
