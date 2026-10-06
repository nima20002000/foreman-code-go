import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { appMcpServerName, appLauncherTokenName, isAppLauncher, isSupportedAppMcpServerName, isSupportedAppMcpTokenName } from './appMcpLauncher.js'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { HarnessExecutionError } from './errors.js'
import type { NativeMcpEntryEvidence, NativeMcpInspector } from './mcpDetection.js'
import { runCommand } from './process.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function authorization(entry: JsonObject): { key: string; value: string } | undefined {
  const headers = object(entry.headers)
  const matches = Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() === 'authorization')
  if (matches.length !== 1 || typeof matches[0]![1] !== 'string') return undefined
  return { key: matches[0]![0], value: matches[0]![1] }
}

function withoutAuthorization(entry: JsonObject): JsonObject {
  const headers = Object.fromEntries(Object.entries(object(entry.headers) ?? {})
    .filter(([name]) => name.toLowerCase() !== 'authorization'))
  const comparable: JsonObject = { ...entry, headers }
  if (entry.type === 'remote') {
    // Deep-merged remote entries can retain local fields that the provider does not use.
    delete comparable.command
    delete comparable.environment
  }
  return comparable
}

/**
 * `debug config` is the qualified provider's read-only, resolved-config command.
 * Resolution substitutes {env:...}; trying to recover its source with a regex
 * is unsound. Compare an unset-token resolution to a scoped NON-CREDENTIAL
 * marker resolution instead. The process helper removes the marker from output.
 * A literal marker/static bearer token/unrelated header cannot satisfy both.
 */
