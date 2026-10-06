import { JobRuntimeProfileListRecordSchema } from '@foreman-code/contracts/job-verification-runtime'
import { useQuery } from '@tanstack/react-query'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

const keys = { root: ['workbench', 'job-runtime-profiles'] as const,
  workspace: (workspaceId: string) => [...keys.root, sessionGeneration(), workspaceId] as const }
const path = (workspaceId: string) => `/api/management/workspaces/${encodeURIComponent(workspaceId)}/jobs`
export function useJobRuntimeProfiles(workspaceId: string) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: keys.workspace(workspaceId), enabled: Boolean(workspaceId) && !sessionIsSwitching(), retry: false,
    refetchInterval: 5_000,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request(`${path(workspaceId)}/runtime-profiles`, JobRuntimeProfileListRecordSchema, { signal })
      if (result.profiles.some(value => value.profile.workspaceId !== workspaceId) || result.approvals.some(value => value.workspaceId !== workspaceId))
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Runtime qualification readback belongs to another workspace.' })
      return result
    } })
}
