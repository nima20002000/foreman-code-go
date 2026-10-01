import type { AcceptedNodePlacement, DispatchIntent } from '@graphql/contracts/node-placement'
import { RemoteApplicationAccessSchema, type RemoteApplicationAccess } from '@graphql/contracts/remote-execution'
import { WORKER_MCP_EXTENSION, WorkerMcpRelayAuthorizationSchema, WorkerMcpRelayRequestSchema, WorkerMcpRelayResponseSchema } from '@graphql/contracts/worker-mcp-relay'
import type { ChildProcessEnvironment } from '../../harnesses/port.js'
import type { DeviceConnectionSupervisor } from '../../devices/connectionSupervisor.js'

/** Ephemeral exact main lease; each tool request repeats main's real authorization.
 * The worker's App launcher mounts this relay on its existing private loopback route.
 * No token is minted, persisted or copied into the operation journal here. */
export async function prepareWorkerApplicationAccess(channel: Pick<DeviceConnectionSupervisor, 'request'>,
  intent: DispatchIntent, placement: AcceptedNodePlacement, raw: RemoteApplicationAccess, signal?: AbortSignal) {
  const applicationAccess = RemoteApplicationAccessSchema.parse(raw)
  if (placement.payload.kind !== 'agent' || placement.hostRef.kind !== 'device'
    || applicationAccess.agentId !== placement.payload.agentId || applicationAccess.executionId !== intent.executionId
    || applicationAccess.operationId !== intent.operationId || applicationAccess.attemptId !== intent.attemptId
    || applicationAccess.bindingHash !== intent.bindingHash || placement.bindingHash !== intent.bindingHash
    || placement.mainId !== intent.mainId) throw new Error('Application access does not bind this original accepted execution')
  const envelope = { version: 1 as const, intent, placement, applicationAccess }
  signal?.throwIfAborted()
  const authorized = await channel.request(WORKER_MCP_EXTENSION.namespace,
    WorkerMcpRelayRequestSchema.parse({ ...envelope, operation: 'worker-mcp.authorize' }), signal ? { signal } : {})
  if (authorized.bytes !== undefined) throw new Error('Application lease authorization cannot contain binary bytes')
  const lease = WorkerMcpRelayAuthorizationSchema.parse(authorized.payload)
  if (lease.mainId !== intent.mainId || lease.agentId !== applicationAccess.agentId || lease.executionId !== intent.executionId
    || lease.operationId !== intent.operationId || lease.attemptId !== intent.attemptId || lease.bindingHash !== intent.bindingHash
    || Date.parse(lease.expiresAt) <= Date.now()) throw new Error('Original main application lease is unavailable')
  signal?.throwIfAborted()
  const environment: ChildProcessEnvironment = { agentId: applicationAccess.agentId, variables: { GRAPHQL_MCP_TOKEN: applicationAccess.token } }
  return { environment, expiresAt: lease.expiresAt, async request(body: unknown, protocolVersion?: string, requestSignal?: AbortSignal) {
    requestSignal?.throwIfAborted()
    const response = await channel.request(WORKER_MCP_EXTENSION.namespace,
      WorkerMcpRelayRequestSchema.parse({ ...envelope, operation: 'worker-mcp.request', body, ...(protocolVersion ? { protocolVersion } : {}) }),
      requestSignal ? { signal: requestSignal } : {})
    if (response.bytes !== undefined) throw new Error('Application MCP response cannot contain binary bytes')
    requestSignal?.throwIfAborted()
    return WorkerMcpRelayResponseSchema.parse(response.payload)
  } }
}
