import { RepeatGraphScopeV3Schema, RunActivitiesPageSchema, type RunActivitiesPage, type RunActivityPublic } from '@graphql/contracts/wave25'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'

// A selected snapshot pins these four fields. Do not invent a URL semantics pin:
// the existing response schema independently verifies executionSemanticsVersion=3.
export type RunActivityScope = Pick<RunActivitiesPage['scope'], 'workspaceId' | 'workflowId' | 'runId' | 'workflowVersionId'>

export const runActivitiesKey = (scope: RunActivityScope, generation = sessionGeneration()) =>
  ['workbench', 'run-activities', generation, scope.workspaceId, scope.workflowId,
    scope.runId, scope.workflowVersionId, 3] as const

export async function readRunActivities(scope: RunActivityScope, cursor: string | null = null, options?: RequestOptions): Promise<RunActivitiesPage> {
  if ('executionSemanticsVersion' in scope) RepeatGraphScopeV3Schema.parse(scope)
  RunActivitiesPageSchema.shape.scope.omit({ executionSemanticsVersion: true }).parse({
    workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId, workflowVersionId: scope.workflowVersionId,
  })
  const generation = sessionGeneration()
  const query = new URLSearchParams({ limit: '50' })
  if (cursor) query.set('cursor', cursor)
  const page = await apiClient.request(`/api/management/workspaces/${encodeURIComponent(scope.workspaceId)}`
    + `/runs/${encodeURIComponent(scope.runId)}/activities?${query}`, RunActivitiesPageSchema, options)
  if (page.scope.workspaceId !== scope.workspaceId || page.scope.workflowId !== scope.workflowId
    || page.scope.runId !== scope.runId || page.scope.workflowVersionId !== scope.workflowVersionId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Activities belong to a different Run or saved version.' })
  }
  assertSession(generation)
  return page
}

/** Server sequences are authoritative. Overlapping pages coalesce by that ID,
 * and the UI retains at most the same 1000 public rows as the service. */
export function mergeRunActivities(previous: readonly RunActivityPublic[], next: readonly RunActivityPublic[]): RunActivityPublic[] {
  const bySequence = new Map(previous.map((item) => [item.sequence, item]))
  for (const item of next) {
    const old = bySequence.get(item.sequence)
    if (old && old.id !== item.id) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Activities changed identity at a recorded sequence.' })
    bySequence.set(item.sequence, item)
  }
  return [...bySequence.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1).slice(-1000)
}

export type RunActivityFeed = { items: RunActivityPublic[]; olderCursor: string | null;
  nextCursor: string; retainedFrom: string }

/** A query refetch catches every new page through its frozen high-water mark.
 * A 410 is surfaced to the UI for an explicit resync, never silently skipped. */
export async function readRunActivityFeed(scope: RunActivityScope, previous?: RunActivityFeed,
  options?: RequestOptions): Promise<RunActivityFeed> {
  if (!previous) {
    const page = await readRunActivities(scope, null, options)
    return { items: page.items, olderCursor: page.olderCursor,
      nextCursor: page.nextCursor, retainedFrom: page.retainedFrom }
  }
  let cursor = previous.nextCursor
  let result = previous
  for (let count = 0; count < 20; count++) {
    const page = await readRunActivities(scope, cursor, options)
    result = { items: mergeRunActivities(result.items, page.items)
      .filter((item) => BigInt(item.sequence) >= BigInt(page.retainedFrom)),
    olderCursor: result.olderCursor, nextCursor: page.nextCursor, retainedFrom: page.retainedFrom }
    cursor = page.nextCursor
    if (!page.hasMore) return result
  }
  throw new ApiError({ code: 'ACTIVITIES_CATCHUP_TOO_LARGE', message: 'Activities changed faster than this page can safely catch up. Reload this Run.' })
}
