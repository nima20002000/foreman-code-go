import type { RunGraphCurrentState } from '@graphql/contracts/wave25'
import type { RunGraphRecord } from './types'

type Interaction = RunGraphCurrentState['interactions'][number]
type Review = RunGraphCurrentState['reviews'][number]
type Binding = RunGraphCurrentState['inputBindings'][number]
export type ExchangeKey = `interaction:${string}` | `review:${string}` | `binding:${string}`
export type ExchangeView = {
  key: ExchangeKey
  title: string
  relationshipId?: string
  from: string
  to: string
  nodeIds: readonly string[]
  fields: readonly { label: string; value: string }[]
}
const deliveryLabels: Record<Interaction['deliveryState'], string> = {
  not_started: 'Not started', pending: 'Pending delivery', submitted: 'Submitted; receipt not confirmed',
  uncertain: 'Delivery uncertain; checking evidence', delivered: 'Native delivery confirmed', failed: 'Delivery failed',
}
const canceledDeliveryUnconfirmed = (item: Interaction) => item.status === 'canceled'
  && item.deliveryState === 'failed' && item.resumeState === 'unknown'
const resumeLabels: Record<Interaction['resumeState'], string> = {
  not_started: 'Not started', pending: 'Pending; not acknowledged', unknown: 'Resumption unavailable', acknowledged: 'Resumption acknowledged',
}
const reviewLabels: Record<Review['state'], string> = {
  pending: 'Review pending', leased: 'Review claimed; not acknowledged', submitted: 'Review submitted; not acknowledged',
  acknowledged: 'Review acknowledged', completed: 'Review settled', blocked_busy: 'Reviewer busy',
  blocked_disconnected: 'Reviewer disconnected', uncertain: 'Review uncertain', failed: 'Review failed',
}
const decisionLabels: Record<NonNullable<Interaction['decision']>, string> = {
  approve_once: 'Approve once', allow_turn: 'Allow turn', allow_session: 'Allow session', reject: 'Reject', cancel: 'Cancel',
  provider_scoped_allow: 'Provider-scoped allowance', persistent_policy_change: 'Persistent policy change',
}
function label<T extends string>(labels: Record<T, string>, value: T | undefined, fallback: string): string {
  return value !== undefined && Object.hasOwn(labels, value) ? labels[value] : fallback
}
const field = (label: string, value: string) => ({ label, value })

export function presentInteraction(item: Interaction): ExchangeView {
  const handler = item.reviewer?.workflowNodeId ?? (item.handler === 'user' ? 'Human' : item.handler === 'operator' ? 'Operator' : 'Reviewer unavailable')
  const delivery = canceledDeliveryUnconfirmed(item) ? 'Delivery outcome unconfirmed after cancellation'
    : label(deliveryLabels, item.deliveryState, 'Delivery unavailable')
  const resume = item.resumeState === 'acknowledged' && (!item.resumeAcknowledgementId || item.deliveryState !== 'delivered')
    ? 'Resumption unavailable' : label(resumeLabels, item.resumeState, 'Resumption unavailable')
  return { key: `interaction:${item.interactionId}`, title: `Approval ${item.interactionId}`,
    relationshipId: item.approvalRelationshipId, from: item.requester.workflowNodeId, to: handler,
    nodeIds: [item.requester.workflowNodeId, ...(item.reviewer ? [item.reviewer.workflowNodeId] : [])],
    fields: [field('Interaction', item.interactionId), field('Revision', item.revision),
      field('Request direction', `${item.requester.workflowNodeId} → ${handler}`),
      field('Response direction', `${handler} → ${item.requester.workflowNodeId}`),
      field('Requester execution', item.requester.executionId), field('Requester attempt', String(item.requester.attempt)),
      field('Reviewer execution', item.reviewer?.executionId ?? 'Not App-routed'),
      field('Relationship', item.approvalRelationshipId ?? 'Explicit human/Operator handling'),
      field('Request state', item.status === 'canceled' ? 'Canceled' : item.status === 'pending' ? 'Awaiting decision' :
        ['decided', 'delivery_pending', 'delivered', 'delivery_failed'].includes(item.status) ? 'Decision recorded' : 'Unavailable'),
      field('Decision', label(decisionLabels, item.decision, item.status === 'pending' ? 'Not decided' : 'No confirmed decision')),
      field('Native delivery', delivery), field('Worker resumption', resume),
      field('Resumption evidence', item.resumeAcknowledgementId ?? 'No native acknowledgement'),
    ] }
}
export function presentReview(item: Review): ExchangeView {
  const state = item.state === 'completed' && (item.nativeCleanup === 'pending' || item.credentialCleanup === 'pending') ? 'Review settlement unavailable'
    : item.state === 'acknowledged' && !item.acknowledgementId ? 'Review unavailable'
    : label(reviewLabels, item.state, 'Review unavailable')
  return { key: `review:${item.reviewJobId}`, title: `Review ${item.reviewJobId}`, relationshipId: item.relationshipId,
    from: item.requester.workflowNodeId, to: item.reviewer.workflowNodeId, nodeIds: [item.requester.workflowNodeId, item.reviewer.workflowNodeId],
    fields: [field('Review job', item.reviewJobId), field('Interaction', item.interactionId), field('Revision', item.revision),
      field('Request direction', `${item.requester.workflowNodeId} → ${item.reviewer.workflowNodeId}`),
      field('Reviewer execution', item.reviewer.executionId), field('Requester execution', item.requester.executionId),
      field('Relationship', item.relationshipId), field('Review state', state),
      field('Native acknowledgement', item.acknowledgementId ?? 'Not acknowledged; a lease is not native work'),
      field('Native cleanup', item.nativeCleanup), field('Credential cleanup', item.credentialCleanup),
    ] }
}
export function presentBinding(item: Binding): ExchangeView {
  return { key: `binding:${item.bindingId}`, title: `Accepted input ${item.inputOrdinal + 1}`, relationshipId: item.relationshipId,
    from: item.sender.workflowNodeId, to: item.recipient.workflowNodeId, nodeIds: [item.sender.workflowNodeId, item.recipient.workflowNodeId],
    fields: [field('Receipt', item.bindingId), field('Direction', `${item.sender.workflowNodeId} → ${item.recipient.workflowNodeId}`),
      field('Relationship', item.relationshipId), field('Sender execution', item.sender.executionId),
      field('Recipient execution', item.recipient.executionId), field('Accepted result digest', item.acceptedResultDigest),
      field('Input digest', item.recipientInputDigest), field('Bound at', item.boundAt),
      field('Meaning', 'Input receipt confirmed; this does not establish native work'),
    ] }
}

