import { useEffect, useMemo, useState } from 'react'
import type { DurableInteraction } from '@graphql/contracts'
import { RefreshCw } from 'lucide-react'
import { useInfiniteInteractionsQuery, useInteractionQuery, useWorkspaceDetailsQuery } from '../../shared/api/query'
import { sessionSignal } from '../../shared/api/sessionBoundary'
import { useUserInteractionResponse, type UserApprovalCredential } from '../../shared/api/userApprovals'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { Alert, Badge, Button, Dialog, ErrorState, Icon, IconButton, LoadingState } from '../../shared/ui/nocturne'
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
  const recorded = interaction.responseOptions.find((option) => option.optionId === interaction.selectedOptionId)
  const send = (optionId: string) => response.mutate({ interactionId: interaction.id, optionId, expectedRevision: interaction.revision }, { onSuccess: onChanged })
  return <div className="approval-row-actions" aria-label={`Respond to ${summarizeApprovalRequest(interaction.request, interaction.nativeRequestType).operation}`}>
    {interaction.status !== 'pending' && recorded ? <Button size="sm" disabled={response.isPending} loading={response.isPending}
      title="Retry or verify delivery of the recorded choice" onClick={() => send(recorded.optionId)}>{interaction.status === 'delivery_failed' ? 'Retry' : 'Check'}</Button> : null}
    {interaction.status === 'pending' && approve ? <Button size="sm" disabled={response.isPending} loading={response.isPending && response.variables?.optionId === approve.optionId}
      title={approvalOptionScope(approve)} onClick={() => send(approve.optionId)}>Approve</Button> : null}
    {interaction.status === 'pending' && reject ? <Button size="sm" variant="ghost" disabled={response.isPending} loading={response.isPending && response.variables?.optionId === reject.optionId}
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
    </button>
  </li>
}

