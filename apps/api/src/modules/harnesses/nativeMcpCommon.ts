import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { HarnessMcpChange, HarnessMcpConnection, HarnessMcpList, HarnessMcpManagedPreset } from '@graphql/contracts/management'
import { canonical } from './codexProtocol.js'
import { DomainError } from '../errors.js'
export type JsonObject = Record<string, unknown>
export const record = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
export const fingerprint = (value: unknown): string => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
export interface NativeMcpSnapshot { harness: 'codex' | 'opencode'; revision: string; effective: JsonObject; user: JsonObject; userConfig: JsonObject; version: string; file: string }
export interface NativeMcpAdapter {
  read(signal: AbortSignal): Promise<NativeMcpSnapshot>
  /** Called once after the durable submitting marker. Must never replay an uncertain write. */
  apply(snapshot: NativeMcpSnapshot, change: HarnessMcpChange, signal: AbortSignal,
    managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): Promise<void>
}
export const LINEAR_MCP_ENDPOINT = 'https://mcp.linear.app/mcp/readonly'
export function managedName(preset: HarnessMcpManagedPreset): string { return preset === 'operator' ? 'graphql-operator' : 'linear' }
export function managedChange(preset: HarnessMcpManagedPreset, installed: boolean, endpoint: string): HarnessMcpChange {
  const name = managedName(preset)
  return installed ? { kind: 'add', name, connection: { transport: 'remote', url: preset === 'operator' ? endpoint : LINEAR_MCP_ENDPOINT } }
    : { kind: 'remove', name }
}
function managedNativeConnection(snapshot: NativeMcpSnapshot, preset: HarnessMcpManagedPreset, endpoint: string): JsonObject {
  const url = preset === 'operator' ? endpoint : LINEAR_MCP_ENDPOINT
  return nativeConnection(snapshot.harness, { transport: 'remote', url,
    ...(preset === 'operator' ? { bearerTokenEnvironmentVariable: 'GRAPHQL_OPERATOR_MCP_TOKEN' } : {}) })
}
export function managedStatus(snapshot: NativeMcpSnapshot, preset: HarnessMcpManagedPreset, endpoint: string) {
  const name = managedName(preset)
  if (!Object.hasOwn(snapshot.effective, name) && !Object.hasOwn(snapshot.user, name)) return 'missing' as const
  if (!Object.hasOwn(snapshot.user, name)) return 'inherited' as const
  const entry = record(snapshot.user[name])
  const effective = record(snapshot.effective[name])
  if (effective.url !== entry.url) return 'inherited' as const
  const url = entry.url
  if (entry.enabled === false || effective.enabled === false) return 'mismatch' as const
  if (entry.command !== undefined || (snapshot.harness === 'opencode' && entry.type !== 'remote')) return 'mismatch' as const
  if (preset === 'linear') return url === LINEAR_MCP_ENDPOINT || url === 'https://mcp.linear.app/mcp'
    ? 'installed' as const : 'mismatch' as const
  if (url !== endpoint) return 'mismatch' as const
  return snapshot.harness === 'codex'
    ? entry.bearer_token_env_var === 'GRAPHQL_OPERATOR_MCP_TOKEN' ? 'installed' as const : 'mismatch' as const
    : entry.oauth === false && record(entry.headers).Authorization === 'Bearer {env:GRAPHQL_OPERATOR_MCP_TOKEN}'
      ? 'installed' as const : 'mismatch' as const
}
export function assertManagedChange(snapshot: NativeMcpSnapshot, change: HarnessMcpChange,
  preset: HarnessMcpManagedPreset, endpoint: string): void {
  const install = change.kind === 'add'
  if (fingerprint(change) !== fingerprint(managedChange(preset, install, endpoint))) {
    throw new DomainError('MCP_PRESET_INVALID', 'The requested MCP preset does not match the server-managed connection.', 409)
  }
  const status = managedStatus(snapshot, preset, endpoint)
  if (install && status !== 'missing' && !(preset === 'operator' && status === 'mismatch')) {
    throw new DomainError('MCP_SERVER_EXISTS', 'This MCP server already has a native configuration. Inspect it before changing the preset.', 409)
  }
  if (!install && status !== 'installed') throw new DomainError('MCP_PRESET_MISMATCH', 'Only the matching user-owned preset can be removed here.', 409)
}
export function protectedServer(name: string, entry: unknown): boolean {
  if (/^(graphql[-_]|__)/i.test(name) || ['graphql', 'app', 'operator'].includes(name.toLowerCase())) return true
  // Also protect renamed credential-bearing application entries. This value never leaves the adapter.
  return /GRAPHQL_(?:APP|OPERATOR)_MCP_TOKEN|\/mcp\/(?:tools|operator)(?:["'/?\s]|$)/i.test(JSON.stringify(entry))
}
export function assertChange(snapshot: NativeMcpSnapshot, change: HarnessMcpChange): void {
  const current = snapshot.effective[change.name]
  if (protectedServer(change.name, current) || protectedServer(change.name, snapshot.user[change.name])
    || (change.kind === 'add' && protectedServer(change.name, nativeConnection(snapshot.harness, change.connection)))) {
    throw new DomainError('MCP_SERVER_PROTECTED', 'Application MCP connections are managed by the server and cannot be changed here.', 403)
  }
  if (change.kind === 'add' && (Object.hasOwn(snapshot.effective, change.name) || Object.hasOwn(snapshot.user, change.name))) {
    throw new DomainError('MCP_SERVER_EXISTS', 'That server name is already configured. Use a different name.', 409)
  }
  if (change.kind !== 'add' && !Object.hasOwn(snapshot.user, change.name)) {
    throw new DomainError('MCP_SERVER_INHERITED', 'This connection is inherited. Edit it at its original configuration source.', 409)
  }
}
export function nativeConnection(harness: 'codex' | 'opencode', input: HarnessMcpConnection): JsonObject {
  if (input.transport === 'remote') return harness === 'codex'
    ? { url: input.url, enabled: true, ...(input.bearerTokenEnvironmentVariable ? { bearer_token_env_var: input.bearerTokenEnvironmentVariable } : {}) }
    : { type: 'remote', url: input.url, enabled: true, ...(input.bearerTokenEnvironmentVariable
      ? { oauth: false, headers: { Authorization: `Bearer {env:${input.bearerTokenEnvironmentVariable}}` } } : {}) }
  return harness === 'codex'
    ? { command: input.executable, args: input.arguments, env_vars: input.environmentVariables, enabled: true }
    : { type: 'local', command: [input.executable, ...input.arguments], enabled: true,
      environment: Object.fromEntries(input.environmentVariables.map((name) => [name, `{env:${name}}`])) }
}
export function replacement(snapshot: NativeMcpSnapshot, change: HarnessMcpChange,
  managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): JsonObject | undefined {
  if (managed) {
    assertManagedChange(snapshot, change, managed.preset, managed.endpoint)
    return change.kind === 'add' ? managedNativeConnection(snapshot, managed.preset, managed.endpoint) : undefined
  }
  assertChange(snapshot, change)
  if (change.kind === 'remove') return undefined
  if (change.kind === 'add') return nativeConnection(snapshot.harness, change.connection)
  return { ...record(snapshot.user[change.name]), enabled: change.enabled }
}
export function publicMcpList(snapshot: NativeMcpSnapshot): HarnessMcpList {
  const names = [...new Set([...Object.keys(snapshot.effective), ...Object.keys(snapshot.user)])].sort()
  if (names.length > 500) throw new DomainError('MCP_CATALOG_TOO_LARGE', 'The native MCP catalog exceeds the 500-server limit.', 502)
  return { harness: snapshot.harness, revision: snapshot.revision, scope: 'native-user', checkedAt: new Date().toISOString(),
    servers: names.map((name) => {
      const entry = record(snapshot.effective[name] ?? snapshot.user[name])
      const local = entry.command !== undefined || entry.type === 'local'
      const remote = typeof entry.url === 'string'
      let label = local ? 'Local program' : 'Native connection'
      if (local) { const command = Array.isArray(entry.command) ? entry.command[0] : entry.command; if (typeof command === 'string') label = basename(command) }
      let endpoint: string | undefined
      if (remote) { try {
        const url = new URL(String(entry.url))
        label = url.origin
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
          && ((name === 'graphql-app' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/mcp/tools')
            || (name === 'graphql-operator' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/mcp/operator')
            || (name === 'linear' && url.protocol === 'https:' && url.hostname === 'mcp.linear.app' && ['/mcp', '/mcp/readonly'].includes(url.pathname)))) endpoint = url.toString()
      } catch { label = 'Remote connection' } }
      const locked = protectedServer(name, entry) || protectedServer(name, snapshot.user[name])
      const owned = Object.hasOwn(snapshot.user, name)
      return { name, label, ...(endpoint ? { endpoint } : {}), transport: remote ? 'remote' : local ? 'stdio' : 'unknown', enabled: entry.enabled !== false,
        origin: owned ? 'user' : 'inherited', protected: locked, editable: owned && !locked }
    }) }
}
