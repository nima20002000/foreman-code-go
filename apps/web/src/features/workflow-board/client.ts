import { RunEventsPageSchema } from '@graphql/contracts/management'
import { CompatibleRunDetailsSchema, RunGraphScopeSchema, type RunGraphScope } from '@graphql/contracts/wave25'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'

export async function readBoardRun(workspaceId: string, workflowId: string, runId: string, options?: RequestOptions) {
  const result = await apiClient.request(
    `/api/management/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
    CompatibleRunDetailsSchema, options)
  if (result.run.workspaceId !== workspaceId || result.run.workflowId !== workflowId || result.run.id !== runId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The Run belongs to a different workflow.' })
  }
  return result
}
export function scopeForBoardRun(run: Awaited<ReturnType<typeof readBoardRun>>['run']): RunGraphScope {
  return RunGraphScopeSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
    runId: run.id, workflowVersionId: run.workflowVersionId,
    executionSemanticsVersion: 'executionSemanticsVersion' in run ? run.executionSemanticsVersion : 1 })
}

/** Deliberate detail read, never part of the current-state polling loop. */
export async function readBoardHistory(scope: RunGraphScope, cursor: string | null, options?: RequestOptions) {
  const query = new URLSearchParams({ limit: '50' })
  if (cursor !== null) query.set('cursor', cursor)
  const result = await apiClient.request(
    `/api/management/workspaces/${encodeURIComponent(scope.workspaceId)}/runs/${encodeURIComponent(scope.runId)}/events?${query}`,
    RunEventsPageSchema, options)
  if (result.items.some((item) => item.runId !== scope.runId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'History contains a different Run identity.' })
  }
  return result
}
