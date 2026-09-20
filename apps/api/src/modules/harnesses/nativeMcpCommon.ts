import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { HarnessMcpChange, HarnessMcpConnection, HarnessMcpList, HarnessMcpManagedPreset } from '@graphql/contracts/management'
import { canonical } from './codexProtocol.js'
import { DomainError } from '../errors.js'
export type JsonObject = Record<string, unknown>
export const record = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
export const fingerprint = (value: unknown): string => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
export interface NativeMcpSnapshot {
  harness: 'codex' | 'opencode'; revision: string; effective: JsonObject; user: JsonObject
  userConfig: JsonObject; version: string; file: string
  /** False means that the effective member has another native configuration source. */
  ownership?: Readonly<Record<string, boolean>>
  /** Only provider-proven references; never infer these from expanded header values. */
  credentialReferences?: Readonly<Record<string, string>>
}
export interface NativeMcpAdapter {
  read(signal: AbortSignal): Promise<NativeMcpSnapshot>
  /** Called once after the durable submitting marker. Must never replay an uncertain write. */
  apply(snapshot: NativeMcpSnapshot, change: HarnessMcpChange, signal: AbortSignal,
    managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): Promise<void>
}
export const LINEAR_MCP_ENDPOINT = 'https://mcp.linear.app/mcp/readonly'
const LINEAR_READ_WRITE_ENDPOINT = 'https://mcp.linear.app/mcp'
const OPERATOR_CREDENTIAL = 'GRAPHQL_OPERATOR_MCP_TOKEN'
export function managedName(preset: HarnessMcpManagedPreset): string { return preset === 'operator' ? 'graphql-operator' : 'linear' }
export function managedChange(preset: HarnessMcpManagedPreset, installed: boolean, endpoint: string): HarnessMcpChange {
  const name = managedName(preset)
  return installed ? { kind: 'add', name, connection: { transport: 'remote', url: preset === 'operator' ? endpoint : LINEAR_MCP_ENDPOINT } }
    : { kind: 'remove', name }
}

function remote(harness: NativeMcpSnapshot['harness'], entry: JsonObject, effective = false): boolean {
  if (typeof entry.url !== 'string' || entry.command !== undefined) return false
  return harness === 'opencode' ? entry.type === 'remote'
    : entry.type === undefined || (effective && entry.type === 'streamable_http')
}
function authorizationHeaders(value: unknown): [string, unknown][] {
  return Object.entries(record(value)).filter(([key]) => key.toLowerCase() === 'authorization')
}
function operatorReference(harness: NativeMcpSnapshot['harness'], entry: JsonObject): boolean {
  if (/GRAPHQL_APP_MCP_TOKEN/i.test(JSON.stringify(entry))) return false
  if (harness === 'codex') return entry.bearer_token_env_var === OPERATOR_CREDENTIAL
    && authorizationHeaders(entry.http_headers).length === 0
    && authorizationHeaders(entry.env_http_headers).length === 0
  const headers = authorizationHeaders(entry.headers)
  return entry.oauth === false && headers.length === 1 && typeof headers[0]![1] === 'string'
    && /^Bearer /i.test(headers[0]![1])
    && headers[0]![1].slice(7) === `{env:${OPERATOR_CREDENTIAL}}`
}

/** A user-file member is not sufficient evidence that its settings are effective. */
export function userOwnsMcpEntry(snapshot: NativeMcpSnapshot, name: string): boolean {
  if (!Object.hasOwn(snapshot.user, name) || snapshot.ownership?.[name] === false) return false
  if (!Object.hasOwn(snapshot.effective, name)) return true
  const user = record(snapshot.user[name])
  const effective = record(snapshot.effective[name])
  if (user.url !== effective.url || (user.enabled !== false) !== (effective.enabled !== false)) return false
  if (remote(snapshot.harness, user) !== remote(snapshot.harness, effective, true)) return false
  if (snapshot.harness === 'codex' && user.bearer_token_env_var !== effective.bearer_token_env_var) return false
  // An OpenCode resolved Authorization value is a secret, not an environment reference.
  if (snapshot.harness === 'opencode' && name === managedName('operator')
    && operatorReference(snapshot.harness, user)
    && snapshot.credentialReferences?.[name] !== OPERATOR_CREDENTIAL) return false
  return true
}

