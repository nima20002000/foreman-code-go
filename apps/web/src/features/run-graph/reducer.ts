import {
  RunGraphSnapshotSchema, RunGraphEventsResponseSchema, sameGraphScope,
  assertGraphRunTransition, assertGraphNodeTransition, graphFactExecutions, canonicalGraphJson,
  type GraphFact, type RunGraphSnapshot, type RunGraphScope, type RunGraphCurrentState,
  type RunGraphBatch, type RunGraphReset,
} from '@graphql/contracts/wave25'
import { GraphProtocolError } from './errors'

type NodeFact = RunGraphCurrentState['nodes'][number]
export type AcceptedBatch = Pick<RunGraphBatch, 'batchId' | 'sequence'> & { eventIds: string[] }
export type GraphPageResult = {
  kind: 'applied' | 'duplicate' | 'gap' | 'reset'
  snapshot: RunGraphSnapshot
  accepted: AcceptedBatch[]
  hasMore: boolean
  reset?: RunGraphReset
}
const fail = (code: string): never => { throw new GraphProtocolError(code) }
const equivalent = (a: unknown, b: unknown) => canonicalGraphJson(a) === canonicalGraphJson(b)
const retain = <T>(old: T | undefined, next: T): T => old !== undefined && equivalent(old, next) ? old : next

const ordered = <T>(rows: T[], id: (row: T) => string) => [...rows].sort((a, b) => id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0)
function topologyMeaning(topology: RunGraphSnapshot['topology']) {
  return { ...topology, nodes: ordered(topology.nodes, (row) => row.workflowNodeId),
    relationships: ordered(topology.relationships, (row) => row.relationshipId) }
}
function stateMeaning(state: RunGraphCurrentState) {
  return { ...state, nodes: ordered(state.nodes, (row) => row.state.workflowNodeId).map((node) => node.resolution ? {
    ...node, resolution: { ...node.resolution, selectedRelationshipIds: [...node.resolution.selectedRelationshipIds].sort(),
      unselectedRelationshipIds: [...node.resolution.unselectedRelationshipIds].sort() },
  } : node), inputBindings: ordered(state.inputBindings, (row) => row.bindingId),
  interactions: ordered(state.interactions, (row) => row.interactionId), reviews: ordered(state.reviews, (row) => row.reviewJobId) }
}
function retainCollection<T>(before: T[], after: T[], id: (row: T) => string): T[] {
  const previous = new Map(before.map((row) => [id(row), row]))
  const shared = after.map((row) => retain(previous.get(id(row)), row))
  // These are identity-keyed sets. Input ordinal is an explicit receipt field, not array position.
  if (shared.length === before.length && shared.every((row) => previous.get(id(row)) === row)) return before
  return shared
}

function upsert<T>(rows: T[], value: T, id: (row: T) => string): T[] {
  const index = rows.findIndex((row) => id(row) === id(value))
  if (index < 0) return [...rows, value]
  const next = retain(rows[index], value)
  return next === rows[index] ? rows : rows.map((row, i) => i === index ? next : row)
}

function revisioned<T extends { revision: string }>(rows: T[], value: T, id: (row: T) => string): T[] {
  const old = rows.find((row) => id(row) === id(value))
  if (old && (BigInt(old.revision) > BigInt(value.revision)
    || (old.revision === value.revision && !equivalent(old, value)))) fail('GRAPH_SOURCE_CONFLICT')
  return upsert(rows, value, id)
}

