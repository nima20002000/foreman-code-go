import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BugReport, BugReportUpdateInput, BugsSettingsSearch } from '@foreman-code/contracts/management'
import { ApiError } from '../../shared/api/client'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { assertSession, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { bugReportClient } from './bugReportClient'

function keepLatest(previous: unknown, incoming: unknown) {
  const old = previous as BugReport | undefined
  const report = incoming as BugReport
  return old && old.id === report.id && old.revision > report.revision ? old : report
}

export function useBugReports(search: BugsSettingsSearch) {
  const generation = useHarnessSessionEpoch()
  return useInfiniteQuery({
    queryKey: ['bug-reports', generation, search.status, search.severity],
    initialPageParam: undefined as string | undefined,
    enabled: !sessionIsSwitching(),
    retry: false,
    queryFn: ({ signal, pageParam }) => {
      assertSession(generation)
      return bugReportClient.list({ status: search.status, severity: search.severity, cursor: pageParam }, { signal })
    },
    getNextPageParam: page => page.pageInfo.nextCursor ?? undefined,
  })
}

export function useBugReport(reportId: string) {
  const generation = useHarnessSessionEpoch()
  const cache = useQueryClient()
  const queryKey = ['bug-report', generation, reportId] as const
  const report = useQuery({
    queryKey,
    enabled: !sessionIsSwitching(),
    retry: false,
    structuralSharing: keepLatest,
    queryFn: ({ signal }) => {
      assertSession(generation)
      return bugReportClient.get(reportId, { signal })
    },
  })
  const denied = useAccessFailureLatch(report)
  const update = useMutation({
    mutationKey: [...queryKey, 'status'],
    retry: false,
    mutationFn: (input: BugReportUpdateInput) => {
      assertSession(generation)
      return bugReportClient.update(input)
    },
    onSuccess: async result => {
      assertSession(generation)
      await cache.cancelQueries({ queryKey, exact: true })
      assertSession(generation)
      cache.setQueryData(queryKey, previous => keepLatest(previous, result.report))
      await Promise.all([
        cache.invalidateQueries({ queryKey, exact: true }),
        cache.invalidateQueries({ queryKey: ['bug-reports', generation] }),
      ])
    },
  })
  const uncertain = update.isError && (!(update.error instanceof ApiError)
    || update.error.code === 'INVALID_RESPONSE' || update.error.status === 0 || update.error.status >= 500
    || update.error.status === 408 || update.error.status === 429)
  const refresh = async () => {
    const result = await report.refetch()
    if (!result.isError && !uncertain) update.reset()
  }
  const retry = () => {
    if (!update.variables || denied || sessionIsSwitching()) return Promise.resolve()
    return update.mutateAsync(update.variables)
  }
  return { report, update, denied, uncertain, refresh, retry }
}