function managedNativeConnection(snapshot: NativeMcpSnapshot, preset: HarnessMcpManagedPreset, endpoint: string): JsonObject {
  const url = preset === 'operator' ? endpoint : LINEAR_MCP_ENDPOINT
  const name = managedName(preset)
  if (!Object.hasOwn(snapshot.user, name)) return nativeConnection(snapshot.harness, { transport: 'remote', url,
    ...(preset === 'operator' ? { bearerTokenEnvironmentVariable: OPERATOR_CREDENTIAL } : {}) })
  const existing = record(snapshot.user[name])
  if (!remote(snapshot.harness, existing)
    || (preset === 'operator' && !operatorReference(snapshot.harness, existing))
    || (preset === 'linear' && existing.url !== LINEAR_MCP_ENDPOINT && existing.url !== LINEAR_READ_WRITE_ENDPOINT)) {
    throw new DomainError('MCP_PRESET_CUSTOMIZED',
      'This entry has custom transport or authentication settings. Review it in the native configuration; automatic repair would not be safe.', 409)
  }
  // Do not reconstruct the entry. Native policy fields, including future supported
  // fields, must survive config/batchWrite's replace strategy and the JSONC edit.
  return { ...existing, url, enabled: true }
}
export function managedStatus(snapshot: NativeMcpSnapshot, preset: HarnessMcpManagedPreset, endpoint: string) {
  const name = managedName(preset)
  if (!Object.hasOwn(snapshot.effective, name) && !Object.hasOwn(snapshot.user, name)) return 'missing' as const
  if (!userOwnsMcpEntry(snapshot, name)) return 'inherited' as const
  const entry = record(snapshot.user[name])
  const effective = record(snapshot.effective[name])
  // Linear is not an exception to the protected application-credential boundary.
  if (preset === 'linear' && (protectedServer(name, entry) || protectedServer(name, effective))) return 'mismatch' as const
  if (!remote(snapshot.harness, entry) || !remote(snapshot.harness, effective, true)
    || entry.enabled === false || effective.enabled === false) return 'mismatch' as const
  if (preset === 'linear') return entry.url === LINEAR_MCP_ENDPOINT ? 'installed' as const : 'mismatch' as const
  if (entry.url !== endpoint || !operatorReference(snapshot.harness, entry)) return 'mismatch' as const
  const credentialMatches = snapshot.harness === 'codex' ? operatorReference(snapshot.harness, effective)
    : snapshot.credentialReferences?.[name] === OPERATOR_CREDENTIAL && effective.oauth === false
  return credentialMatches ? 'installed' as const : 'inherited' as const
}
export function assertManagedChange(snapshot: NativeMcpSnapshot, change: HarnessMcpChange,
  preset: HarnessMcpManagedPreset, endpoint: string): void {
  const install = change.kind === 'add'
  if (fingerprint(change) !== fingerprint(managedChange(preset, install, endpoint))) {
    throw new DomainError('MCP_PRESET_INVALID', 'The requested MCP preset does not match the server-managed connection.', 409)
  }
  if (preset !== 'operator' && (protectedServer(change.name, snapshot.user[change.name])
    || protectedServer(change.name, snapshot.effective[change.name]))) {
    throw new DomainError('MCP_SERVER_PROTECTED', 'Application credential-bearing connections cannot be changed as a Linear preset.', 403)
  }
  const status = managedStatus(snapshot, preset, endpoint)
  if (install && status !== 'missing' && status !== 'mismatch') {
    throw new DomainError('MCP_SERVER_EXISTS', 'This MCP server already has a native configuration. Inspect it before changing the preset.', 409)
  }
  if (install) managedNativeConnection(snapshot, preset, endpoint) // Reject unsafe repair during planning too.
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
  if (change.kind !== 'add' && !userOwnsMcpEntry(snapshot, change.name)) {
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
export function mcpUserFingerprint(snapshot: NativeMcpSnapshot): string {
  const key = snapshot.harness === 'codex' ? 'mcp_servers' : 'mcp'
  return fingerprint({ ...snapshot.userConfig, [key]: snapshot.user })
}
/** Opaque durable evidence; the raw native configuration never enters a receipt. */
export function expectedMcpUserFingerprint(snapshot: NativeMcpSnapshot, change: HarnessMcpChange,
  managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): string {
  const next = replacement(snapshot, change, managed)
  const user = { ...snapshot.user }
  if (next === undefined) delete user[change.name]; else user[change.name] = next
  const key = snapshot.harness === 'codex' ? 'mcp_servers' : 'mcp'
  return fingerprint({ ...snapshot.userConfig, [key]: user })
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
      if (remote) { try { const url = new URL(String(entry.url)); label = url.origin } catch { label = 'Remote connection' } }
      const locked = protectedServer(name, entry) || protectedServer(name, snapshot.user[name])
      const owned = userOwnsMcpEntry(snapshot, name)
      return { name, label, transport: remote ? 'remote' : local ? 'stdio' : 'unknown', enabled: entry.enabled !== false,
        origin: owned ? 'user' : 'inherited', protected: locked, editable: owned && !locked }
    }) }
}
