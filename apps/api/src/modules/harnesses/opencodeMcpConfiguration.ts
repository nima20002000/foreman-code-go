import { isOperatorLauncher, OPERATOR_TOKEN } from './operatorMcpLauncher.js'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../access/workerCredentials.js'
import { HarnessExecutionError } from './errors.js'
import type { NativeMcpEntryEvidence, NativeMcpInspector } from './mcpDetection.js'
import { runCommand } from './process.js'

export const QUALIFIED_OPENCODE_MCP_VERSION = '1.18.31'
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
  return { ...entry, headers }
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
  workingDirectory: string
  serverName: string
  signal?: AbortSignal
  pure?: boolean
  credentialEnvironmentVariable?: string
}): Promise<NativeMcpEntryEvidence | undefined> {
  const credentialVariable = input.credentialEnvironmentVariable ?? APP_MCP_TOKEN_ENVIRONMENT_VARIABLE
  const version = await runCommand(input.binary, ['--version'], input.workingDirectory, input.signal)
  if (version.exitCode !== 0 || (version.stdout || version.stderr).trim() !== QUALIFIED_OPENCODE_MCP_VERSION) {
    throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', 'OpenCode MCP inspection requires the qualified 1.18.31 binary.')
  }
  const args = ['debug', 'config', ...(input.pure ? ['--pure'] : [])]
  const baseline = await runCommand(input.binary, args, input.workingDirectory, input.signal)
  const parseEntry = (result: typeof baseline): JsonObject | undefined => {
    if (result.exitCode !== 0) {
      throw new HarnessExecutionError('OPENCODE_MCP_INSPECTION_FAILED', 'OpenCode could not inspect its effective MCP configuration.')
    }
    try {
      const config = object(JSON.parse(result.stdout))
      if (!config || (config.mcp !== undefined && !object(config.mcp))) throw new Error('invalid')
      const mcp = object(config.mcp) ?? {}
      if (!(input.serverName in mcp)) return undefined
      const entry = object(mcp[input.serverName])
      if (!entry) throw new Error('invalid')
      return entry
    } catch {
      throw new HarnessExecutionError('OPENCODE_MCP_CONFIG_INVALID', 'OpenCode returned invalid structured MCP configuration.')
    }
  }
  const first = parseEntry(baseline)
  if (!first) return undefined
  const common: NativeMcpEntryEvidence = {
    name: input.serverName,
    transport: first.type === 'remote' ? 'streamable-http' : first.type === 'local' ? 'stdio' : 'unknown',
    ...(typeof first.url === 'string' ? { endpoint: first.url } : {}),
    enabled: first.enabled !== false,
    status: first.enabled === false ? 'disabled' : 'status_unavailable',
  }
  const launcher = input.serverName === 'graphql-operator' && isOperatorLauncher('opencode', first)
  const initialAuthorization = authorization(first)
  // The App endpoint uses GraphQL-issued bearer auth, never provider OAuth.
  if (!launcher && (first.type !== 'remote' || first.oauth !== false || !initialAuthorization
    || !/^Bearer $/i.test(initialAuthorization.value))) return common
  if (launcher && (first.environment as JsonObject)[OPERATOR_TOKEN] !== '') return common

  const owner = 'graphql-mcp-configuration-probe'
  const marker = `graphql_probe_${randomBytes(32).toString('hex')}`
  const checked = await runCommand(input.binary, args, input.workingDirectory, input.signal, {
    expectedAgentId: owner,
    credentialAudience: credentialVariable === 'GRAPHQL_OPERATOR_MCP_TOKEN' ? 'operator' : 'worker',
    beforeSpawn: async () => ({ agentId: owner, variables: { [credentialVariable]: marker } }),
  })
  const second = parseEntry(checked)
  if (launcher && second && isOperatorLauncher('opencode', second)
    && (second.environment as JsonObject)[OPERATOR_TOKEN] === '[REDACTED]'
    && isDeepStrictEqual({ ...first, environment: null }, { ...second, environment: null })) {
    return { ...common, credentialEnvironmentVariable: credentialVariable, automaticOperatorEndpoint: true }
  }
  const markedAuthorization = second ? authorization(second) : undefined
  if (!second || !markedAuthorization || !/^Bearer \[REDACTED\]$/i.test(markedAuthorization.value)
    || markedAuthorization.key !== initialAuthorization?.key
    || !isDeepStrictEqual(withoutAuthorization(first), withoutAuthorization(second))) return common
  return { ...common, credentialEnvironmentVariable: credentialVariable }
}

/** Configuration evidence only: never claims a pre-injection connection is healthy. */
export function openCodeConfigurationInspector(binary: string): NativeMcpInspector {
  return {
    async inspect(input) {
      const entry = await inspectOpenCodeMcpConfiguration({
        binary, workingDirectory: input.workingDirectory, serverName: input.serverName,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      return {
        harness: 'opencode', providerVersion: QUALIFIED_OPENCODE_MCP_VERSION,
        runnerId: input.runnerId, workingDirectory: input.workingDirectory,
        inspectedAt: new Date().toISOString(), ...(entry ? { entry } : {}),
      }
    },
  }
}
