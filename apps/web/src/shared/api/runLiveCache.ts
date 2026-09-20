import type { GetRunResponse } from '@graphql/contracts'

/** Query-cache ownership only; never copy server state into a graph/Zustand store. */
export function keepLatestRunResponse(current: GetRunResponse | undefined, incoming: GetRunResponse): GetRunResponse {
  if (!current || current.run.id !== incoming.run.id || current.run.workspaceId !== incoming.run.workspaceId
    || current.run.workflowId !== incoming.run.workflowId) return incoming
  if (current.run.workflowVersionId !== incoming.run.workflowVersionId) return current
  if (current.run.executionState === 'completed' && incoming.run.executionState !== 'completed') return current
  if (incoming.run.executionState === 'completed' && current.run.executionState !== 'completed') return incoming
  const before = current.liveActivity
  const after = incoming.liveActivity
  if (!before) return incoming
  if (!after) return current
  if (BigInt(after.eventCount) < BigInt(before.eventCount) || BigInt(after.sequence) < BigInt(before.sequence)) return current
  return incoming
}
