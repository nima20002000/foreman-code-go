import type { OperatorActivity } from '@graphql/contracts'
import type { ActivityItem, ActivityScope, ActivitySnapshotV1 } from '@graphql/contracts/activity'

/** Canonical structural scope key; object property insertion order is not identity. */
export function activityScopeKey(scope: ActivityScope): string {
  const canonical = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
  return JSON.stringify(canonical(scope))
}
export function sourceVectorIsStale(current: ActivitySnapshotV1, incoming: ActivitySnapshotV1): boolean {
  const known = new Map(current.sourceRevisions?.map((source) => [JSON.stringify([source.source, source.id]), source.revision]))
  return incoming.sourceRevisions?.some((source) => { const previous = known.get(JSON.stringify([source.source, source.id])); return previous !== undefined && BigInt(source.revision) < BigInt(previous) }) ?? false
}

export function mergeActivityItems(current: readonly ActivityItem[], incoming: readonly ActivityItem[], limit = 1000): ActivityItem[] {
  const items = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    const previous = items.get(item.id)
    if (previous && BigInt(item.revision) <= BigInt(previous.revision)) continue
    if (previous?.kind === 'text' && previous.finality === 'authoritative_final'
      && (item.kind !== 'text' || item.finality !== 'authoritative_final')) continue
    items.set(item.id, item)
  }
  return [...items.values()].sort((a, b) => {
    // Table-local sequences are comparable only within their own ordering domain.
    if (a.orderSource !== b.orderSource) return (a.orderSource ?? '').localeCompare(b.orderSource ?? '')
    return BigInt(a.order) < BigInt(b.order) ? -1 : BigInt(a.order) > BigInt(b.order) ? 1 : a.id.localeCompare(b.id)
  }).slice(-limit)
}
/** Stale history may fill missing items; it cannot replace live owners, capabilities or paging metadata. */
export function reconcileActivitySnapshot(current: ActivitySnapshotV1 | undefined, incoming: ActivitySnapshotV1,
  selectedScope: ActivityScope, limit = 1000): ActivitySnapshotV1 | undefined {
  const key = activityScopeKey(selectedScope)
  if (activityScopeKey(incoming.scope) !== key) return current
  if (!current || activityScopeKey(current.scope) !== key) return { ...incoming, activities: mergeActivityItems([], incoming.activities, limit) }
  if (BigInt(incoming.revision) <= BigInt(current.revision) || sourceVectorIsStale(current, incoming)) {
    const known = new Set(current.activities.map((item) => item.id))
    return { ...current, activities: mergeActivityItems(current.activities, incoming.activities.filter((item) => !known.has(item.id)), limit) }
  }
  return { ...incoming, activities: mergeActivityItems(current.activities, incoming.activities, limit) }
}
/** A board keeps a revision vector; counters from different owners are never compared. */
export function reconcileActivityScopes(current: ReadonlyMap<string, ActivitySnapshotV1>, incoming: ActivitySnapshotV1): Map<string, ActivitySnapshotV1> {
  const next = new Map(current), key = activityScopeKey(incoming.scope)
  next.set(key, reconcileActivitySnapshot(next.get(key), incoming, incoming.scope)!)
  return next
}


/** Feed reconciled canonical status into the current transcript without redefining legacy activity shapes. */
export function applyCanonicalActivityItems(entries: readonly OperatorActivity[], snapshot: ActivitySnapshotV1 | undefined): OperatorActivity[] {
  const canonical = new Map(snapshot?.activities.map((item) => [item.id, item]))
  return entries.map((entry) => {
    const item = canonical.get(entry.id)
    if (!item || item.owner.kind !== 'chat_request' || item.owner.requestId !== entry.requestId) return entry
    if (item.kind === 'tool' || item.kind === 'subagent') return { ...entry, title: item.title, status: item.status }
    if (item.kind === 'reasoning_summary') return { ...entry, title: item.summary }
    return entry
  })
}
