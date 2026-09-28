import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  HarnessQualificationListSchema, type CompatibilityHarness,
} from '@graphql/contracts'
import type { z } from 'zod'
import { apiClient } from './client'

export const harnessQualificationKey = ['workbench', 'management', 'harness-qualifications'] as const
type QualificationList = z.infer<typeof HarnessQualificationListSchema>

export function useHarnessQualificationsQuery() {
  return useQuery({
    queryKey: harnessQualificationKey,
    queryFn: ({ signal }) => apiClient.request('/api/management/harnesses/qualifications', HarnessQualificationListSchema, { signal }),
    retry: false,
    refetchInterval: (query) => query.state.data?.qualifications.some((row) => row.status === 'qualifying') ? 1000 : false,
  })
}

export function useCheckHarnessQualification() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (harness: CompatibilityHarness) => apiClient.request(
      `/api/management/harnesses/${harness}/qualification`, HarnessQualificationListSchema.shape.qualifications.element, { method: 'POST', body: {} }),
    retry: false,
    onSuccess: (report) => {
      client.setQueryData<QualificationList>(harnessQualificationKey, (current) => current && ({
        qualifications: current.qualifications.some((row) => row.harness === report.harness)
          ? current.qualifications.map((row) => row.harness === report.harness ? report : row)
          : [...current.qualifications, report],
      }))
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: harnessQualificationKey }) },
  })
}
