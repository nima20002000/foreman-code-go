import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver, skipToken } from '@tanstack/react-query'
import { selectGraphNode, shareGraphRecordOrSelection } from './cache'
import { createRunViewTopologyProjector } from './topology'
import { reduceGraphPage } from './reducer'
import type { RunGraphRecord } from './types'
import { batch, fixture, largeFixture, page } from './testFixtures'

function record(): RunGraphRecord {
  const f = fixture()
  return { kind: 'run-graph-cache', scope: f.scope, epoch: 1, facts: { reader: 'graph', snapshot: f.snapshot },
    transport: { phase: 'live', confirmedAt: 1 } }
}

describe('canonical Query records and selected slices', () => {
  it('shares complete records, scalar selections, absent values, and entity selections safely', () => {
    const before = record()
    const after = structuredClone(before)
    expect(shareGraphRecordOrSelection(before, after)).toBe(before)
    for (const value of [undefined, 3, 'unknown', { state: 'uncertain' }, [1, 2]]) {
      expect(shareGraphRecordOrSelection(value, structuredClone(value))).toEqual(value)
    }
    const node = selectGraphNode(before, before.facts!.reader === 'graph' ? before.facts!.snapshot.topology.nodes[0]!.workflowNodeId : '')
    expect(shareGraphRecordOrSelection(node, structuredClone(node))).toBe(node)
    expect(() => shareGraphRecordOrSelection({ kind: 'run-graph-cache', scope: null }, { kind: 'run-graph-cache', scope: null })).not.toThrow()
  })
  it('does not let a lower cursor or obsolete epoch overwrite a newer canonical fact', () => {
    const before = record()
    if (before.facts?.reader !== 'graph') throw new Error('fixture')
    before.facts.snapshot.asOfSequence = '9007199254740994'
    const old = structuredClone(before)
    if (old.facts?.reader === 'graph') old.facts.snapshot.asOfSequence = '9007199254740993'
    expect(shareGraphRecordOrSelection(before, old)).toBe(before)
    expect(shareGraphRecordOrSelection(before, { ...before, epoch: 0 })).toBe(before)
  })
  it('keeps static render arrays and untouched selected entities stable for one activity-only update', () => {
    const f = fixture()
    const before = record()
    const project = createRunViewTopologyProjector()
    const graph = project(f.snapshot.topology)
    const updated = reduceGraphPage(f.snapshot, page(f.scope, [batch(f.scope, '1', [
      { type: 'node.activity', activity: { workflowNodeId: f.identities[0]!.workflowNodeId, status: 'none' } },
    ])])).snapshot
    const after: RunGraphRecord = { ...before, facts: { reader: 'graph', snapshot: updated } }
    // Compare against the exact fact base used by the update, not an independently allocated fixture.
    before.facts = { reader: 'graph', snapshot: f.snapshot }
    expect(selectGraphNode(after, f.identities[1]!.workflowNodeId)).toBe(selectGraphNode(before, f.identities[1]!.workflowNodeId))
    expect(project(updated.topology)).toBe(graph)
    expect(project(updated.topology).nodes).toBe(graph.nodes)
    expect(project(updated.topology).edges).toBe(graph.edges)
  })
  it.each([300, 500])('retains unaffected selected observers in a %i-node synthetic graph (not browser profiling)', (count) => {
    const f = largeFixture(count)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    const key = ['synthetic-slices', count]
    const initial: RunGraphRecord = { ...record(), facts: { reader: 'graph', snapshot: f.snapshot } }
    client.setQueryData(key, initial)
    const listeners = Array.from({ length: count - 1 }, () => vi.fn())
    const unsubscribes = listeners.map((listener, index) => new QueryObserver<RunGraphRecord, Error, ReturnType<typeof selectGraphNode>>(client, {
      queryKey: key, queryFn: skipToken, enabled: false, staleTime: Infinity, notifyOnChangeProps: ['data'],
      select: (data) => selectGraphNode(data, f.snapshot.topology.nodes[index + 1]!.workflowNodeId), structuralSharing: shareGraphRecordOrSelection,
    }).subscribe(listener))
    for (const listener of listeners) listener.mockClear()
    const updated = reduceGraphPage(f.snapshot, page(f.scope, [batch(f.scope, '1', [
      { type: 'node.activity', activity: { workflowNodeId: f.snapshot.topology.nodes[0]!.workflowNodeId, status: 'none' } },
    ])])).snapshot
    client.setQueryData<RunGraphRecord>(key, { ...initial, facts: { reader: 'graph', snapshot: updated } })
    for (const listener of listeners) expect(listener).not.toHaveBeenCalled()
    for (const unsubscribe of unsubscribes) unsubscribe()
    client.clear()
  })
})
