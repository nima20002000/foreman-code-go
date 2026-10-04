import { APP_MCP_PATH, APP_MCP_SERVER_NAME, APP_MCP_TOKEN, LEGACY_APP_MCP_SERVER_NAMES, appLauncherConnection, isAppLauncher } from './appMcpLauncher.js'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { HarnessMcpChange, HarnessMcpConnection, HarnessMcpList, HarnessMcpManagedPreset } from '@foreman-code/contracts/management'
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
export function managedName(preset: HarnessMcpManagedPreset): string { return preset === 'graphql' ? APP_MCP_SERVER_NAME : 'linear' }
export function managedChange(preset: HarnessMcpManagedPreset, installed: boolean, _endpoint: string): HarnessMcpChange {
  void _endpoint // Existing callers also pass the endpoint used by legacy presets.
  const name = managedName(preset)
  return installed ? { kind: 'add', name, connection: preset === 'graphql' ? { ...appLauncherConnection(), environmentVariables: [] } : { transport: 'remote', url: LINEAR_MCP_ENDPOINT } }
    : { kind: 'remove', name }
}
export function managedEnableChange(preset: HarnessMcpManagedPreset, enabled: boolean): HarnessMcpChange {
  return { kind: 'enable', name: managedName(preset), enabled }
}

