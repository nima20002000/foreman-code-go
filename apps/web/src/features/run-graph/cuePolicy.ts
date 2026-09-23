import type { GraphExecutionIdentity, RunGraphSnapshot, RunGraphScope } from '@graphql/contracts/wave25'
import type { GraphExchangeCue } from '../graph/presentationStore'
import type { AcceptedBatchCue, RunGraphRecord } from './types'
import { sameExecutionIdentity } from './presentation'

export const RUN_CUE_LIMITS = Object.freeze({ durationMs: 300, simultaneous: 4, coalesceMs: 50, maxStartAgeMs: 1000 })
type Candidate = { key: string; relationshipId: string; fingerprint: string; caption: string; inspectedOnly: boolean }
type Pending = { candidate: Candidate; observedAt: number }
type Active = Pending & { expiresAt: number; cue: GraphExchangeCue }
export type CueEnvironment = {
  now: number
  motion: boolean
  focusedExchangeKey?: string
  isVisible: (relationshipId: string) => boolean
}
const sameScope = (a: Readonly<RunGraphScope>, b: Readonly<RunGraphScope>) => a.workspaceId === b.workspaceId
  && a.workflowId === b.workflowId && a.runId === b.runId && a.workflowVersionId === b.workflowVersionId
  && a.executionSemanticsVersion === b.executionSemanticsVersion

function motionSafe(record: RunGraphRecord | undefined): boolean {
  if (record?.facts?.reader !== 'graph' || record.transport.phase !== 'live') return false
  const run = record.facts.snapshot.state.run
  return run.stopRequested === false && run.outcome === 'pending'
    && ['running', 'waiting', 'queued'].includes(run.executionState)
}

// A weak, derived index over immutable Query entities, never a second writable fact store.
const candidateIndexes = new WeakMap<RunGraphSnapshot, ReadonlyMap<string, Candidate>>()
function candidates(record: RunGraphRecord | undefined): ReadonlyMap<string, Candidate> {
  if (record?.facts?.reader !== 'graph') return new Map()
  const snapshot = record.facts.snapshot
  const { state, topology } = snapshot
  const cached = candidateIndexes.get(snapshot)
  if (cached) return cached
  const result = new Map<string, Candidate>()
  const nodes = new Map(state.nodes.map((node) => [node.state.workflowNodeId, node]))
  const edges = new Map(topology.relationships.map((edge) => [edge.relationshipId, edge]))
  const interactions = new Map(state.interactions.map((item) => [item.interactionId, item]))
  const endpoint = (identity: GraphExecutionIdentity, allowSucceeded: boolean) => {
    const node = nodes.get(identity.workflowNodeId)
    return Boolean(node && sameExecutionIdentity(node.state.execution, identity) && node.attention.telemetry === 'current'
      && (['queued', 'starting', 'running', 'waiting'].includes(node.state.lifecycle) || allowSucceeded && node.state.lifecycle === 'succeeded'))
  }
  const relation = (id: string, kind: 'execution' | 'approval', source: string, target: string) => {
    const edge = edges.get(id)
    return edge?.kind === kind && edge.source === source && edge.target === target
  }
  for (const item of state.inputBindings) {
    if (!relation(item.relationshipId, 'execution', item.sender.workflowNodeId, item.recipient.workflowNodeId)
      || !endpoint(item.sender, true) || !endpoint(item.recipient, false)) continue
    const key = `binding:${item.bindingId}`
    result.set(key, { key, relationshipId: item.relationshipId, inspectedOnly: false, caption: 'Input receipt confirmed',
      fingerprint: [key, item.sender.executionId, item.recipient.executionId, item.acceptedResultDigest, item.recipientInputDigest].join('|') })
  }
  for (const item of state.interactions) {
    if (item.status !== 'delivered' || item.deliveryState !== 'delivered' || !item.decision || !item.selectedOptionId
      || !item.reviewer || !item.approvalRelationshipId || item.handler !== 'orchestrator'
      || !relation(item.approvalRelationshipId, 'approval', item.reviewer.workflowNodeId, item.requester.workflowNodeId)
      || !endpoint(item.requester, false) || !endpoint(item.reviewer, true)) continue
    if (item.resumeState === 'acknowledged' && !item.resumeAcknowledgementId) continue
    const key = `interaction:${item.interactionId}`
    result.set(key, { key, relationshipId: item.approvalRelationshipId, inspectedOnly: true,
      caption: item.resumeState === 'acknowledged' ? 'Resumption acknowledged' : 'Native delivery confirmed',
      fingerprint: [key, item.revision, item.requester.executionId, item.reviewer.executionId, item.resumeState, item.resumeAcknowledgementId].join('|') })
  }
  for (const item of state.reviews) {
    const interaction = interactions.get(item.interactionId)
    if (item.state !== 'acknowledged' || !item.acknowledgementId || interaction?.status !== 'pending'
      || interaction.approvalRelationshipId !== item.relationshipId
      || !sameExecutionIdentity(interaction.requester, item.requester) || !sameExecutionIdentity(interaction.reviewer, item.reviewer)
      || !relation(item.relationshipId, 'approval', item.reviewer.workflowNodeId, item.requester.workflowNodeId)
      || !endpoint(item.requester, false) || !endpoint(item.reviewer, true)) continue
    const key = `review:${item.reviewJobId}`
    result.set(key, { key, relationshipId: item.relationshipId, inspectedOnly: true, caption: 'Native review acknowledged',
      fingerprint: [key, item.revision, item.acknowledgementId, item.requester.executionId, item.reviewer.executionId].join('|') })
  }
  candidateIndexes.set(snapshot, result)
  return result
}

