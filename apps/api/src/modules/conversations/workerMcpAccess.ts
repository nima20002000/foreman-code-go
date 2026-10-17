import { APP_MCP_TOKEN } from '../harnesses/appMcpLauncher.js'
import { WORKER_MCP_EXTENSION, decodeWorkerMcpResult, encodeWorkerMcpRequest, WorkerConversationMcpRequestSchema, WorkerConversationMcpAuthorizationSchema,
  WorkerMcpRelayResponseSchema } from '@foreman-code/contracts/worker-mcp-relay'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { withWorkerMcpDeadline } from '../devices/workerMcpDeadline.js'

export async function prepareWorkerConversationMcp(input: {
  source: WorkerConversationRpcRequest
  token: string
  request(namespace: string, payload: unknown, options: { signal: AbortSignal; timeoutMs: number; bytes?: Uint8Array }): Promise<DeviceApplicationResult>
  signal: AbortSignal
}) {
  const owner = input.source.binding.owner
  if (owner.kind !== 'operator' || input.source.binding.appMcpAccess !== 'scoped' || !input.source.admissionId) {
    throw new DomainError('WORKER_CONVERSATION_MCP_DENIED', 'This chat has no admitted Operator MCP credential.', 403)
  }
  const fields = { version: 1, binding: input.source.binding, token: input.token, admissionId: input.source.admissionId }
  const request = async (payload: unknown, signal: AbortSignal) => {
    signal.throwIfAborted()
    const parsed = WorkerConversationMcpRequestSchema.parse(payload)
    const carrier: DeviceApplicationResult = parsed.operation === 'conversation-mcp.request' ? encodeWorkerMcpRequest(parsed) : { payload: parsed }
    const reply = await input.request(WORKER_MCP_EXTENSION.namespace, carrier.payload,
      { signal, timeoutMs: deviceRequestTimeoutMs, ...(carrier.bytes ? { bytes: carrier.bytes } : {}) })
    signal.throwIfAborted()
    return decodeWorkerMcpResult(reply)
  }
  const lease = WorkerConversationMcpAuthorizationSchema.parse(await request({ ...fields,
    operation: 'conversation-mcp.authorize' }, input.signal))
  return { expiresAt: lease.expiresAt, environment: { agentId: owner.operatorId,
    variables: { [APP_MCP_TOKEN]: input.token } },
    async request(body: unknown, protocolVersion?: string, signal = input.signal) {
      return WorkerMcpRelayResponseSchema.parse(await withWorkerMcpDeadline(relaySignal => request({ ...fields,
        operation: 'conversation-mcp.request', body, ...(protocolVersion ? { protocolVersion } : {}) }, relaySignal), signal))
    } }
}