export async function inspectOpenCodeMcpConfiguration(input: {
  binary: string
  processRecovery?: NativeProcessRecovery
  assertInstallation?: (signal?: AbortSignal) => Promise<void>
  workingDirectory: string
  serverName: string
  signal?: AbortSignal
  pure?: boolean
  credentialEnvironmentVariable?: string
  exactServerName?: boolean
  onVersion?: (version: string) => void
}): Promise<NativeMcpEntryEvidence | undefined> {
  let selectedName = input.serverName
  const run = async (args: string[], environment?: Parameters<typeof runCommand>[4]) => {
    input.signal?.throwIfAborted()
    await input.assertInstallation?.(input.signal)
    input.signal?.throwIfAborted()
    const result = await runCommand(input.binary, args, input.workingDirectory, input.signal, environment,
      input.processRecovery ? { recovery: input.processRecovery } : {})
    await input.assertInstallation?.(input.signal)
    input.signal?.throwIfAborted()
    return result
  }
  const version = await run(['--version'])
  const providerVersion = (version.stdout || version.stderr).trim()
  if (version.exitCode !== 0 || !providerVersion) {
    throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', 'OpenCode could not report its version for MCP inspection.')
  }
  input.onVersion?.(providerVersion)
  const args = ['debug', 'config', ...(input.pure ? ['--pure'] : [])]
  const baseline = await run(args)
  const parseEntry = (result: typeof baseline): JsonObject | undefined => {
    if (result.exitCode !== 0) {
      throw new HarnessExecutionError('OPENCODE_MCP_INSPECTION_FAILED', 'OpenCode could not inspect its effective MCP configuration.')
    }
    try {
      const config = object(JSON.parse(result.stdout))
      if (!config || (config.mcp !== undefined && !object(config.mcp))) throw new Error('invalid')
      const mcp = object(config.mcp) ?? {}
      selectedName = input.exactServerName ? input.serverName : appMcpServerName(mcp, input.serverName)
      if (!(selectedName in mcp)) return undefined
      const entry = object(mcp[selectedName])
      if (!entry) throw new Error('invalid')
      return entry
    } catch {
      throw new HarnessExecutionError('OPENCODE_MCP_CONFIG_INVALID', 'OpenCode returned invalid structured MCP configuration.')
    }
  }
  const first = parseEntry(baseline)
  if (!first) return undefined
  // Newer qualified releases redact token/header values in debug output. A
  // mask proves nothing about their origin. Read the provider's actual resolved
  // configuration over its authenticated, task-owned server instead, with the
  // same unset/nonce comparison and exact binary/process ownership checks.
  const masked = APP_MCP_TOKEN_NAMES.some((token) => (first.environment as JsonObject | undefined)?.[token] === '***')
    || authorization(first)?.value === '***'
  const resolvedEntry = async (marker?: string, credentialVariable?: string): Promise<JsonObject | undefined> => {
    const { ManagedOpenCodeServer } = await import('./opencodeTransport.js')
    const owner = 'graphql-mcp-configuration-probe'
    const server = new ManagedOpenCodeServer({ binary: input.binary, workingDirectory: input.workingDirectory,
      ownerAgentId: owner, ...(input.pure ? { pure: true } : {}),
      ...(input.processRecovery ? { processRecovery: input.processRecovery } : {}),
      ...(input.assertInstallation ? { assertInstallation: input.assertInstallation } : {}),
      ...(credentialVariable ? { credentialEnvironmentVariable: credentialVariable } : {}),
      ...(marker && credentialVariable ? { environment: { agentId: owner, variables: { [credentialVariable]: marker } } } : {}) })
    try {
      const response = await server.request('/config', {}, input.signal)
      if (!response.ok) throw new HarnessExecutionError('OPENCODE_MCP_INSPECTION_FAILED',
        'OpenCode could not inspect its effective MCP configuration.')
      const config = object(server.redact(await response.json()))
      const entries = object(config?.mcp) ?? {}
      if (!input.exactServerName && appMcpServerName(entries, input.serverName) !== selectedName) throw new HarnessExecutionError(
        'OPENCODE_MCP_CONFIG_INVALID', 'OpenCode MCP configuration changed during inspection.')
      const entry = object(entries[selectedName])
      await input.assertInstallation?.(input.signal)
      input.signal?.throwIfAborted()
      return entry
    } finally { await server.dispose() }
  }
  const initial = masked ? await resolvedEntry() : first
  if (!initial) return undefined
  const common: NativeMcpEntryEvidence = {
    name: selectedName,
    transport: initial.type === 'remote' ? 'streamable-http' : initial.type === 'local' ? 'stdio' : 'unknown',
    ...(typeof initial.url === 'string' ? { endpoint: initial.url } : {}),
    enabled: initial.enabled !== false,
    status: initial.enabled === false ? 'disabled' : 'status_unavailable',
  }
  const launcher = isSupportedAppMcpServerName(selectedName) && isAppLauncher('opencode', initial)
  const initialAuthorization = authorization(initial)
  // The App endpoint uses Foreman Code-issued bearer auth, never provider OAuth.
  if (!launcher && (initial.type !== 'remote' || initial.oauth !== false || !initialAuthorization
    || !/^Bearer $/i.test(initialAuthorization.value))) return common
  const launcherVariable = launcher ? appLauncherTokenName('opencode', initial) : undefined
  const supportedVariables = selectedName === 'graphql' ? [...APP_MCP_TOKEN_NAMES].reverse() : APP_MCP_TOKEN_NAMES
  let candidates: readonly string[] = supportedVariables
  if (input.credentialEnvironmentVariable && !isSupportedAppMcpTokenName(input.credentialEnvironmentVariable)) {
    candidates = [input.credentialEnvironmentVariable]
  } else if (launcherVariable) {
    candidates = [launcherVariable]
  }
  for (const credentialVariable of candidates) {
    if (launcher && (initial.environment as JsonObject)[credentialVariable] !== '') continue
    const owner = 'graphql-mcp-configuration-probe'
    const marker = `graphql_probe_${randomBytes(32).toString('hex')}`
    const second = masked ? await resolvedEntry(marker, credentialVariable) : parseEntry(await run(args, {
      expectedAgentId: owner,
      beforeSpawn: async () => ({ agentId: owner, variables: { [credentialVariable]: marker } }),
    }))
    if (launcher && second && isAppLauncher('opencode', second)
      && (second.environment as JsonObject)[credentialVariable] === '[REDACTED]'
      && isDeepStrictEqual({ ...initial, environment: null }, { ...second, environment: null })) {
      return { ...common, credentialEnvironmentVariable: credentialVariable, automaticEndpoint: true }
    }
    const markedAuthorization = second ? authorization(second) : undefined
    if (second && markedAuthorization && /^Bearer \[REDACTED\]$/i.test(markedAuthorization.value)
      && markedAuthorization.key === initialAuthorization?.key
      && isDeepStrictEqual(withoutAuthorization(initial), withoutAuthorization(second))) {
      return { ...common, credentialEnvironmentVariable: credentialVariable }
    }
  }
  return common
}

/** Configuration evidence only: never claims a pre-injection connection is healthy. */
export function openCodeConfigurationInspector(binary: string): NativeMcpInspector {
  return {
    async inspect(input) {
      let providerVersion: string | undefined
      const entry = await inspectOpenCodeMcpConfiguration({
        binary, workingDirectory: input.workingDirectory, serverName: input.serverName,
        ...(input.signal ? { signal: input.signal } : {}),
        onVersion: (version) => { providerVersion = version },
      })
      return {
        harness: 'opencode', providerVersion: providerVersion!,
        runnerId: input.runnerId, workingDirectory: input.workingDirectory,
        inspectedAt: new Date().toISOString(), ...(entry ? { entry } : {}),
      }
    },
  }
}
