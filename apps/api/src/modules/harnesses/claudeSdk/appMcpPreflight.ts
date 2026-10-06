import type { NativeMcpEntryEvidence } from '../mcpDetection.js'
import { isSupportedAppMcpServerName } from '../appMcpLauncher.js'

/** Before its scoped credential exists, Claude reaches the app endpoint unauthenticated and the
 * endpoint answers 401, which current Claude releases report as failed ('broken'). The second,
 * credentialed preflight must still report the server connected with an acknowledged header. */
export function acceptsClaudePreCredentialEntry(entry: NativeMcpEntryEvidence | undefined, appMcpEndpoint: string): boolean {
  return Boolean(entry && isSupportedAppMcpServerName(entry.name) && entry.transport === 'streamable-http'
    && entry.endpoint === appMcpEndpoint && entry.enabled !== false
    && ['connected', 'authentication_required', 'status_unavailable', 'broken'].includes(entry.status ?? ''))
}
