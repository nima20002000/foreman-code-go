import { createHash } from 'node:crypto'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import type { NativePluginCatalog, PluginConfiguration } from './codexPluginCatalog.js'

/** Persisted plugin identities depend on the frozen numeric-keys-first legacy form. */
export const pluginCanonical: (value: unknown) => string = canonicalJsonNumericKeysFirstLegacy
export const pluginHash = (value: unknown): string => `sha256:${createHash('sha256').update(pluginCanonical(value)).digest('hex')}`
export function pluginCatalogRevision(native: NativePluginCatalog, hints: readonly string[], configuration: PluginConfiguration, status: 'complete' | 'partial'): string {
  const normalized = [...native.installed, ...native.available].map((entry) => ({ ...entry, version: entry.version ?? null }))
    .sort((a, b) => pluginCanonical(a).localeCompare(pluginCanonical(b)))
  return pluginHash([normalized, [...new Set(hints)].sort(), configuration, status])
}
export function pluginSourceIdentities(entry: NativePluginCatalog['installed'][number]) {
  const source = { pluginId: entry.pluginId, name: entry.name, marketplaceName: entry.marketplaceName,
    source: entry.source, marketplaceSource: entry.marketplaceSource ?? null,
    installPolicy: entry.installPolicy, authPolicy: entry.authPolicy }
  return { sourceIdentity: pluginHash(source), artifactIdentity: pluginHash({ ...source, version: entry.version ?? null }) }
}
