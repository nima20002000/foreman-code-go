import type { NativeMcpInspectionEvidence, NativeMcpInspector, NativeMcpStatus } from './mcpDetection.js'

export interface OpenCodeMcpInspectionLike {
  cwd: string
  providerVersion: string
  serverName: string
  nativeStatus: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration' | 'not_detected'
  endpoint: string | null
  credentialEnvironmentVariable: string | null
  effectiveFilters: readonly { permission: string; pattern: string; effect: string }[]
  detail?: string
}

export interface OpenCodeMcpConfigurationInspector {
  inspectNativeMcp(directory: string, signal?: AbortSignal): Promise<OpenCodeMcpInspectionLike>
}

function status(value: OpenCodeMcpInspectionLike['nativeStatus']): NativeMcpStatus {
  if (value === 'failed') return 'broken'
  if (value === 'needs_auth' || value === 'needs_client_registration') return 'authentication_required'
  if (value === 'not_detected') return 'status_unavailable'
  return value
}

/** Adapts HAP-03's resolved GET /config + GET /mcp evidence; it starts no second server. */
export function openCodeMcpInspectorAdapter(manager: OpenCodeMcpConfigurationInspector): NativeMcpInspector {
  return {
    async inspect(input): Promise<NativeMcpInspectionEvidence> {
      const result = await manager.inspectNativeMcp(input.workingDirectory, input.signal)
      const common = {
        harness: 'opencode' as const,
        providerVersion: result.providerVersion,
        runnerId: input.runnerId,
        workingDirectory: result.cwd,
        inspectedAt: new Date().toISOString(),
      }
      if (result.nativeStatus === 'not_detected') return common
      return {
        ...common,
        entry: {
          name: result.serverName,
          transport: 'streamable-http',
          ...(result.endpoint ? { endpoint: result.endpoint } : {}),
          enabled: result.nativeStatus !== 'disabled',
          ...(result.credentialEnvironmentVariable
            ? { credentialEnvironmentVariable: result.credentialEnvironmentVariable }
            : {}),
          status: status(result.nativeStatus),
          ...(result.detail ? { detail: result.detail } : {}),
          nativeFilterDiagnostics: result.effectiveFilters.map((filter) =>
            `${filter.permission}:${filter.pattern}:${filter.effect}`),
        },
      }
    },
  }
}
