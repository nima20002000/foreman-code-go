import type { NativeMcpInspectionEvidence, NativeMcpInspector } from './mcpDetection.js'

export interface CodexMcpConfigurationInspectionLike {
  providerVersion: string
  cwd: string
  serverName: string
  configured: {
    enabled: boolean
    transport: 'stdio' | 'streamable_http' | 'unknown'
    url: string | null
    bearerTokenEnvironmentVariable: string | null
    enabledTools: string[] | null
    disabledTools: string[]
  }
}

export interface CodexMcpConfigurationInspector {
  inspectMcpConfiguration(cwd: string, signal?: AbortSignal): Promise<CodexMcpConfigurationInspectionLike>
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  if (!('result' in error) || !error.result || typeof error.result !== 'object' || !('error' in error.result)
    || !error.result.error || typeof error.result.error !== 'object' || !('code' in error.result.error)) return undefined
  return typeof error.result.error.code === 'string' ? error.result.error.code : undefined
}

/** Adapts HAP-02's model-free effective-config primitive; it never starts another runtime. */
export function codexMcpInspectorAdapter(manager: CodexMcpConfigurationInspector): NativeMcpInspector {
  return {
    async inspect(input): Promise<NativeMcpInspectionEvidence> {
      try {
        const result = await manager.inspectMcpConfiguration(input.workingDirectory, input.signal)
        return {
          harness: 'codex',
          providerVersion: result.providerVersion,
          runnerId: input.runnerId,
          workingDirectory: result.cwd,
          inspectedAt: new Date().toISOString(),
          entry: {
            name: result.serverName,
            transport: result.configured.transport === 'streamable_http'
              ? 'streamable-http'
              : result.configured.transport,
            ...(result.configured.url ? { endpoint: result.configured.url } : {}),
            enabled: result.configured.enabled,
            ...(result.configured.bearerTokenEnvironmentVariable
              ? { credentialEnvironmentVariable: result.configured.bearerTokenEnvironmentVariable }
              : {}),
            status: result.configured.enabled ? 'status_unavailable' : 'disabled',
            ...(result.configured.enabledTools ? { enabledTools: result.configured.enabledTools } : {}),
            disabledTools: result.configured.disabledTools,
          },
        }
      } catch (error) {
        if (errorCode(error) === 'CODEX_MCP_NOT_CONFIGURED') {
          return {
            harness: 'codex', providerVersion: 'unknown', runnerId: input.runnerId,
            workingDirectory: input.workingDirectory, inspectedAt: new Date().toISOString(),
          }
        }
        throw error
      }
    },
  }
}
