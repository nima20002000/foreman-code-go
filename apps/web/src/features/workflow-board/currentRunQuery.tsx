import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { RepeatGraphScopeV3Schema, type RepeatGraphCurrentV3, type RepeatGraphScopeV3 } from '@graphql/contracts/wave25'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { assertRepeatCurrentProgress, repeatGraphClient, type RepeatGraphClient } from '../repeats/canonicalClient'

export const currentRunKey = (scope: RepeatGraphScopeV3, generation = sessionGeneration()) =>
  ['workbench', 'current-v3-run', generation, scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId, 3] as const

/** The same complete canonical V3 read supplies ordinary and configured-repeat facts.
 * Cached data is not current evidence after a failed, denied or regressed refresh. */
export function useCurrentRunQuery(scope?: RepeatGraphScopeV3, live = true, client: RepeatGraphClient = repeatGraphClient) {
  const cache = useQueryClient(), generation = sessionGeneration()
  const key = scope ? currentRunKey(scope, generation) : ['workbench', 'no-current-run', generation]
  return useQuery({ queryKey: key, enabled: !!scope,
    queryFn: async ({ signal }) => {
      const value = await client.current(RepeatGraphScopeV3Schema.parse(scope), { signal })
      assertSession(generation)
      assertRepeatCurrentProgress(cache.getQueryData<RepeatGraphCurrentV3>(key), value)
      return value
    }, retry: false, staleTime: 1000, refetchOnReconnect: 'always', refetchOnWindowFocus: live,
    refetchInterval: (state) => {
      const error = state.state.error
      if (ApiError.is(error) && [401, 403, 404].includes(error.status)) return false
      return live && state.state.data?.state.run.executionState !== 'completed' ? 1500 : false
    },
  })
}
export function CurrentRunObserver({ scope }: { scope: RepeatGraphScopeV3 }) { useCurrentRunQuery(scope); return null }
export function clearCurrentRunAccess(client: QueryClient) {
  client.removeQueries({ queryKey: ['workbench', 'current-v3-run'] })
  client.removeQueries({ queryKey: ['workbench', 'pinned-v3-run-details'] })
}
export function revokeCurrentRunWorkspace(client: QueryClient, workspaceId: string) {
  client.removeQueries({ predicate: (query) => ['current-v3-run', 'pinned-v3-run-details'].includes(String(query.queryKey[1]))
    && query.queryKey[3] === workspaceId })
}
