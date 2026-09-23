import type { GraphExecutionIdentity, RunGraphSnapshot } from '@graphql/contracts/wave25'
import type { AcceptedBatchCue, RunGraphRecord } from '../types'

export type VisualFixtureRecord = RunGraphRecord & { facts: { reader: 'graph'; snapshot: RunGraphSnapshot } }
const digest = (letter: string) => `sha256:${letter.repeat(64)}`
export const visualFixtureTime = '2026-09-22T00:00:00.000Z'

/** Synthetic read records only. No native sessions, credentials, network calls, or admission switches. */
export function makeVisualFixture(count = 7): VisualFixtureRecord {
  if (!Number.isSafeInteger(count) || count < 2 || count > 500) throw new RangeError('Synthetic fixture size must be between 2 and 500')
  const scope = { workspaceId: 'ws-visual-fixture', workflowId: 'wf-visual-fixture', runId: `run-visual-${count}`,
    workflowVersionId: `version-visual-${count}`, executionSemanticsVersion: 2 as const }
  const identities: GraphExecutionIdentity[] = Array.from({ length: count }, (_, i) => ({
    workflowNodeId: `node-${i}`, executionId: `execution-${i}`, agentId: `agent-${i}`, agentConfigurationVersionId: `configuration-${i}`, attempt: 1,
  }))
  const relationships: RunGraphSnapshot['topology']['relationships'] = identities.slice(1).flatMap((identity, i) => [
    { relationshipId: `execution-edge-${i + 1}`, kind: 'execution', source: 'node-0', target: identity.workflowNodeId },
    { relationshipId: `approval-edge-${i + 1}`, kind: 'approval', source: 'node-0', target: identity.workflowNodeId },
  ])
  return { kind: 'run-graph-cache', scope, epoch: 1, transport: { phase: 'live', confirmedAt: 0 }, facts: { reader: 'graph', snapshot: {
    protocolVersion: 1, scope, asOfSequence: '0', retentionFloor: '0', historyCoverage: 'from_admission',
    topology: { entryNodeId: 'node-0', nodes: identities.map((identity, i) => ({
      workflowNodeId: identity.workflowNodeId, agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
      productRole: i === 0 ? 'orchestrator' : 'coder', position: { x: i % 5 * 310, y: Math.floor(i / 5) * 190 },
    })), relationships },
    state: { run: { executionState: 'running', outcome: 'pending', stopRequested: false, cleanupPending: false, pendingInteractionCount: 0, unsettledReviewCount: 0 },
      nodes: identities.map((identity, i) => ({
        state: { workflowNodeId: identity.workflowNodeId, lifecycle: i === 0 ? 'succeeded' : 'queued', execution: identity },
        activity: { workflowNodeId: identity.workflowNodeId, status: 'none' },
        attention: { workflowNodeId: identity.workflowNodeId, pendingInteractionCount: 0, unsettledReviewCount: 0, cleanupPending: false, telemetry: 'current' },
        ...(i === 0 ? { acceptedResultDigest: digest('a'), resolution: { workflowNodeId: identity.workflowNodeId, execution: identity, resolution: 'succeeded' as const,
          acceptedResultDigest: digest('a'), branchEnded: false, selectedRelationshipIds: relationships.filter((edge) => edge.kind === 'execution').map((edge) => edge.relationshipId),
          unselectedRelationshipIds: [], resolvedAt: visualFixtureTime } } : {}),
      })), inputBindings: [], interactions: [], reviews: [],
    },
  } } }
}
export function nextVisualFixture(record: VisualFixtureRecord): VisualFixtureRecord {
  const next = structuredClone(record)
  next.facts.snapshot.asOfSequence = String(BigInt(record.facts.snapshot.asOfSequence) + 1n)
  return next
}
export function addVisualReceipt(record: VisualFixtureRecord, index: number): VisualFixtureRecord {
  const next = nextVisualFixture(record)
  const nodes = next.facts.snapshot.state.nodes
  if (!nodes[index]?.state.execution || index === 0) throw new RangeError('Receipt needs an existing recipient')
  next.facts.snapshot.state.inputBindings.push({ bindingId: `binding-${index}`, relationshipId: `execution-edge-${index}`,
    sender: nodes[0]!.state.execution!, recipient: nodes[index]!.state.execution!, acceptedResultDigest: digest('a'), recipientInputDigest: digest('b'),
    inputOrdinal: 0, boundAt: visualFixtureTime })
  return next
}
export function addVisualApproval(record: VisualFixtureRecord, index = 1, suffix = String(index)): VisualFixtureRecord {
  const next = nextVisualFixture(record)
  const { state } = next.facts.snapshot
  const requester = state.nodes[index]!.state.execution!
  const reviewer = state.nodes[0]!.state.execution!
  state.interactions.push({ interactionId: `request-${suffix}`, revision: '1', requester, reviewer,
    approvalRelationshipId: `approval-edge-${index}`, handler: 'orchestrator', status: 'pending', deliveryState: 'not_started', resumeState: 'not_started' })
  state.reviews.push({ reviewJobId: `review-${suffix}`, interactionId: `request-${suffix}`, relationshipId: `approval-edge-${index}`,
    requester, reviewer, revision: '1', leaseAttempt: 0, state: 'pending', nativeCleanup: 'not_started', credentialCleanup: 'not_required' })
  state.nodes[index]!.state.lifecycle = 'waiting'
  state.nodes[index]!.attention.pendingInteractionCount++
  state.nodes[0]!.attention.unsettledReviewCount++
  state.run.pendingInteractionCount++
  state.run.unsettledReviewCount++
  return next
}
export function visualSignal(record: VisualFixtureRecord, mode: AcceptedBatchCue['mode'] = 'live'): AcceptedBatchCue {
  const sequence = record.facts.snapshot.asOfSequence
  return { scope: record.scope, epoch: record.epoch, batchId: `batch-${sequence}`, sequence, eventIds: [`event-${sequence}`], mode }
}
