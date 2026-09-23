import type { GetRunResponse } from '@graphql/contracts'
import { shareRunResponseOrSelection } from '../../shared/api/runLiveCache'
import { GraphProtocolError } from './errors'

/** Compatibility data stays in its original contract, never fabricated graph-v1 batches. */
export function keepLatestRunResponse(previous: GetRunResponse | undefined, next: GetRunResponse): GetRunResponse {
  if (previous && (previous.run.id !== next.run.id || previous.run.workflowVersionId !== next.run.workflowVersionId
    || previous.run.workspaceId !== next.run.workspaceId || previous.run.workflowId !== next.run.workflowId)) {
    throw new GraphProtocolError('GRAPH_SCOPE_MISMATCH')
  }
  if (previous?.run.executionState === 'completed'
    && (next.run.executionState !== 'completed' || next.run.outcome !== previous.run.outcome)) return previous
  // Preserve the S2 compatibility reader's revision/Stop guards and sharing rules.
  return shareRunResponseOrSelection(previous, next) as GetRunResponse
}