/** Validate cross-entity identities, not workflow decisions. No scheduler exists in this reducer. */
function validateIdentities(snapshot: RunGraphSnapshot): void {
  const nodes = new Map(snapshot.state.nodes.map((node) => [node.state.workflowNodeId, node]))
  const edges = new Map(snapshot.topology.relationships.map((edge) => [edge.relationshipId, edge]))
  const checkApproval = (id: string, reviewer: string, requester: string) => {
    const edge = edges.get(id)
    if (!edge || edge.kind !== 'approval' || edge.source !== reviewer || edge.target !== requester) fail('GRAPH_SCOPE_MISMATCH')
  }
  for (const interaction of snapshot.state.interactions) {
    if (interaction.reviewer && interaction.approvalRelationshipId) {
      checkApproval(interaction.approvalRelationshipId, interaction.reviewer.workflowNodeId, interaction.requester.workflowNodeId)
    }
  }
  for (const review of snapshot.state.reviews) checkApproval(review.relationshipId, review.reviewer.workflowNodeId, review.requester.workflowNodeId)
  for (const node of snapshot.state.nodes) {
    for (const execution of [node.activity.execution, node.resolution?.execution]) {
      if (execution && node.state.execution && !equivalent(execution, node.state.execution)) fail('GRAPH_SCOPE_MISMATCH')
    }
    for (const id of [...(node.resolution?.selectedRelationshipIds ?? []), ...(node.resolution?.unselectedRelationshipIds ?? [])]) {
      const edge = edges.get(id)
      if (!edge || edge.kind !== 'execution' || edge.source !== node.state.workflowNodeId) fail('GRAPH_SCOPE_MISMATCH')
    }
  }
  for (const binding of snapshot.state.inputBindings) {
    for (const execution of [binding.sender, binding.recipient]) {
      const current = nodes.get(execution.workflowNodeId)?.state.execution
      if (current && !equivalent(current, execution)) fail('GRAPH_SCOPE_MISMATCH')
    }
  }
}

export function acceptGraphSnapshot(scope: RunGraphScope, input: unknown, previous?: RunGraphSnapshot): RunGraphSnapshot {
  const parsed = RunGraphSnapshotSchema.safeParse(input)
  if (!parsed.success) return fail('GRAPH_INVALID_SNAPSHOT')
  const next = parsed.data
  if (!sameGraphScope(scope, next.scope)) return fail('GRAPH_SCOPE_MISMATCH')
  validateIdentities(next)
  if (previous) {
    if (!sameGraphScope(previous.scope, next.scope) || !equivalent(topologyMeaning(previous.topology), topologyMeaning(next.topology))) return fail('GRAPH_SCOPE_MISMATCH')
    if (BigInt(next.asOfSequence) < BigInt(previous.asOfSequence)) return fail('GRAPH_SNAPSHOT_BEHIND')
    if (next.asOfSequence === previous.asOfSequence && !equivalent(stateMeaning(next.state), stateMeaning(previous.state))) return fail('GRAPH_SOURCE_CONFLICT')
    assertGraphRunTransition(previous.state.run, next.state.run)
    const before = new Map(previous.state.nodes.map((node) => [node.state.workflowNodeId, node.state]))
    for (const node of next.state.nodes) {
      const old = before.get(node.state.workflowNodeId)
      if (old) assertGraphNodeTransition(old, node.state)
    }
    return { ...next, topology: previous.topology, state: {
      ...next.state, run: retain(previous.state.run, next.state.run),
      nodes: retainCollection(previous.state.nodes, next.state.nodes, (node) => node.state.workflowNodeId),
      inputBindings: retainCollection(previous.state.inputBindings, next.state.inputBindings, (row) => row.bindingId),
      interactions: retainCollection(previous.state.interactions, next.state.interactions, (row) => row.interactionId),
      reviews: retainCollection(previous.state.reviews, next.state.reviews, (row) => row.reviewJobId),
    } }
  }
  return next
}

