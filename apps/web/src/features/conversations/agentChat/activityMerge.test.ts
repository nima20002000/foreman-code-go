import { describe, expect, it } from 'vitest'
import type { ActivityItem, ActivitySnapshotV1 } from '@graphql/contracts/activity'
import { activityScopeKey, reconcileActivityScopes, reconcileActivitySnapshot } from './activityMerge'
const scope = { kind: 'operator_chat' as const, conversationId: 'chat-a' }
const text = (id: string, revision: string, content: string, final = false): ActivityItem => ({ id, revision, order: id === 'old' ? '1' : '2', owner: { kind: 'chat_request', conversationId: 'chat-a', requestId: 'request-a' }, source: { schemaVersion: 1, system: 'test', observedAt: '2026-10-01T00:00:00Z' }, evidence: 'confirmed', kind: 'text', text: content, finality: final ? 'authoritative_final' : 'provisional' })
const snapshot = (revision: string, activities: ActivityItem[] = []): ActivitySnapshotV1 => ({ schemaVersion: 1, scope, revision, active: [], queued: [], latest: null, pendingInteractions: [], activities, page: { before: null, nextCursor: null, hasMore: false } })
describe('scope and entity revision reconciliation', () => {
  it('stale history fills absent entries while preserving active A/newer queued B and current page', () => {
    const current = snapshot('12', [text('live', '8', 'final', true)])
    current.active = [{ ref: { kind: 'chat_request', conversationId: 'chat-a', requestId: 'A' }, phase: 'active', outcome: null, delivery: 'accepted', evidence: 'confirmed', startedAt: null }]
    current.queued = [{ kind: 'chat_request', conversationId: 'chat-a', requestId: 'B' }]; current.latest = current.queued[0]!
    const merged = reconcileActivitySnapshot(current, snapshot('11', [text('old', '1', 'historical'), text('live', '7', 'partial')]), scope)!
    expect(merged.active).toEqual(current.active); expect(merged.queued).toEqual(current.queued); expect(merged.latest).toEqual(current.latest)
    expect(merged.revision).toBe('12'); expect(merged.activities.map((item) => item.id)).toEqual(['old', 'live'])
    expect(merged.activities[1]).toEqual(current.activities[0])
  })
  it('accepts shorter/empty finals but refuses lower item revisions and late provisional text', () => {
    let current = snapshot('1', [text('live', '1', 'long provisional')])
    current = reconcileActivitySnapshot(current, snapshot('2', [text('live', '2', '', true)]), scope)!
    current = reconcileActivitySnapshot(current, snapshot('3', [text('live', '3', 'late')]), scope)!
    expect(current.activities[0]).toEqual(text('live', '2', '', true))
    current = reconcileActivitySnapshot(current, snapshot('4', [text('live', '1', 'old', true)]), scope)!
    expect(current.activities[0]).toEqual(text('live', '2', '', true))
  })
  it('rejects old selection scopes and bounds history without comparing board counters', () => {
    const current = snapshot('100', [text('live', '1', 'a')])
    const other = { ...snapshot('1'), scope: { ...scope, conversationId: 'chat-b' } }
    expect(reconcileActivitySnapshot(current, other, scope)).toBe(current)
    const vector = reconcileActivityScopes(new Map([[activityScopeKey(scope), current]]), other)
    expect(vector.size).toBe(2); expect(vector.get(activityScopeKey(scope))!.revision).toBe('100')
    const bounded = reconcileActivitySnapshot(current, snapshot('101', [text('old', '1', 'b')]), scope, 1)!
    expect(bounded.activities.map((item) => item.id)).toEqual(['live'])
  })
  it('equal revisions retain canonical entity content and work state', () => {
    const current = snapshot('4', [text('live', '2', 'same', true)])
    expect(reconcileActivitySnapshot(current, snapshot('4', [text('live', '2', 'different', true)]), scope)!.activities).toEqual(current.activities)
  })
})