/** Small lossy effect policy: latest truth is already committed; no FIFO, replay, or workflow writes. */
export function createRunCuePolicy() {
  let scope: Readonly<RunGraphScope> | undefined
  let epoch: number | undefined
  let baseline = new Map<string, string>()
  let used = new Set<string>()
  const pending = new Map<string, Pending>()
  let active: Active[] = []
  let wakeAt: number | undefined
  let flushAt: number | undefined
  let nonce = 0
  const clear = () => { pending.clear(); active = []; wakeAt = undefined; flushAt = undefined }
  const rearm = () => {
    const times = active.map((item) => item.expiresAt)
    if (flushAt !== undefined && pending.size) times.push(flushAt)
    if (!pending.size) flushAt = undefined
    wakeAt = times.length ? Math.min(...times) : undefined
  }
  const seed = (record: RunGraphRecord | undefined) => {
    baseline = new Map([...candidates(record)].map(([key, item]) => [key, item.fingerprint]))
    clear()
  }
  const allowed = (item: Candidate, env: CueEnvironment) => (!item.inspectedOnly || env.focusedExchangeKey === item.key)
    && env.isVisible(item.relationshipId)
  const observe = (record: RunGraphRecord | undefined, env: CueEnvironment) => {
    if (!record || !scope || epoch !== record.epoch || !sameScope(scope, record.scope)) {
      scope = record?.scope; epoch = record?.epoch; used = new Set(); seed(record)
    }
    if (!env.motion || !motionSafe(record)) { seed(record); return }
    const current = candidates(record)
    // Retirement bounds the dedup set by the current compact exchange window.
    const state = record?.facts?.reader === 'graph' ? record.facts.snapshot.state : undefined
    const retained = new Set(state ? [...state.inputBindings.map((x) => `binding:${x.bindingId}`),
      ...state.interactions.map((x) => `interaction:${x.interactionId}`), ...state.reviews.map((x) => `review:${x.reviewJobId}`)] : [])
    used = new Set([...used].filter((key) => retained.has(key)))
    active = active.filter((item) => item.expiresAt > env.now && current.get(item.candidate.key)?.fingerprint === item.candidate.fingerprint
      && allowed(item.candidate, env))
    for (const [key, item] of pending) {
      if (env.now - item.observedAt > RUN_CUE_LIMITS.maxStartAgeMs || current.get(key)?.fingerprint !== item.candidate.fingerprint
        || !allowed(item.candidate, env)) pending.delete(key)
    }
    rearm()
  }
  return {
    observe,
    accept(signal: AcceptedBatchCue, record: RunGraphRecord | undefined, env: CueEnvironment) {
      observe(record, env)
      if (!record || record.facts?.reader !== 'graph' || signal.epoch !== record.epoch || !sameScope(signal.scope, record.scope)) return
      // A page commits all batches atomically. Only its final callback may compare the current cut.
      if (signal.sequence !== record.facts.snapshot.asOfSequence) return
      const committedAt = record.transport.confirmedAt
      if (signal.mode !== 'live' || !signal.eventIds.length || !env.motion || !motionSafe(record)
        || committedAt === undefined || !Number.isFinite(committedAt) || env.now < committedAt
        || env.now - committedAt > RUN_CUE_LIMITS.maxStartAgeMs) { seed(record); return }
      const current = candidates(record)
      const changed: Candidate[] = []
      for (const [key, candidate] of current) {
        if (baseline.get(key) === candidate.fingerprint || used.has(key)) continue
        used.add(key) // Dropped/offscreen effects are consumed too; scrolling must not replay them.
        if (!candidate.inspectedOnly || env.focusedExchangeKey === candidate.key) changed.push(candidate)
      }
      // Bound DOM visibility reads too, even when a large publication contains many receipts.
      for (const candidate of changed.slice(-RUN_CUE_LIMITS.simultaneous)) {
        const key = candidate.key
        if (active.length >= RUN_CUE_LIMITS.simultaneous || !allowed(candidate, env)) continue
        if (!pending.size) flushAt = env.now + RUN_CUE_LIMITS.coalesceMs
        pending.delete(key)
        pending.set(key, { candidate, observedAt: committedAt })
        if (pending.size > RUN_CUE_LIMITS.simultaneous) pending.delete(pending.keys().next().value!)
      }
      baseline = new Map([...current].map(([key, item]) => [key, item.fingerprint]))
      rearm()
    },
    tick(record: RunGraphRecord | undefined, env: CueEnvironment) {
      const due = flushAt
      observe(record, env)
      if (due === undefined || due > env.now || !env.motion || !motionSafe(record)) return
      for (const item of [...pending.values()].reverse()) {
        if (active.length >= RUN_CUE_LIMITS.simultaneous) break
        if (env.now - item.observedAt > RUN_CUE_LIMITS.maxStartAgeMs || !allowed(item.candidate, env)) continue
        const { key, relationshipId, caption } = item.candidate
        active.push({ ...item, expiresAt: env.now + RUN_CUE_LIMITS.durationMs,
          cue: Object.freeze({ key, relationshipId, caption, token: `cue-${++nonce}` }) })
      }
      pending.clear() // Capacity overflow is dropped, not played later.
      flushAt = undefined
      rearm()
    },
    clear,
    cues: () => active.map((item) => item.cue),
    nextWakeAt: () => wakeAt,
  }
}
