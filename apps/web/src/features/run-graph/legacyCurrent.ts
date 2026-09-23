import type { RunCurrentResponse } from '@graphql/contracts/run-current'
import { GraphProtocolError } from './errors'

/** Query-owned compact compatibility facts; never fabricate a full-history response. */
export function keepLatestRunCurrent(previous: RunCurrentResponse | undefined, next: RunCurrentResponse): RunCurrentResponse {
  if (!previous) return next
  if (previous.run.id !== next.run.id || previous.run.workspaceId !== next.run.workspaceId
    || previous.run.workflowId !== next.run.workflowId || previous.run.workflowVersionId !== next.run.workflowVersionId) {
    throw new GraphProtocolError('GRAPH_SCOPE_MISMATCH')
  }
  // Compare observation order before accepting a terminal response. Equal high
  // water marks may include new cleanup facts: this is not a complete revision.
  if (BigInt(next.asOfActivitySequence) < BigInt(previous.asOfActivitySequence)) return previous
  if (previous.run.stopCause && !next.run.stopCause) return previous
  if (previous.run.executionState === 'completed'
    && (next.run.executionState !== 'completed' || next.run.outcome !== previous.run.outcome)) return previous
  if (previous.run.executionState === 'interrupted'
    && ['queued', 'running', 'waiting'].includes(next.run.executionState)) return previous
  return next
}