function applyFact(state: RunGraphCurrentState, fact: GraphFact): RunGraphCurrentState {
  switch (fact.type) {
    case 'run.state': {
      assertGraphRunTransition(state.run, fact.state)
      return { ...state, run: retain(state.run, fact.state) }
    }
    case 'input.bound': {
      const old = state.inputBindings.find((row) => row.bindingId === fact.binding.bindingId)
      if (old && !equivalent(old, fact.binding)) return fail('GRAPH_SOURCE_CONFLICT')
      return { ...state, inputBindings: upsert(state.inputBindings, fact.binding, (row) => row.bindingId) }
    }
    case 'interaction.state': return { ...state, interactions: revisioned(state.interactions, fact.interaction, (row) => row.interactionId) }
    case 'review.state': return { ...state, reviews: revisioned(state.reviews, fact.review, (row) => row.reviewJobId) }
    case 'worker.resumed': {
      const current = state.interactions.find((row) => row.interactionId === fact.interactionId)
      if (!current || !equivalent(current.requester, fact.requester) || current.deliveryState !== 'delivered') return fail('GRAPH_INVALID_FACT')
      if (current.resumeAcknowledgementId && current.resumeAcknowledgementId !== fact.acknowledgementId) return fail('GRAPH_SOURCE_CONFLICT')
      return { ...state, interactions: upsert(state.interactions, {
        ...current, resumeState: 'acknowledged', resumeAcknowledgementId: fact.acknowledgementId,
      }, (row) => row.interactionId) }
    }
    case 'exchange.retired': {
      if (fact.exchangeKind === 'review') {
        const current = state.reviews.find((row) => row.reviewJobId === fact.exchangeId)
        if (current && (BigInt(current.revision) > BigInt(fact.finalRevision) || !['completed', 'failed'].includes(current.state)
          || current.nativeCleanup === 'pending' || current.credentialCleanup === 'pending')) return fail('GRAPH_INVALID_FACT')
        return current ? { ...state, reviews: state.reviews.filter((row) => row !== current) } : state
      }
      const current = state.interactions.find((row) => row.interactionId === fact.exchangeId)
      if (current && (BigInt(current.revision) > BigInt(fact.finalRevision) || !['delivered', 'canceled'].includes(current.status))) return fail('GRAPH_INVALID_FACT')
      return current ? { ...state, interactions: state.interactions.filter((row) => row !== current) } : state
    }
    default: {
      const id = fact.type === 'node.state' ? fact.state.workflowNodeId
        : fact.type === 'node.activity' ? fact.activity.workflowNodeId
          : fact.type === 'node.attention' ? fact.attention.workflowNodeId
            : fact.type === 'node.resolved' ? fact.resolution.workflowNodeId : fact.execution.workflowNodeId
      const current = state.nodes.find((node) => node.state.workflowNodeId === id)
      if (!current) return fail('GRAPH_SCOPE_MISMATCH')
      let next: NodeFact
      if (fact.type === 'node.state') {
        assertGraphNodeTransition(current.state, fact.state)
        if (state.run.stopRequested && fact.state.lifecycle !== current.state.lifecycle
          && ['queued', 'starting', 'running', 'waiting'].includes(fact.state.lifecycle)) return fail('GRAPH_STOP_CONFLICT')
        next = { ...current, state: retain(current.state, fact.state) }
      } else if (fact.type === 'node.activity') next = { ...current, activity: retain(current.activity, fact.activity) }
      else if (fact.type === 'node.attention') next = { ...current, attention: retain(current.attention, fact.attention) }
      else if (fact.type === 'node.resolved') {
        if (current.resolution && !equivalent(current.resolution, fact.resolution)) return fail('GRAPH_SOURCE_CONFLICT')
        next = { ...current, resolution: fact.resolution }
      } else {
        if (current.acceptedResultDigest && current.acceptedResultDigest !== fact.resultDigest) return fail('GRAPH_SOURCE_CONFLICT')
        next = { ...current, acceptedResultDigest: fact.resultDigest }
      }
      next = retain(current, next)
      return next === current ? state : { ...state, nodes: state.nodes.map((node) => node === current ? next : node) }
    }
  }
}