function ApprovalInboxPanel({ open, exiting, resize }: {
  open: boolean
  exiting: boolean
  resize: ReturnType<typeof useApprovalInboxResize>
}) {
  const sidebarOpen = useApprovalInboxStore((state) => state.sidebarOpen)
  const workspaceId = useApprovalInboxStore((state) => state.workspaceId)
  const workflowId = useApprovalInboxStore((state) => state.workflowId)
  const interactionId = useApprovalInboxStore((state) => state.interactionId)
  const closeInbox = useApprovalInboxStore((state) => state.closeInbox)
  const setSidebarOpen = useApprovalInboxStore((state) => state.setSidebarOpen)
  const selectInteraction = useApprovalInboxStore((state) => state.selectInteraction)
  const sidebarPresence = usePresence(sidebarOpen)
  const { panelRef, style, moveGrip, grip } = resize
  const scope = { workspaceId: workspaceId || undefined, workflowId, limit: 100 }
  const queues = [
    useInfiniteInteractionsQuery({ ...scope, status: 'pending' }, open && Boolean(workspaceId)),
    useInfiniteInteractionsQuery({ ...scope, status: 'decided' }, open && Boolean(workspaceId)),
    useInfiniteInteractionsQuery({ ...scope, status: 'delivery_pending' }, open && Boolean(workspaceId)),
    useInfiniteInteractionsQuery({ ...scope, status: 'delivery_failed' }, open && Boolean(workspaceId)),
  ]
  const workspace = useWorkspaceDetailsQuery(workspaceId, { enabled: open && Boolean(workspaceId), retry: false })
  const [selectedAgentId, setSelectedAgentId] = useState<string>()
  const pages = queues.flatMap((queue) => queue.data?.pages ?? [])
  const interactions = useMemo(() => {
    const byId = new Map<string, DurableInteraction>()
    for (const page of pages) for (const item of page.items) {
      if (!['pending', 'decided', 'delivery_pending', 'delivery_failed'].includes(item.status)
        || item.approval.handler !== 'user' || !interactionMatchesScope(item, { workspaceId, workflowId })) continue
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
  const refetch = () => { for (const queue of queues) void queue.refetch() }
  const isError = queues.some((queue) => queue.isError)
  const isPending = queues.some((queue) => queue.isPending)
  const isFetching = queues.some((queue) => queue.isFetching)
  const selectedRequests = interactions.filter((item) => item.requestingAgentId === selectedAgentId)
  const selectedInteraction = interactions.find((item) => item.id === interactionId)
  const agentName = (agentId: string) => workspace.data?.agents.find((agent) => agent.id === agentId)?.name ?? 'Unknown agent'
  return <div className="approval-inbox-root">
    <section ref={panelRef} style={style} className="approval-inbox-panel" data-state={exiting ? 'closing' : 'open'} role="dialog" aria-modal="false" aria-label="Human approval inbox"
      aria-hidden={exiting} inert={exiting}
      onKeyDown={(event) => { if (event.key === 'Escape' && !interactionId) closeInbox() }}>
      {approvalResizeEdges.map((edge) => <button key={edge} type="button" className={`approval-inbox-resize approval-inbox-resize-${edge}`} {...grip(edge)} />)}
      <button type="button" className="approval-inbox-move" title="Drag to move approval inbox" {...moveGrip} />
      <div className="approval-inbox-controls">
        <IconButton label="Refresh approval requests" variant="ghost" disabled={isFetching} onClick={refetch}><RefreshCw aria-hidden="true" size={14} /></IconButton>
        <IconButton label="Close approval inbox" variant="ghost" onClick={closeInbox}><Icon name="close" /></IconButton>
      </div>
      <IconButton className={`approval-sidebar-toggle${sidebarOpen ? ' approval-sidebar-toggle-open' : ''}`}
        label={sidebarOpen ? 'Close agent sidebar' : 'Open agent sidebar'} variant="ghost" aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="chevron" /></IconButton>
      <div className="approval-inbox-body">
        {sidebarPresence.mounted ? <aside data-state={sidebarPresence.exiting ? 'closing' : 'open'} aria-label="Agents with human approval requests" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
          {agentIds.map((agentId) => <button key={agentId} type="button" aria-current={selectedAgentId === agentId ? 'true' : undefined} onClick={() => setSelectedAgentId(agentId)}>
            <span>{agentName(agentId)}</span><Badge tone="accent">{interactions.filter((item) => item.requestingAgentId === agentId).length}</Badge>
          </button>)}
        </aside> : null}
        <main>
          {isError ? <ErrorState title="Requests unavailable" description={queues.find((queue) => queue.error)?.error?.message ?? 'The request could not be loaded.'} onRetry={refetch} retrying={isFetching} /> : null}
          {isPending ? <LoadingState label="Loading human approvals…" rows={4} /> : null}
          {!isPending && !isError && interactions.length === 0 ? <p className="approval-empty">No requests yet.</p> : null}
          {selectedRequests.length ? <ol className="approval-request-list">{selectedRequests.map((interaction) => <RequestRow key={interaction.id} interaction={interaction} onChanged={refetch} onOpen={() => selectInteraction(interaction.id)} />)}</ol> : null}
          {queues.some((queue) => queue.hasNextPage) ? <Button size="sm" disabled={queues.some((queue) => queue.isFetchingNextPage)} loading={queues.some((queue) => queue.isFetchingNextPage)} onClick={() => {
            for (const queue of queues) if (queue.hasNextPage && !queue.isFetchingNextPage) void queue.fetchNextPage()
          }}>Load more</Button> : null}
          {queues.some((queue) => queue.isFetchNextPageError) ? <Alert live tone="danger" title="More requests could not be loaded">Try Load more again.</Alert> : null}
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
  const resize = useApprovalInboxResize()
  return presence.mounted ? <ApprovalInboxPanel open={open} exiting={presence.exiting} resize={resize} /> : null
}
