import { basename } from 'node:path'
import type { McpDetection, AgentHarness } from '@graphql/contracts'

export interface ClaudeMcpControlServer {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  source?: string
  configuration: { type?: string; url?: string; command?: string; argumentCount?: number } | null
  toolNames: readonly string[]
  credentialEnvironmentVariables: readonly string[]
}
export interface ClaudeMcpInspection {
  generation: string
  initializationAnswered: true
  servers: readonly ClaudeMcpControlServer[]
  checkedAt: string
}
function safeUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined
    return parsed.toString()
  } catch { return undefined }
}
export function decodeClaudeMcpControl(rows: readonly unknown[], generation: string, checkedAt: string): ClaudeMcpInspection {
  if (rows.length > 128) throw new Error('Claude MCP control snapshot exceeds the bounded server window')
  const servers = rows.map((raw): ClaudeMcpControlServer => {
    if (!raw || typeof raw !== 'object') throw new Error('Claude MCP control server is malformed')
    const row = raw as Record<string, unknown>
    if (typeof row.name !== 'string' || !row.name || !['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(String(row.status))) throw new Error('Claude MCP control identity/status is malformed')
    const config = row.config && typeof row.config === 'object' ? row.config as Record<string, unknown> : undefined
    // Native config may contain resolved credentials. Only transport locator fields leave this boundary.
    const configuration = config ? {
      ...(typeof config.type === 'string' ? { type: config.type } : {}),
      ...(typeof config.url === 'string' && safeUrl(config.url) ? { url: safeUrl(config.url)! } : {}),
      ...(typeof config.command === 'string' ? { command: basename(config.command) } : {}),
      ...(Array.isArray(config.args) ? { argumentCount: config.args.length } : {}),
    } : null
    const toolNames = Array.isArray(row.tools) ? row.tools.slice(0, 512).flatMap((value) => value && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string' ? [(value as { name: string }).name] : []) : []
    const environment = config?.env && typeof config.env === 'object' ? config.env as Record<string, unknown> : {}
    const credentialEnvironmentVariables = Object.keys(environment).filter((key) => key === 'GRAPHQL_MCP_TOKEN')
    return { name: row.name, status: row.status as ClaudeMcpControlServer['status'], configuration, toolNames, credentialEnvironmentVariables,
      ...(typeof row.source === 'string' ? { source: row.source } : {}) }
  })
  return { generation, initializationAnswered: true, servers, checkedAt }
}
export function claudeMcpDetection(snapshot: ClaudeMcpInspection, expected: { serverName: string; url?: string }): McpDetection {
  const server = snapshot.servers.find((entry) => entry.name === expected.serverName)
  const endpointMatches = expected.url ? server?.configuration?.url === safeUrl(expected.url) : null
  const state: McpDetection['state'] = !server ? 'not_detected'
    : endpointMatches === false ? 'misconfigured'
      : server.status === 'needs-auth' ? 'authentication_required' : server.status === 'failed' ? 'broken'
        : server.status === 'disabled' ? 'disabled' : server.status === 'pending' ? 'status_unavailable' : 'connected'
  return { harness: 'claude' as AgentHarness, serverName: expected.serverName, state, endpointMatches,
    credentialEnvironmentVariable: server?.credentialEnvironmentVariables.includes('GRAPHQL_MCP_TOKEN') ? 'GRAPHQL_MCP_TOKEN' : null, checkedAt: snapshot.checkedAt,
    detail: 'Observed SDK MCP control status/configuration on the same owned query; saved settings are not connection evidence.' }
}