/** Whole page is validated before any application. A semantic failure also rolls back the page. */
export function reduceGraphPage(snapshot: RunGraphSnapshot, input: unknown): GraphPageResult {
  const parsed = RunGraphEventsResponseSchema.safeParse(input)
  if (!parsed.success) return fail('GRAPH_INVALID_PAGE')
  const page = parsed.data
  if (!sameGraphScope(snapshot.scope, page.scope)) return fail('GRAPH_SCOPE_MISMATCH')
  const unchanged = (kind: GraphPageResult['kind'], hasMore = false): GraphPageResult => ({ kind, snapshot, accepted: [], hasMore })
  if (page.kind === 'reset') {
    if (page.requestedSequence !== snapshot.asOfSequence) return fail('GRAPH_INVALID_CURSOR')
    return { ...unchanged('reset'), reset: page }
  }
  if (BigInt(page.throughSequence) <= BigInt(snapshot.asOfSequence)) return unchanged('duplicate', BigInt(page.headSequence) > BigInt(snapshot.asOfSequence))
  if (BigInt(page.baseSequence) > BigInt(snapshot.asOfSequence)) return unchanged('gap', true)
  const events = page.batches.flatMap((batch) => batch.events.map((event) => event.eventId))
  if (new Set(events).size !== events.length) return fail('GRAPH_SOURCE_CONFLICT')
  const pinned = new Map(snapshot.topology.nodes.map((node) => [node.workflowNodeId, node]))
  let next = snapshot
  const accepted: AcceptedBatch[] = []
  for (const batch of page.batches) {
    if (BigInt(batch.sequence) <= BigInt(next.asOfSequence)) continue
    if (batch.previousSequence !== next.asOfSequence) return unchanged('gap', true)
    let state = next.state
    for (const event of batch.events) {
      for (const identity of graphFactExecutions(event.fact)) {
        const node = pinned.get(identity.workflowNodeId)
        if (!node || node.agentId !== identity.agentId || node.agentConfigurationVersionId !== identity.agentConfigurationVersionId) return fail('GRAPH_SCOPE_MISMATCH')
        const active = state.nodes.find((row) => row.state.workflowNodeId === identity.workflowNodeId)?.state.execution
        if (active && !equivalent(active, identity)) return fail('GRAPH_SCOPE_MISMATCH')
      }
      state = applyFact(state, event.fact)
    }
    const candidate = { ...next, state, asOfSequence: batch.sequence,
      retentionFloor: BigInt(page.retentionFloor) > BigInt(next.retentionFloor) ? page.retentionFloor : next.retentionFloor }
    if (!RunGraphSnapshotSchema.safeParse(candidate).success) return fail('GRAPH_INVALID_FACT')
    validateIdentities(candidate)
    next = candidate // Never use Zod's cloned result: untouched entity references must survive.
    accepted.push({ batchId: batch.batchId, sequence: batch.sequence, eventIds: batch.events.map((event) => event.eventId) })
  }
  return { kind: 'applied', snapshot: next, accepted, hasMore: page.hasMore }
}

/** Outcome and settlement are independent. Unknown delivery/resumption remains exposed. */
export function graphNeedsPolling(snapshot: RunGraphSnapshot): boolean {
  const state = snapshot.state
  return state.run.executionState !== 'completed' || state.run.cleanupPending
    || state.run.unsettledReviewCount > 0 || state.run.pendingInteractionCount > 0
    || state.nodes.some((node) => node.attention.cleanupPending || node.attention.unsettledReviewCount > 0 || node.attention.pendingInteractionCount > 0)
    || state.reviews.some((review) => !['completed', 'failed'].includes(review.state)
      || review.nativeCleanup === 'pending' || review.credentialCleanup === 'pending')
    || state.interactions.some((interaction) => !['delivered', 'canceled'].includes(interaction.status)
      || ['pending', 'submitted', 'uncertain'].includes(interaction.deliveryState)
      || ['pending', 'unknown'].includes(interaction.resumeState))
}