export const selectVisualStale = (record: RunGraphRecord) => record.transport.phase !== 'live'
export const selectVisualStopped = (record: RunGraphRecord) => {
  const run = record.facts?.reader === 'graph' ? record.facts.snapshot.state.run : undefined
  return run?.stopRequested === true || run?.executionState === 'interrupted' || run?.outcome === 'failed' || run?.outcome === 'canceled'
}

/** One small aggregate selection; tool events and activity text cannot produce announcements. */
export function selectAttentionAnnouncement(record: RunGraphRecord): string {
  const freshness = record.transport.phase === 'live' ? 'Facts synchronized.' : 'Updates unconfirmed. Showing last known facts.'
  if (record.transport.phase === 'denied') return 'Run access unavailable.'
  const run = record.facts?.reader === 'graph' ? record.facts.snapshot.state.run : undefined
  return run ? `${run.executionState}; ${run.outcome}.${run.stopRequested ? ' Stop requested.' : ''} ${run.pendingInteractionCount} pending requests; ${run.unsettledReviewCount} unsettled reviews.${run.cleanupPending ? ' Cleanup pending.' : ''} ${freshness}` : freshness
}
export function selectAttentionNodes(record: RunGraphRecord) {
  if (record.facts?.reader !== 'graph') return []
  return record.facts.snapshot.state.nodes.filter((node) => node.attention.pendingInteractionCount > 0
    || node.attention.unsettledReviewCount > 0 || node.attention.cleanupPending || node.attention.telemetry !== 'current'
    || ['failed', 'interrupted', 'uncertain', 'unknown'].includes(node.state.lifecycle)).map((node) => ({
    id: node.state.workflowNodeId,
    label: `${node.state.workflowNodeId}: ${node.state.lifecycle}; ${node.attention.pendingInteractionCount} pending; ${node.attention.unsettledReviewCount} reviews${node.attention.cleanupPending ? '; cleanup pending' : ''}${node.attention.telemetry !== 'current' ? '; telemetry ' + node.attention.telemetry : ''}`,
  }))
}

