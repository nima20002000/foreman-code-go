import { makeWave25Fixture, RunGraphSnapshotSchema, type GraphFact, type RunGraphBatch, type RunGraphPage, type RunGraphScope } from '@graphql/contracts/wave25'

export const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
export function batch(scope: RunGraphScope, sequence: string, facts: GraphFact[], seed = 1): RunGraphBatch {
  return { protocolVersion: 1, scope, batchId: uuid(seed), previousSequence: (BigInt(sequence) - 1n).toString(), sequence,
    events: facts.map((fact, index) => ({ eventId: uuid(seed * 100 + index),
      evidence: { sourceKind: 'native_event', sourceId: `source-${seed}-${index}`, sourceRevision: sequence }, fact })) }
}
export function page(scope: RunGraphScope, batches: RunGraphBatch[], base = batches[0]?.previousSequence ?? '0', head?: string): RunGraphPage {
  const throughSequence = batches.at(-1)?.sequence ?? base
  const headSequence = head ?? throughSequence
  return { kind: 'page', protocolVersion: 1, scope, baseSequence: base, throughSequence, headSequence,
    retentionFloor: '0', hasMore: BigInt(throughSequence) < BigInt(headSequence), batches }
}
export function fixture(suffix = 'a7') {
  return makeWave25Fixture(suffix)
}
export function queued(f: ReturnType<typeof fixture>, index = 0): GraphFact {
  return { type: 'node.state', state: { workflowNodeId: f.identities[index]!.workflowNodeId,
    lifecycle: 'queued', execution: f.identities[index]! } }
}

/** Synthetic records only: no sessions, provider calls, authoring mutations or paid model work. */
export function largeFixture(count: number) {
  const f = fixture(`large-${count}`)
  const topologyNodes = Array.from({ length: count }, (_, index) => ({ workflowNodeId: `node-${index}`,
    agentId: `agent-${index}`, agentConfigurationVersionId: `config-${index}`, productRole: 'coder' as const }))
  const snapshot = RunGraphSnapshotSchema.parse({ ...f.snapshot,
    topology: { entryNodeId: topologyNodes[0]!.workflowNodeId, nodes: topologyNodes, relationships: [] },
    state: { ...f.snapshot.state, nodes: topologyNodes.map((node) => ({
      state: { workflowNodeId: node.workflowNodeId, lifecycle: 'not_activated' },
      activity: { workflowNodeId: node.workflowNodeId, status: 'unknown' },
      attention: { workflowNodeId: node.workflowNodeId, pendingInteractionCount: 0, unsettledReviewCount: 0, cleanupPending: false, telemetry: 'unknown' },
    })) },
  })
  return { ...f, snapshot }
}
