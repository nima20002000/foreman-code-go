import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  HarnessCompatibilityListSchema, HarnessCompatibilitySchema,
  type CompatibilityHarness, type HarnessCompatibilityList, type HarnessCompatibility,
} from '@graphql/contracts'
import { apiClient, type RequestOptions } from './client'

export const harnessCompatibilityKey = ['workbench', 'management', 'harness-compatibility'] as const
export function getHarnessCompatibility(options?: RequestOptions) {
  return apiClient.request('/api/management/harnesses/compatibility', HarnessCompatibilityListSchema, options)
}
export function retryHarnessCompatibility(harness: CompatibilityHarness) {
  return apiClient.request(`/api/management/harnesses/${harness}/compatibility/retry`, HarnessCompatibilitySchema, { method: 'POST', body: {} })
}
export function useHarnessCompatibilityQuery() {
  return useQuery({
    queryKey: harnessCompatibilityKey,
    queryFn: ({ signal }) => getHarnessCompatibility({ signal }),
    retry: false,
    staleTime: 10_000,
    refetchInterval: (query) => query.state.data?.harnesses.some((row) => row.status === 'checking') ? 1000 : 30_000,
  })
}
export function useRetryHarnessCompatibility(onAccepted?: (report: HarnessCompatibility) => void) {
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...harnessCompatibilityKey, 'retry'],
    mutationFn: retryHarnessCompatibility,
    retry: false, // A missing acknowledgement is not permission to spawn another check.
    onMutate: async () => { await client.cancelQueries({ queryKey: harnessCompatibilityKey }) },
    onSuccess: (report) => {
      onAccepted?.(report)
      client.setQueryData<HarnessCompatibilityList>(harnessCompatibilityKey, (current) => current && ({
        ...current, harnesses: current.harnesses.map((row) => row.harness === report.harness ? report : row),
      }))
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: harnessCompatibilityKey }) },
  })
}