// Build the reverse relationship index once per immutable state, not one scan per rendered edge.
const relationshipIndexes = new WeakMap<RunGraphCurrentState, ReadonlyMap<string, string>>()
export function selectRelationshipSummary(record: RunGraphRecord, relationshipId: string): string {
  if (record.facts?.reader !== 'graph') return ''
  const { state } = record.facts.snapshot
  let index = relationshipIndexes.get(state)
  if (!index) {
    const parts = new Map<string, { pending: number; reviews: number; delivery: number; failed: number; uncertain: number; receipts: number; route?: string }>()
    const row = (id: string) => {
      let item = parts.get(id)
      if (!item) { item = { pending: 0, reviews: 0, delivery: 0, failed: 0, uncertain: 0, receipts: 0 }; parts.set(id, item) }
      return item
    }
    for (const item of state.interactions) {
      if (!item.approvalRelationshipId) continue
      const count = row(item.approvalRelationshipId)
      if (item.status === 'pending') ++count.pending
      if (item.deliveryState === 'pending' || item.deliveryState === 'submitted') ++count.delivery
      if (item.deliveryState === 'failed') {
        if (canceledDeliveryUnconfirmed(item)) ++count.uncertain
        else ++count.failed
      }
      if (item.deliveryState === 'uncertain') ++count.uncertain
    }
    for (const item of state.reviews) {
      if (item.state !== 'completed' || item.nativeCleanup === 'pending' || item.credentialCleanup === 'pending') ++row(item.relationshipId).reviews
    }
    for (const item of state.inputBindings) ++row(item.relationshipId).receipts
    for (const node of state.nodes) {
      for (const id of node.resolution?.selectedRelationshipIds ?? []) row(id).route = 'Route selected'
      for (const id of node.resolution?.unselectedRelationshipIds ?? []) row(id).route = 'Not selected'
    }
    index = new Map([...parts].map(([id, value]) => [id, [value.route,
      value.receipts ? `${value.receipts} input receipts` : undefined,
      value.pending ? `${value.pending} pending requests` : undefined,
      value.reviews ? `${value.reviews} unsettled reviews` : undefined,
      value.delivery ? `${value.delivery} delivery pending` : undefined,
      value.failed ? `${value.failed} delivery failed` : undefined,
      value.uncertain ? `${value.uncertain} delivery uncertain` : undefined,
    ].filter(Boolean).join(' · ')]))
    relationshipIndexes.set(state, index)
  }
  return index.get(relationshipId) ?? ''
}

export type ExchangeOption = Pick<ExchangeView, 'key' | 'title' | 'from' | 'to'>

/** Project only stable list labels; changing a decision does not rebuild/remount the selector. */
export function selectExchangeOptions(record: RunGraphRecord, nodeId?: string, relationshipId?: string): ExchangeOption[] {
  if (record.facts?.reader !== 'graph') return []
  const { state } = record.facts.snapshot
  const matches = (id: string | undefined, nodes: string[]) => (!relationshipId || relationshipId === id) && (!nodeId || nodes.includes(nodeId))
  return [
    ...state.interactions.filter((item) => matches(item.approvalRelationshipId, [item.requester.workflowNodeId, ...(item.reviewer ? [item.reviewer.workflowNodeId] : [])]))
      .map((item): ExchangeOption => ({ key: `interaction:${item.interactionId}`, title: `Approval ${item.interactionId}`,
        from: item.requester.workflowNodeId, to: item.reviewer?.workflowNodeId ?? (item.handler === 'user' ? 'Human' : item.handler === 'operator' ? 'Operator' : 'Reviewer unavailable') })),
    ...state.reviews.filter((item) => matches(item.relationshipId, [item.requester.workflowNodeId, item.reviewer.workflowNodeId]))
      .map((item): ExchangeOption => ({ key: `review:${item.reviewJobId}`, title: `Review ${item.reviewJobId}`, from: item.requester.workflowNodeId, to: item.reviewer.workflowNodeId })),
    ...state.inputBindings.filter((item) => matches(item.relationshipId, [item.sender.workflowNodeId, item.recipient.workflowNodeId]))
      .map((item): ExchangeOption => ({ key: `binding:${item.bindingId}`, title: `Accepted input ${item.inputOrdinal + 1}`, from: item.sender.workflowNodeId, to: item.recipient.workflowNodeId })),
  ]
}
export function selectFocusedExchange(record: RunGraphRecord, key?: string, nodeId?: string, relationshipId?: string): ExchangeView | undefined {
  if (record.facts?.reader !== 'graph' || !key) return undefined
  const { state } = record.facts.snapshot
  let view: ExchangeView | undefined
  if (key.startsWith('interaction:')) {
    const item = state.interactions.find((row) => row.interactionId === key.slice('interaction:'.length))
    if (item) view = presentInteraction(item)
  } else if (key.startsWith('review:')) {
    const item = state.reviews.find((row) => row.reviewJobId === key.slice('review:'.length))
    if (item) view = presentReview(item)
  } else if (key.startsWith('binding:')) {
    const item = state.inputBindings.find((row) => row.bindingId === key.slice('binding:'.length))
    if (item) view = presentBinding(item)
  }
  return view && (!relationshipId || view.relationshipId === relationshipId) && (!nodeId || view.nodeIds.includes(nodeId)) ? view : undefined
}
