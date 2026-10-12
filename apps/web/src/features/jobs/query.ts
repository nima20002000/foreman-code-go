import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { jobsClient } from './client'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { jobAccessLost, jobReadRetry, loadedChunks } from './model'

export const jobKeys = {
  definitions: (workspaceId: string) => ['jobs', workspaceId, 'definitions'] as const,
  execution: (workspaceId: string, id: string) => ['jobs', workspaceId, 'execution', id] as const,
  logs: (workspaceId: string, id: string, attemptId: string) => ['jobs', workspaceId, 'logs', id, attemptId] as const,
  artifacts: (workspaceId: string, id: string) => ['jobs', workspaceId, 'artifacts', id] as const,
}
export function useJobDefinitions(workspaceId: string) {
  const query = useQuery({ queryKey: jobKeys.definitions(workspaceId), queryFn: ({ signal }) => jobsClient.definitions(workspaceId, { signal }), retry: jobReadRetry })
  const blocked = useBlockingReadError(query)
  return { ...query, data: blocked ? undefined : query.data }
}
export function useJobExecution(workspaceId: string, id: string) {
  const query = useQuery({ queryKey: jobKeys.execution(workspaceId, id), queryFn: ({ signal }) => jobsClient.execution(workspaceId, id, { signal }), retry: jobReadRetry, gcTime: 0, placeholderData: () => undefined, refetchInterval: query => jobAccessLost(query.state.error) ? false : query.state.data?.process.phase === 'terminal' ? 5000 : 3000 })
  const blocked = useBlockingReadError(query)
  return { ...query, data: blocked ? undefined : query.data }
}
export function useJobLogs(workspaceId: string, id: string, attemptId: string, enabled: boolean) {
  const query = useInfiniteQuery({ queryKey: jobKeys.logs(workspaceId, id, attemptId), initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => jobsClient.logs(workspaceId, id, attemptId, pageParam, { signal }),
    getNextPageParam: (page, _pages, cursor) => page.nextCursor > cursor ? page.nextCursor : undefined,
    maxPages: 5, enabled, retry: jobReadRetry, gcTime: 0, placeholderData: () => undefined,
  })
  const blocked = useBlockingReadError(query)
  return { ...query, blocked: Boolean(blocked),
    chunks: !enabled || blocked ? [] : loadedChunks(query.data?.pages),
    pages: !enabled || blocked ? [] : query.data?.pages ?? [] }
}
export function useJobArtifacts(workspaceId: string, id: string, enabled: boolean) {
  const query = useQuery({ queryKey: jobKeys.artifacts(workspaceId, id), queryFn: ({ signal }) => jobsClient.artifacts(workspaceId, id, { signal }), enabled, retry: jobReadRetry, gcTime: 0, refetchInterval: query => enabled && !jobAccessLost(query.state.error) ? 5000 : false })
  const blocked = useBlockingReadError(query)
  return { ...query, data: !enabled || blocked ? undefined : query.data }
}

