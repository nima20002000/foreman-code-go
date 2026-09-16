import type { NativeMcpInspectionEvidence, NativeMcpInspector, NativeMcpStatus } from './mcpDetection.js'
import type { OpenCodeNativeSessionManager } from './opencodeServer.js'

export type OpenCodeMcpConfigurationInspector = Pick<OpenCodeNativeSessionManager, 'inspectNativeMcp'>

function status(value: Awaited<ReturnType<OpenCodeNativeSessionManager['inspectNativeMcp']>>['nativeStatus']): NativeMcpStatus {
  if (value === 'failed') return 'broken'
  if (value === 'needs_auth' || value === 'needs_client_registration') return 'authentication_required'
  if (value === 'not_detected') return 'status_unavailable'
  return value
}

/** Pre-injection config proof and post-injection native connection status are separate. */
export function openCodeMcpInspectorAdapter(manager: OpenCodeMcpConfigurationInspector): NativeMcpInspector {
  return {
    async inspect(input): Promise<NativeMcpInspectionEvidence> {
      const result = await manager.inspectNativeMcp(input.workingDirectory, input.signal, input.phase ?? 'health')
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
          transport: result.transport ?? 'unknown',
          ...(result.endpoint ? { endpoint: result.endpoint } : {}),
          enabled: result.nativeStatus !== 'disabled',
          ...(result.credentialEnvironmentVariable ? { credentialEnvironmentVariable: result.credentialEnvironmentVariable } : {}),
          status: status(result.nativeStatus),
          ...(result.baseConfigurationFilters.length ? { nativeFilterDiagnostics: ['Native base-configuration permission filters are configured.'] } : {}),
        },
      }
    },
  }
}
