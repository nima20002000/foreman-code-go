/** Arrays are atomic: ordered permission policies must never be merged by index. */
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
export interface SettingsChange { path: string; before: unknown; after: unknown }

export function settingsChanges(before: unknown, after: unknown, prefix = ''): SettingsChange[] {
  if (same(before, after)) return []
  if (record(before) && record(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      settingsChanges(before[key], after[key], prefix ? `${prefix}.${key}` : key))
  }
  return [{ path: prefix || 'Settings', before, after }]
}

/** Explicit keep-my-edits action. Locally changed leaves win; untouched leaves use current defaults. */
export function reapplySettingsEdits<T>(base: T, draft: T, latest: T): T {
  if (same(base, draft)) return structuredClone(latest)
  if (record(base) && record(draft) && record(latest)) {
    // A provider change is an atomic replacement, not a union of incompatible configurations.
    if ('harness' in base && (base.harness !== draft.harness || base.harness !== latest.harness)) return structuredClone(draft)
    if ('configuration' in base && record(base.configuration) && record(draft.configuration) && record(latest.configuration)
      && (base.configuration.harness !== draft.configuration.harness || base.configuration.harness !== latest.configuration.harness)) return structuredClone(draft)
    const result: Record<string, unknown> = structuredClone(latest)
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
      if (same(base[key], draft[key])) continue
      if (!Object.hasOwn(draft, key)) delete result[key]
      else Object.defineProperty(result, key, { value: reapplySettingsEdits(base[key], draft[key], latest[key]),
        writable: true, enumerable: true, configurable: true })
    }
    return result as T
  }
  return structuredClone(draft)
}
