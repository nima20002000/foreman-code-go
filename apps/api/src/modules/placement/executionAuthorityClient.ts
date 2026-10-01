import { ExecutionAuthorityRequestSchema, ExecutionAuthorityResultSchema, EXECUTION_AUTHORITY_EXTENSION } from '@graphql/contracts/execution-authority'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import type { DispatchIntent, AcceptedNodePlacement } from '@graphql/contracts/node-placement'
import { DomainError } from '../errors.js'
const denied = (): never => { throw new DomainError('REMOTE_AUTHORITY_DENIED', 'Exact original execution authority is unavailable or revoked.', 403) }
/** Worker composition supplies the established W07 channel request, not fetch to
 * a public HTTP route. The main's response carries correlation, never a permit. */
export function workerExecutionAuthorizer(request: (namespace: string, payload: unknown) => Promise<{ payload: unknown; bytes?: Uint8Array }>) {
  return async (intent: DispatchIntent, placement: AcceptedNodePlacement, action: 'start' | 'read' | 'control') => {
    const input = ExecutionAuthorityRequestSchema.parse({ version: 1, intent, placement, action })
    const reply = await request(EXECUTION_AUTHORITY_EXTENSION.namespace, input)
    if (reply.bytes?.byteLength) denied()
    const result = ExecutionAuthorityResultSchema.parse(reply.payload)
    if (!sameWorkflowValue(result, { version: 1, action, operationId: intent.operationId, attemptId: intent.attemptId,
      bindingHash: intent.bindingHash, owner: intent.owner })) denied()
  }
}
