import { replaceEqualDeep } from '@tanstack/react-query'
import { sameGraphScope, GraphSequenceSchema, RunGraphScopeSchema, type RunGraphScope, type RunGraphSnapshot } from '@graphql/contracts/wave25'
import type { RunGraphRecord } from './types'

export const graphCachePrefix = ['workbench', 'run-graph'] as const
export const graphCapabilityKey = (generation: number) => [...graphCachePrefix, generation, 'capabilities'] as const
export const graphRecordKey = (scope: RunGraphScope, generation: number) => [...graphCachePrefix, generation,
  scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId, scope.executionSemanticsVersion] as const

/** Called by Query for BOTH complete records and arbitrary selected slices. No shape-based inference. */
export function shareGraphRecordOrSelection(previous: unknown, next: unknown): unknown {
  if (isRecord(previous) && isRecord(next) && sameGraphScope(previous.scope, next.scope)) {
    if (next.epoch < previous.epoch || previous.transport.phase === 'denied' && next.epoch <= previous.epoch) return previous
    if (previous.facts?.reader === 'graph' && next.facts?.reader === 'graph') {
      const before = previous.facts.snapshot?.asOfSequence
      const after = next.facts.snapshot?.asOfSequence
      if (GraphSequenceSchema.safeParse(before).success && GraphSequenceSchema.safeParse(after).success
        && BigInt(after) < BigInt(before)) return previous
    }
  }
  return replaceEqualDeep(previous, next)
}

// Derived lookup only; values are the actual canonical Query entities, not writable runtime copies.
type NodeRecord = RunGraphSnapshot['state']['nodes'][number]
const nodeIndexes = new WeakMap<RunGraphSnapshot['state']['nodes'], ReadonlyMap<string, NodeRecord>>()
export function selectGraphNode(record: RunGraphRecord | undefined, workflowNodeId: string): NodeRecord | undefined {
  if (record?.facts?.reader !== 'graph') return undefined
  const nodes = record.facts.snapshot.state.nodes
  let index = nodeIndexes.get(nodes)
  if (!index) { index = new Map(nodes.map((node) => [node.state.workflowNodeId, node])); nodeIndexes.set(nodes, index) }
  return index.get(workflowNodeId)
}
export const selectGraphTopology = (record: RunGraphRecord) => record.facts?.reader === 'graph' ? record.facts.snapshot.topology : undefined
export const selectGraphRun = (record: RunGraphRecord) => record.facts?.reader === 'graph' ? record.facts.snapshot.state.run : undefined
export const selectGraphTransport = (record: RunGraphRecord) => record.transport
export const selectGraphEpoch = (record: RunGraphRecord) => record.epoch
export const selectGraphReader = (record: RunGraphRecord) => record.facts?.reader
export const selectLegacyRun = (record: RunGraphRecord) => record.facts?.reader === 'legacy' ? record.facts.response : undefined
export const selectGraphExchanges = (record: RunGraphRecord) => record.facts?.reader === 'graph' ? {
  interactions: record.facts.snapshot.state.interactions, reviews: record.facts.snapshot.state.reviews,
  inputBindings: record.facts.snapshot.state.inputBindings,
} : undefined

function isRecord(value: unknown): value is RunGraphRecord {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'run-graph-cache'
    || !('scope' in value) || !RunGraphScopeSchema.safeParse(value.scope).success
    || !('epoch' in value) || typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch)
    || !('transport' in value) || !value.transport || typeof value.transport !== 'object'
    || !('phase' in value.transport) || typeof value.transport.phase !== 'string') return false
  if (!('facts' in value) || value.facts === undefined) return true
  if (!value.facts || typeof value.facts !== 'object' || !('reader' in value.facts)) return false
  if (value.facts.reader === 'legacy') return 'response' in value.facts
  if (value.facts.reader !== 'graph' || !('snapshot' in value.facts)) return false
  const snapshot = value.facts.snapshot
  return snapshot !== null && typeof snapshot === 'object' && 'asOfSequence' in snapshot
}

function entitySelector<T>(collection: (snapshot: RunGraphSnapshot) => T[], id: (row: T) => string) {
  const indexes = new WeakMap<T[], ReadonlyMap<string, T>>()
  return (record: RunGraphRecord | undefined, entityId: string): T | undefined => {
    if (record?.facts?.reader !== 'graph') return undefined
    const rows = collection(record.facts.snapshot)
    let index = indexes.get(rows)
    if (!index) { index = new Map(rows.map((row) => [id(row), row])); indexes.set(rows, index) }
    return index.get(entityId)
  }
}
export const selectGraphInteraction = entitySelector((snapshot) => snapshot.state.interactions, (row) => row.interactionId)
export const selectGraphReview = entitySelector((snapshot) => snapshot.state.reviews, (row) => row.reviewJobId)
export const selectGraphInputBinding = entitySelector((snapshot) => snapshot.state.inputBindings, (row) => row.bindingId)
