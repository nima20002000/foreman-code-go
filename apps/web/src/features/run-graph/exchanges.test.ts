import { describe, expect, it } from 'vitest'
import { RunGraphSnapshotSchema, applyRunGraphPageFixture, type GraphFact } from '@graphql/contracts/wave25'
import { reduceGraphPage } from './reducer'
import { presentRunGraphNode } from './presentation'
import { batch, fixture, page, queued } from './testFixtures'

const digest = 'sha256:' + 'a'.repeat(64)
describe('independent resolution, receipts, review, decision, delivery and resumption facts', () => {
  it('does not queue the receiver for a selected route or claim native work for an input binding', () => {
    const f = fixture('receipts')
    let snapshot = reduceGraphPage(f.snapshot, page(f.scope, [batch(f.scope, '1', [queued(f)])])).snapshot
    const resolved: GraphFact[] = [
      { type: 'result.accepted', execution: f.identities[0]!, resultDigest: digest },
      { type: 'node.state', state: { workflowNodeId: f.identities[0]!.workflowNodeId, lifecycle: 'succeeded', execution: f.identities[0]! } },
      { type: 'node.resolved', resolution: { workflowNodeId: f.identities[0]!.workflowNodeId, resolution: 'succeeded',
        execution: f.identities[0]!, acceptedResultDigest: digest, branchEnded: false,
        selectedRelationshipIds: [f.snapshot.topology.relationships[0]!.relationshipId], unselectedRelationshipIds: [], resolvedAt: f.createdAt } },
    ]
    snapshot = reduceGraphPage(snapshot, page(f.scope, [batch(f.scope, '2', resolved, 2)])).snapshot
    expect(snapshot.state.nodes[1]!.state.lifecycle).toBe('not_activated')
    expect(snapshot.state.inputBindings).toEqual([])
    const binding = { bindingId: 'binding', relationshipId: f.snapshot.topology.relationships[0]!.relationshipId,
      sender: f.identities[0]!, recipient: f.identities[1]!, acceptedResultDigest: digest,
      recipientInputDigest: 'sha256:' + 'b'.repeat(64), inputOrdinal: 0, boundAt: f.createdAt }
    const response = page(f.scope, [batch(f.scope, '3', [queued(f, 1), { type: 'input.bound', binding }], 3)])
    const next = reduceGraphPage(snapshot, response).snapshot
    expect(next).toEqual(applyRunGraphPageFixture(snapshot, response, 1, 1).snapshot)
    expect(next.state.nodes[1]!.state.lifecycle).toBe('queued')
    expect(presentRunGraphNode(next.state.nodes[1]).activity).toBe('Activity unavailable')
    expect(() => reduceGraphPage(next, page(f.scope, [batch(f.scope, '4', [{ type: 'input.bound', binding: {
      ...binding, recipientInputDigest: 'sha256:' + 'c'.repeat(64),
    } }], 4)]))).toThrow('GRAPH_SOURCE_CONFLICT')
  })

  it('does not confuse a lease, a decision, delivery, review settlement, or Worker resumption', () => {
    const f = fixture('review')
    let snapshot = RunGraphSnapshotSchema.parse({ ...f.snapshot, topology: { ...f.snapshot.topology,
      nodes: f.snapshot.topology.nodes.map((node, i) => i === 0 ? { ...node, productRole: 'orchestrator' } : node),
      relationships: [...f.snapshot.topology.relationships, { relationshipId: 'approval', kind: 'approval',
        source: f.identities[0]!.workflowNodeId, target: f.identities[1]!.workflowNodeId }],
    } })
    let sequence = 0
    const apply = (facts: GraphFact[]) => {
      const response = page(f.scope, [batch(f.scope, String(++sequence), facts, sequence)])
      const expected = applyRunGraphPageFixture(snapshot, response, 1, 1)
      expect(expected.kind).toBe('applied')
      snapshot = reduceGraphPage(snapshot, response).snapshot
      expect(snapshot).toEqual(expected.snapshot)
    }
    apply([queued(f), queued(f, 1)])
    const interaction = { interactionId: 'interaction', revision: '1', requester: f.identities[1]!, reviewer: f.identities[0]!,
      approvalRelationshipId: 'approval', handler: 'orchestrator' as const, status: 'pending' as const,
      deliveryState: 'not_started' as const, resumeState: 'not_started' as const }
    const review = { reviewJobId: 'review', interactionId: 'interaction', relationshipId: 'approval',
      requester: f.identities[1]!, reviewer: f.identities[0]!, revision: '1', leaseAttempt: 1,
      state: 'leased' as const, nativeCleanup: 'pending' as const, credentialCleanup: 'pending' as const }
    apply([{ type: 'interaction.state', interaction }, { type: 'review.state', review }])
    expect(presentRunGraphNode(snapshot.state.nodes[0]).activity).toBe('Activity unavailable')
    const decided = { ...interaction, revision: '2', status: 'decided' as const, decision: 'approve_once' as const, selectedOptionId: 'approve' }
    apply([{ type: 'interaction.state', interaction: decided }])
    expect(snapshot.state.interactions[0]!.deliveryState).toBe('not_started')
    expect(snapshot.state.interactions[0]!.resumeState).toBe('not_started')
    apply([{ type: 'interaction.state', interaction: { ...decided, revision: '3', status: 'delivery_pending', deliveryState: 'submitted', resumeState: 'pending' } }])
    expect(snapshot.state.interactions[0]!.resumeState).toBe('pending')
    const delivered = { ...decided, revision: '4', status: 'delivered' as const, deliveryState: 'delivered' as const, resumeState: 'pending' as const }
    apply([{ type: 'interaction.state', interaction: delivered }])
    expect(snapshot.state.interactions[0]!.resumeState).toBe('pending')
    expect(snapshot.state.reviews[0]!.state).toBe('leased')
    apply([{ type: 'worker.resumed', interactionId: 'interaction', requester: f.identities[1]!, acknowledgementId: 'resume-ack' }])
    expect(snapshot.state.interactions[0]!.resumeState).toBe('acknowledged')
    // Even an acknowledged Worker resume does not invent the next native activity/action.
    expect(presentRunGraphNode(snapshot.state.nodes[1]).activity).toBe('Activity unavailable')
    expect(() => reduceGraphPage(snapshot, page(f.scope, [batch(f.scope, String(sequence + 1), [
      { type: 'exchange.retired', exchangeKind: 'review', exchangeId: 'review', finalRevision: '1' },
    ], 20)]))).toThrow('GRAPH_INVALID_FACT')
    apply([{ type: 'review.state', review: { ...review, revision: '2', state: 'completed', nativeCleanup: 'closed', credentialCleanup: 'revoked' } }])
    apply([{ type: 'exchange.retired', exchangeKind: 'review', exchangeId: 'review', finalRevision: '2' },
      { type: 'exchange.retired', exchangeKind: 'interaction', exchangeId: 'interaction', finalRevision: '4' }])
    expect(snapshot.state.reviews).toEqual([])
    expect(snapshot.state.interactions).toEqual([])
  })
})
