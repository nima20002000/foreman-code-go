import { ExecutionFactsRequestSchema, ExecutionFactsResultSchema, ExecutionAuthorityRequestSchema, ExecutionAuthorityResultSchema, EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { DomainError } from '../errors.js'
import type { RemoteReviewerRequest } from '@foreman-code/contracts/remote-execution'
const denied = (): never => { throw new DomainError('REMOTE_AUTHORITY_DENIED', 'Exact original execution authority is unavailable or revoked.', 403) }
/** Worker composition supplies the established W07 channel request, not fetch to
 * a public HTTP route. The main's response carries correlation, never a permit. */
export function workerExecutionAuthorizer(request: (namespace: string, payload: unknown) => Promise<{ payload: unknown; bytes?: Uint8Array }>) {
  return async (intent: DispatchIntent, placement: AcceptedNodePlacement, action: 'start' | 'read' | 'control' | 'stop') => {
    const input = ExecutionAuthorityRequestSchema.parse({ version: 1, intent, placement, action })
    const reply = await request(EXECUTION_AUTHORITY_EXTENSION.namespace, input)
    if (reply.bytes?.byteLength) denied()
    const { cleanupOnly, ...result } = ExecutionAuthorityResultSchema.parse(reply.payload)
    if (!sameWorkflowValue(result, { version: 1, action, operationId: intent.operationId, attemptId: intent.attemptId,
      bindingHash: intent.bindingHash, owner: intent.owner }) || cleanupOnly && action !== 'read' && action !== 'stop') denied()
    return cleanupOnly ? { cleanupOnly: true as const } : undefined
  }
}

export function workerReviewerAuthorizer(request: (namespace: string, payload: unknown) => Promise<{ payload: unknown; bytes?: Uint8Array }>) {
  return async (intent: DispatchIntent, placement: AcceptedNodePlacement, review?: RemoteReviewerRequest) => {
    const action = review ? 'review' : 'retain-reviewer'
    const reply = await request(EXECUTION_AUTHORITY_EXTENSION.namespace,
      ExecutionAuthorityRequestSchema.parse({ version: 1, intent, placement, action, ...(review ? { review } : {}) }))
    if (reply.bytes?.byteLength) denied()
    const { reviewer, ...result } = ExecutionAuthorityResultSchema.parse(reply.payload)
    if (!sameWorkflowValue(result, { version: 1, action, operationId: intent.operationId,
      attemptId: intent.attemptId, bindingHash: intent.bindingHash, owner: intent.owner })) denied()
    return reviewer
  }
}

export function workerExecutionFactsReader(request: (namespace: string, payload: unknown) => Promise<{ payload: unknown; bytes?: Uint8Array }>) {
  return async (intent: DispatchIntent, placement: AcceptedNodePlacement) => {
    const input = ExecutionFactsRequestSchema.parse({ method: 'read-facts', authorization: { version: 1, action: 'read', intent, placement } })
    const reply = await request(EXECUTION_AUTHORITY_EXTENSION.namespace, input)
    if (reply.bytes?.byteLength) denied()
    const result = ExecutionFactsResultSchema.parse(reply.payload)
    if (!sameWorkflowValue(result.intent, intent) || !sameWorkflowValue(result.placement, placement)
      || result.executionPlacement.executionId !== intent.executionId || result.executionPlacement.attemptId !== intent.attemptId
      || result.executionPlacement.operationId !== intent.operationId || result.executionPlacement.acceptedBindingHash !== intent.bindingHash) denied()
    return result
  }
}
