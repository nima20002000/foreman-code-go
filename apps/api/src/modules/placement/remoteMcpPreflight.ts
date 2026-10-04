import { ScopedMcpDetectionSchema } from '@foreman-code/contracts'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../access/workerCredentials.js'
import { DomainError } from '../errors.js'
import type { McpDetectionService } from '../harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'

/** The authenticated remote manager checks configuration on its owning device. */
export function remoteMcpPreflight(
  manager: NativeHarnessSessionManager,
  context: NativeManagerResolutionContext,
): Pick<McpDetectionService, 'preflight'> {
  return { async preflight(input) {
    if (input.harness !== manager.harness || input.harness !== context.harness
      || input.workingDirectory !== context.workingDirectory) {
      throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'MCP inspection belongs to another execution.', 409)
    }
    const detection = await manager.inspectMcp(input.signal)
    input.signal?.throwIfAborted()
    if (detection.harness !== input.harness || detection.serverName !== 'graphql'
      || detection.endpointMatches !== true
      || detection.credentialEnvironmentVariable !== APP_MCP_TOKEN_ENVIRONMENT_VARIABLE
      || detection.credentialArrangement !== undefined
        && (detection.credentialArrangement.kind !== 'environment_variable'
          || detection.credentialArrangement.environmentVariable !== APP_MCP_TOKEN_ENVIRONMENT_VARIABLE)
      || !['connected', 'status_unavailable', 'authentication_required'].includes(detection.state)) {
      throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'GraphQL MCP configuration on the selected computer is not ready.', 409)
    }
    const capabilities = await manager.capabilities(input.signal)
    input.signal?.throwIfAborted()
    if (capabilities.provider !== input.harness) {
      throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'MCP inspection returned another harness.', 409)
    }
    return ScopedMcpDetectionSchema.parse({
      detection, runnerId: input.runnerId, workingDirectory: context.workingDirectory,
      providerVersion: capabilities.providerVersion, nativeFilters: {},
    })
  } }
}