function remote(harness: NativeMcpSnapshot['harness'], entry: JsonObject, effective = false): boolean {
  if (typeof entry.url !== 'string' || entry.command !== undefined) return false
  return harness === 'opencode' ? entry.type === 'remote'
    : entry.type === undefined || (effective && entry.type === 'streamable_http')
}
function authorizationHeaders(value: unknown): [string, unknown][] {
  return Object.entries(record(value)).filter(([key]) => key.toLowerCase() === 'authorization')
}
function appReference(harness: NativeMcpSnapshot['harness'], entry: JsonObject): boolean {
  if (isAppLauncher(harness, entry)) return harness === 'codex'
    || record(entry.environment)[APP_MCP_TOKEN] === `{env:${APP_MCP_TOKEN}}`
  if (harness === 'codex') return entry.bearer_token_env_var === APP_MCP_TOKEN
    && authorizationHeaders(entry.http_headers).length === 0 && authorizationHeaders(entry.env_http_headers).length === 0
  const headers = authorizationHeaders(entry.headers)
  return entry.oauth === false && headers.length === 1 && headers[0]![1] === `Bearer {env:${APP_MCP_TOKEN}}`
}
function standardAppRemote(harness: NativeMcpSnapshot['harness'], entry: JsonObject): boolean {
  if (!remote(harness, entry) || !appReference(harness, entry)) return false
  try {
    const url = new URL(String(entry.url))
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.pathname === APP_MCP_PATH && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
/** Pre-unification app entries in the user file. Installing the graphql preset removes them in the same write. */
export function legacyAppEntries(snapshot: NativeMcpSnapshot): string[] {
  return LEGACY_APP_MCP_SERVER_NAMES.filter((name) => Object.hasOwn(snapshot.user, name) && snapshot.ownership?.[name] !== false)
}

/** A user-file member is not sufficient evidence that its settings are effective. */
export function userOwnsMcpEntry(snapshot: NativeMcpSnapshot, name: string): boolean {
  if (!Object.hasOwn(snapshot.user, name) || snapshot.ownership?.[name] === false) return false
  if (!Object.hasOwn(snapshot.effective, name)) return true
  const user = record(snapshot.user[name])
  const effective = record(snapshot.effective[name])
  if (isAppLauncher(snapshot.harness, user) !== isAppLauncher(snapshot.harness, effective)) return false
  if (user.url !== effective.url || (user.enabled !== false) !== (effective.enabled !== false)) return false
  if (remote(snapshot.harness, user) !== remote(snapshot.harness, effective, true)) return false
  if (snapshot.harness === 'codex' && (user.bearer_token_env_var ?? null) !== (effective.bearer_token_env_var ?? null)) return false
  // An OpenCode resolved Authorization value is a secret, not an environment reference.
  if (snapshot.harness === 'opencode' && name === APP_MCP_SERVER_NAME && appReference(snapshot.harness, user)
    && snapshot.credentialReferences?.[name] !== APP_MCP_TOKEN) return false
  return true
}

function managedNativeConnection(snapshot: NativeMcpSnapshot, preset: HarnessMcpManagedPreset): JsonObject {
  const name = managedName(preset)
  if (preset === 'graphql') {
    if (!Object.hasOwn(snapshot.user, name)) return nativeConnection(snapshot.harness, appLauncherConnection())
    const existing = record(snapshot.user[name])
    if (!standardAppRemote(snapshot.harness, existing) && !(isAppLauncher(snapshot.harness, existing) && appReference(snapshot.harness, existing))) {
      throw new DomainError('MCP_PRESET_CUSTOMIZED', 'The graphql entry has custom transport or authentication settings. Edit it at its native source.', 409)
    }
    // Do not reconstruct the entry. Native policy fields, including future supported
    // fields, must survive config/batchWrite's replace strategy and the JSONC edit.
    const preserved = { ...existing }
    for (const key of ['url', 'bearer_token_env_var', 'headers', 'oauth', 'type']) delete preserved[key]
    return { ...preserved, ...nativeConnection(snapshot.harness, appLauncherConnection()), enabled: existing.enabled !== false }
  }
  if (!Object.hasOwn(snapshot.user, name)) return nativeConnection(snapshot.harness, { transport: 'remote', url: LINEAR_MCP_ENDPOINT })
  const existing = record(snapshot.user[name])
  if (!remote(snapshot.harness, existing) || (existing.url !== LINEAR_MCP_ENDPOINT && existing.url !== LINEAR_READ_WRITE_ENDPOINT)) {
    throw new DomainError('MCP_PRESET_CUSTOMIZED',
      'This entry has custom transport or authentication settings. Review it in the native configuration; automatic repair would not be safe.', 409)
  }
  return { ...existing, url: LINEAR_MCP_ENDPOINT, enabled: true }
}
export function managedStatus(snapshot: NativeMcpSnapshot, preset: HarnessMcpManagedPreset, _endpoint?: string) {
  void _endpoint // The graphql preset is a launcher; routing follows the owning app automatically.
  const name = managedName(preset)
  const legacy = preset === 'graphql' && legacyAppEntries(snapshot).length > 0
  if (!Object.hasOwn(snapshot.effective, name) && !Object.hasOwn(snapshot.user, name)) return legacy ? 'legacy' as const : 'missing' as const
  if (!userOwnsMcpEntry(snapshot, name)) return 'inherited' as const
  const entry = record(snapshot.user[name])
  const effective = record(snapshot.effective[name])
  if (preset === 'graphql') {
    const reference = appReference(snapshot.harness, entry) && (snapshot.harness === 'codex'
      ? appReference(snapshot.harness, effective) : snapshot.credentialReferences?.[name] === APP_MCP_TOKEN)
    if (!isAppLauncher(snapshot.harness, entry) || !isAppLauncher(snapshot.harness, effective) || !reference) return 'mismatch' as const
    if (legacy) return 'legacy' as const
    return entry.enabled === false || effective.enabled === false ? 'disabled' as const : 'installed' as const
  }
  // Linear is not an exception to the protected application-credential boundary.
  if (protectedServer(name, entry) || protectedServer(name, effective)) return 'mismatch' as const
  if (!remote(snapshot.harness, entry) || !remote(snapshot.harness, effective, true)) return 'mismatch' as const
  return entry.url === LINEAR_MCP_ENDPOINT
    ? entry.enabled === false || effective.enabled === false ? 'disabled' as const : 'installed' as const : 'mismatch' as const
}
export function assertManagedChange(snapshot: NativeMcpSnapshot, change: HarnessMcpChange,
  preset: HarnessMcpManagedPreset, endpoint: string): void {
  const expected = change.kind === 'enable' ? managedEnableChange(preset, change.enabled)
    : managedChange(preset, change.kind === 'add', endpoint)
  if (fingerprint(change) !== fingerprint(expected)) {
    throw new DomainError('MCP_PRESET_INVALID', 'The requested MCP preset does not match the server-managed connection.', 409)
  }
  if (preset === 'linear' && (protectedServer(change.name, snapshot.user[change.name])
    || protectedServer(change.name, snapshot.effective[change.name]))) {
    throw new DomainError('MCP_SERVER_PROTECTED', 'Application credential-bearing connections cannot be changed as a Linear preset.', 403)
  }
  const status = managedStatus(snapshot, preset, endpoint)
  if (change.kind === 'add' && status !== 'missing' && status !== 'mismatch' && status !== 'legacy') {
    throw new DomainError('MCP_SERVER_EXISTS', 'This MCP server already has a native configuration. Inspect it before changing the preset.', 409)
  }
  if (change.kind === 'add') managedNativeConnection(snapshot, preset)
  if (change.kind === 'remove' && status !== 'installed' && status !== 'disabled')
    throw new DomainError('MCP_PRESET_MISMATCH', 'Only the matching user-owned preset can be removed here.', 409)
  if (change.kind === 'enable' && status !== (change.enabled ? 'disabled' : 'installed'))
    throw new DomainError('MCP_PRESET_MISMATCH', 'Only a matching user-owned preset can be enabled or disabled here.', 409)
}
export function protectedServer(name: string, entry: unknown): boolean {
  if (/^(graphql[-_]|__)/i.test(name) || ['graphql', 'app', 'operator'].includes(name.toLowerCase())) return true
  // Also protect renamed credential-bearing application entries. This value never leaves the adapter.
  return /GRAPHQL_(?:(?:APP|OPERATOR)_)?MCP_TOKEN|\/mcp\/(?:tools|operator)(?:["'/?\s]|$)|\/graphql\/(?:mcp|worker-mcp|operator-mcp)\/launcher\.mjs/i.test(JSON.stringify(entry))
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
    return change.kind === 'add' ? managedNativeConnection(snapshot, managed.preset)
      : change.kind === 'enable' ? { ...record(snapshot.user[change.name]), enabled: change.enabled } : undefined
  }
  assertChange(snapshot, change)
  if (change.kind === 'remove') return undefined
  if (change.kind === 'add') return nativeConnection(snapshot.harness, change.connection)
  return { ...record(snapshot.user[change.name]), enabled: change.enabled }
}
/** Every user-file member one change writes. A graphql install also retires the legacy app entries. */
export function mcpEdits(snapshot: NativeMcpSnapshot, change: HarnessMcpChange,
  managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): { name: string; value: JsonObject | undefined }[] {
  const edits = [{ name: change.name, value: replacement(snapshot, change, managed) }]
  if (managed?.preset === 'graphql' && change.kind === 'add') {
    for (const name of legacyAppEntries(snapshot)) edits.push({ name, value: undefined })
  }
  return edits
}
export function applyMcpEdits(user: JsonObject, edits: readonly { name: string; value: JsonObject | undefined }[]): JsonObject {
  const next = { ...user }
  for (const edit of edits) { if (edit.value === undefined) delete next[edit.name]; else next[edit.name] = edit.value }
  return next
}
export function mcpUserFingerprint(snapshot: NativeMcpSnapshot): string {
  const key = snapshot.harness === 'codex' ? 'mcp_servers' : 'mcp'
  return fingerprint({ ...snapshot.userConfig, [key]: snapshot.user })
}
/** Opaque durable evidence; the raw native configuration never enters a receipt. */
export function expectedMcpUserFingerprint(snapshot: NativeMcpSnapshot, change: HarnessMcpChange,
  managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): string {
  const user = applyMcpEdits(snapshot.user, mcpEdits(snapshot, change, managed))
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
      if (name === APP_MCP_SERVER_NAME && isAppLauncher(snapshot.harness, entry)) label = 'Automatic app connection'
      if ((LEGACY_APP_MCP_SERVER_NAMES as readonly string[]).includes(name)) label = 'Legacy app connection · replaced by graphql'
      let endpoint: string | undefined
      if (remote) { try {
        const url = new URL(String(entry.url))
        label = url.origin
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
          && ((name === APP_MCP_SERVER_NAME && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === APP_MCP_PATH)
            || (name === 'linear' && url.protocol === 'https:' && url.hostname === 'mcp.linear.app' && ['/mcp', '/mcp/readonly'].includes(url.pathname)))) endpoint = url.toString()
      } catch { label = 'Remote connection' } }
      const locked = protectedServer(name, entry) || protectedServer(name, snapshot.user[name])
      const owned = userOwnsMcpEntry(snapshot, name)
      return { name, label, ...(endpoint ? { endpoint } : {}), transport: remote ? 'remote' : local ? 'stdio' : 'unknown', enabled: entry.enabled !== false,
        origin: owned ? 'user' : 'inherited', protected: locked, editable: owned && !locked }
    }) }
}
