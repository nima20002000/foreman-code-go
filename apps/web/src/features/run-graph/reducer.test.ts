import { describe, expect, it } from 'vitest'
import {
  applyRunGraphPageFixture, RUN_GRAPH_LIMITS, RunGraphPageSchema, RunGraphSnapshotSchema,
  type GraphFact, type RunGraphSnapshot,
} from '@graphql/contracts/wave25'
import { acceptGraphSnapshot, graphNeedsPolling, reduceGraphPage } from './reducer'
import { presentRunGraphNode } from './presentation'
import { batch, fixture, page, queued } from './testFixtures'

function start() {
  const f = fixture()
  const next = reduceGraphPage(f.snapshot, page(f.scope, [batch(f.scope, '1', [queued(f)])])).snapshot
  return { ...f, next }
}

describe('S2 graph-v1 reducer', () => {
  it('covers a publication racing the snapshot read and matches the frozen reference consumer at the same cursor', () => {
    const f = fixture()
    const snapshot = acceptGraphSnapshot(f.scope, f.snapshot)
    const response = page(f.scope, [batch(f.scope, '1', [queued(f)])])
    const actual = reduceGraphPage(snapshot, response)
    const expected = applyRunGraphPageFixture(snapshot, response, 5, 5)
    expect(actual.snapshot).toEqual(expected.snapshot)
    expect(actual.snapshot.asOfSequence).toBe('1')
    expect(actual.accepted.flatMap((item) => item.eventIds)).toEqual(expected.appliedEventIds)
    expect(RunGraphSnapshotSchema.parse(actual.snapshot)).toEqual(actual.snapshot)
  })

  it('ignores duplicates and applies only the fresh suffix of an overlapping page', () => {
    const f = fixture()
    const first = batch(f.scope, '1', [queued(f)], 1)
    const second = batch(f.scope, '2', [queued(f, 1)], 2)
    const initial = reduceGraphPage(f.snapshot, page(f.scope, [first])).snapshot
    const duplicate = reduceGraphPage(initial, page(f.scope, [first]))
    expect(duplicate).toMatchObject({ kind: 'duplicate', accepted: [] })
    expect(duplicate.snapshot).toBe(initial)
    const overlap = reduceGraphPage(initial, page(f.scope, [first, second]))
    expect(overlap.accepted.map((item) => item.sequence)).toEqual(['2'])
    expect(overlap.snapshot).toEqual(applyRunGraphPageFixture(f.snapshot, page(f.scope, [first, second]), 1, 1).snapshot)
  })

  it('does not apply a valid page starting after the last confirmed cursor or jump to its captured head', () => {
    const f = fixture()
    const result = reduceGraphPage(f.snapshot, page(f.scope, [batch(f.scope, '3', [queued(f)])], '2', '20'))
    expect(result.kind).toBe('gap')
    expect(result.snapshot).toBe(f.snapshot)
    expect(result.accepted).toEqual([])
    const partial = reduceGraphPage(f.snapshot, page(f.scope, [batch(f.scope, '1', [queued(f)])], '0', '20'))
    expect(partial.snapshot.asOfSequence).toBe('1')
    expect(partial.hasMore).toBe(true)
  })

  it('retains decimal precision above the JavaScript safe integer range', () => {
    const f = fixture()
    const snapshot = { ...f.snapshot, asOfSequence: '9007199254740993' }
    const response = page(f.scope, [batch(f.scope, '9007199254740994', [queued(f)])])
    expect(reduceGraphPage(snapshot, response).snapshot.asOfSequence).toBe('9007199254740994')
    expect(() => acceptGraphSnapshot(f.scope, { ...snapshot, asOfSequence: '9223372036854775808' })).toThrow('GRAPH_INVALID_SNAPSHOT')
    for (const cursor of [1, '01', '-1', '1e2', '1.0']) {
      expect(() => acceptGraphSnapshot(f.scope, { ...snapshot, asOfSequence: cursor })).toThrow()
    }
  })

  it.each(['history_expired', 'cursor_ahead', 'gap', 'catchup_limit', 'atomic_change_too_large', 'schema_changed'] as const)(
    'exposes %s reset without changing facts or cursor', (reason) => {
      const f = start()
      const result = reduceGraphPage(f.next, { kind: 'reset', protocolVersion: 1, scope: f.scope, reason,
        requestedSequence: '1', headSequence: reason === 'cursor_ahead' ? '0' : '3',
        retentionFloor: reason === 'history_expired' ? '2' : '0', action: 'fetch_snapshot' })
      expect(result.kind).toBe('reset')
      expect(result.snapshot).toBe(f.next)
      expect(result.accepted).toEqual([])
      expect(() => acceptGraphSnapshot(f.scope, f.snapshot, f.next)).toThrow('GRAPH_SNAPSHOT_BEHIND')
    })

  it('rejects all scope dimensions, unsupported schemas and a mismatched reset request', () => {
    const f = fixture()
    for (const field of ['workspaceId', 'workflowId', 'runId', 'workflowVersionId'] as const) {
      const scope = { ...f.scope, [field]: 'different' }
      expect(() => reduceGraphPage(f.snapshot, page(scope, [batch(scope, '1', [queued(f)])]))).toThrow('GRAPH_SCOPE_MISMATCH')
    }
    const wrongSemantics = { ...f.scope, executionSemanticsVersion: 1 as const }
    expect(() => reduceGraphPage(f.snapshot, page(wrongSemantics, [batch(wrongSemantics, '1', [queued(f)])]))).toThrow('GRAPH_SCOPE_MISMATCH')
    expect(() => reduceGraphPage(f.snapshot, { ...page(f.scope, []), protocolVersion: 99 })).toThrow('GRAPH_INVALID_PAGE')
    expect(() => reduceGraphPage(f.snapshot, { kind: 'reset', protocolVersion: 1, scope: f.scope,
      reason: 'gap', requestedSequence: '9', headSequence: '10', retentionFloor: '0', action: 'fetch_snapshot' })).toThrow('GRAPH_INVALID_CURSOR')
  })

  it('rejects gaps inside a page, partial batches and contradictory through/head metadata', () => {
    const f = fixture()
    const a = batch(f.scope, '1', [queued(f)], 1)
    const b = batch(f.scope, '3', [queued(f, 1)], 2)
    for (const response of [page(f.scope, [a, b]), { ...page(f.scope, [a]), throughSequence: '10' },
      { ...page(f.scope, [a]), headSequence: '10', hasMore: false },
      { ...page(f.scope, [a]), batches: [{ ...a, events: [] }] }]) {
      expect(() => reduceGraphPage(f.snapshot, response)).toThrow('GRAPH_INVALID_PAGE')
    }
    expect(f.snapshot.asOfSequence).toBe('0')
  })

  it('enforces page, batch, event and byte bounds instead of applying a truncated prefix', () => {
    const f = fixture()
    const tooMany = Array.from({ length: RUN_GRAPH_LIMITS.pageBatches + 1 }, (_, i) => batch(f.scope, String(i + 1), [queued(f)], i + 1))
    expect(() => reduceGraphPage(f.snapshot, page(f.scope, tooMany))).toThrow('GRAPH_INVALID_PAGE')
    const eventCount = batch(f.scope, '1', Array.from({ length: RUN_GRAPH_LIMITS.batchEvents + 1 }, () => queued(f)))
    expect(() => reduceGraphPage(f.snapshot, page(f.scope, [eventCount]))).toThrow('GRAPH_INVALID_PAGE')
    const oversized = batch(f.scope, '1', [{ type: 'node.resolved', resolution: {
      workflowNodeId: f.identities[0]!.workflowNodeId, resolution: 'failed', execution: f.identities[0]!, branchEnded: false,
      selectedRelationshipIds: [], unselectedRelationshipIds: Array.from({ length: 1500 }, (_, i) => `relationship-${i}`), resolvedAt: f.createdAt,
    } }])
    const result = RunGraphPageSchema.safeParse(page(f.scope, [oversized]))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes('byte limit'))).toBe(true)
    expect(() => reduceGraphPage(f.snapshot, page(f.scope, [oversized]))).toThrow('GRAPH_INVALID_PAGE')
  })

  it('enforces batch and page byte ceilings independently of event and batch counts', () => {
    const f = fixture()
    const long = (prefix: string) => prefix + 'x'.repeat(175)
    const identity = { workflowNodeId: long('node'), executionId: long('exec'), agentId: long('agent'),
      agentConfigurationVersionId: long('cfg'), attempt: 1 }
    const fact: GraphFact = { type: 'node.activity', activity: { workflowNodeId: identity.workflowNodeId,
      status: 'active', action: 'working', execution: identity, acknowledgementId: long('ack'), correlationId: long('corr') } }
    const within = batch(f.scope, '1', Array.from({ length: 32 }, () => fact))
    expect(RunGraphPageSchema.safeParse(page(f.scope, [within])).success).toBe(true)
    const largeBatch = batch(f.scope, '1', Array.from({ length: 64 }, () => fact))
    expect(RunGraphPageSchema.safeParse(page(f.scope, [largeBatch])).success).toBe(false)
    const largePage = Array.from({ length: 16 }, (_, index) => batch(f.scope, String(index + 1),
      Array.from({ length: 32 }, () => fact), index + 1))
    expect(RunGraphPageSchema.safeParse(page(f.scope, largePage)).success).toBe(false)
  })

  it('rejects a malformed late fact atomically without mutating the earlier state', () => {
    const f = fixture()
    const response = page(f.scope, [batch(f.scope, '1', [queued(f)], 1), batch(f.scope, '2', [
      { type: 'node.state', state: { workflowNodeId: 'not-in-run', lifecycle: 'unknown' } },
    ], 2)])
    const before = JSON.stringify(f.snapshot)
    expect(() => reduceGraphPage(f.snapshot, response)).toThrow('GRAPH_SCOPE_MISMATCH')
    expect(JSON.stringify(f.snapshot)).toBe(before)
  })

  it('retains unaffected entities, collections, and pinned topology for one activity update', () => {
    const f = start()
    const response = page(f.scope, [batch(f.scope, '2', [{ type: 'node.activity', activity: {
      workflowNodeId: f.identities[0]!.workflowNodeId, status: 'active', action: 'reading_file',
      execution: f.identities[0]!, acknowledgementId: 'ack', correlationId: 'correlation',
    } }], 2)])
    const next = reduceGraphPage(f.next, response).snapshot
    expect(next.topology).toBe(f.next.topology)
    expect(next.state.run).toBe(f.next.state.run)
    expect(next.state.nodes[1]).toBe(f.next.state.nodes[1])
    expect(next.state.nodes[0]!.state).toBe(f.next.state.nodes[0]!.state)
    expect(next.state.inputBindings).toBe(f.next.state.inputBindings)
    expect(next.state.interactions).toBe(f.next.state.interactions)
    expect(next.state.reviews).toBe(f.next.state.reviews)
    expect(next).toEqual(applyRunGraphPageFixture(f.next, response, 1, 1).snapshot)
  })

  it('accepts semantically identical same-cursor snapshots despite JSON field and set ordering', () => {
    const f = start()
    const incoming = structuredClone(f.next)
    incoming.state.nodes.reverse()
    incoming.topology.nodes.reverse()
    incoming.state.run = Object.fromEntries(Object.entries(incoming.state.run).reverse()) as typeof incoming.state.run
    const next = acceptGraphSnapshot(f.scope, incoming, f.next)
    expect(next.topology).toBe(f.next.topology)
    expect(next.state.nodes).toBe(f.next.state.nodes)
    expect(next.state.run).toBe(f.next.state.run)
  })

  it('does not accept a newer draft with matching node IDs as the pinned definition', () => {
    const f = fixture()
    const changed = structuredClone(f.snapshot)
    changed.asOfSequence = '1'
    changed.topology.nodes[0]!.position = { x: 100, y: 200 }
    expect(() => acceptGraphSnapshot(f.scope, changed, f.snapshot)).toThrow('GRAPH_SCOPE_MISMATCH')
    expect(() => acceptGraphSnapshot(f.scope, { ...f.snapshot, scope: { ...f.scope, workflowVersionId: 'next-draft' } })).toThrow('GRAPH_SCOPE_MISMATCH')
  })

  it('makes Stop and terminal facts monotonic without preventing cleanup updates', () => {
    const f = start()
    const stop = reduceGraphPage(f.next, page(f.scope, [batch(f.scope, '2', [
      { type: 'run.state', state: { ...f.next.state.run, stopRequested: true, cleanupPending: true } },
    ], 2)])).snapshot
    expect(() => reduceGraphPage(stop, page(f.scope, [batch(f.scope, '3', [queued(f, 1)], 3)]))).toThrow('GRAPH_STOP_CONFLICT')
    expect(() => reduceGraphPage(stop, page(f.scope, [batch(f.scope, '3', [{ type: 'run.state', state: f.next.state.run }], 3)]))).toThrow('GRAPH_STOP_CONFLICT')
    const terminal = reduceGraphPage(stop, page(f.scope, [batch(f.scope, '3', [
      { type: 'run.state', state: { ...stop.state.run, executionState: 'completed', outcome: 'canceled' } },
    ], 3)])).snapshot
    expect(graphNeedsPolling(terminal)).toBe(true)
    expect(reduceGraphPage(terminal, page(f.scope, [batch(f.scope, '1', [queued(f)])])).snapshot).toBe(terminal)
    const settled = reduceGraphPage(terminal, page(f.scope, [batch(f.scope, '4', [
      { type: 'run.state', state: { ...terminal.state.run, cleanupPending: false } },
    ], 4)])).snapshot
    expect(graphNeedsPolling(settled)).toBe(false)
    expect(() => acceptGraphSnapshot(f.scope, { ...settled, asOfSequence: '5', state: { ...settled.state, run: f.snapshot.state.run } }, settled)).toThrow()
  })

  it.each(['unknown', 'uncertain', 'interrupted'] as const)('keeps %s unavailable rather than Idle/success/Working', (lifecycle) => {
    const f = fixture()
    const input = { ...f.snapshot.state.nodes[0]!, state: { workflowNodeId: f.identities[0]!.workflowNodeId,
      lifecycle, ...(lifecycle !== 'unknown' ? { execution: f.identities[0]! } : {}) } }
    const view = presentRunGraphNode(input)
    expect(view.activity).toBe('Activity unavailable')
    expect(view.lifecycle).not.toMatch(/Idle|Succeeded|Failed|Working/)
  })

  it('requires native acknowledgement and never interprets keepalives as semantic activity', () => {
    const f = start()
    const activity = { workflowNodeId: f.identities[0]!.workflowNodeId, status: 'active', action: 'working', execution: f.identities[0]! }
    expect(() => reduceGraphPage(f.next, page(f.scope, [batch(f.scope, '2', [{ type: 'node.activity', activity } as GraphFact], 2)]))).toThrow('GRAPH_INVALID_PAGE')
    expect(() => reduceGraphPage(f.next, page(f.scope, [batch(f.scope, '2', [{ type: 'keepalive' } as unknown as GraphFact], 2)]))).toThrow('GRAPH_INVALID_PAGE')
    expect(presentRunGraphNode(undefined)).toEqual({ lifecycle: 'Lifecycle unavailable', activity: 'Activity unavailable', tone: 'neutral' })
  })

  it('keeps polling independently exposed settlement after terminal outcome', () => {
    const f = start()
    const done: RunGraphSnapshot = { ...f.next, state: { ...f.next.state,
      run: { ...f.next.state.run, executionState: 'completed', outcome: 'succeeded' },
      interactions: [{ interactionId: 'i', revision: '1', requester: f.identities[0]!, handler: 'user',
        status: 'canceled', deliveryState: 'not_started', resumeState: 'unknown' }],
    } }
    expect(graphNeedsPolling(done)).toBe(true)
    expect(graphNeedsPolling({ ...done, state: { ...done.state, interactions: [] } })).toBe(false)
  })
})
