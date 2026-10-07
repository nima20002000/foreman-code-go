import { JobRuntimeProfileListRecordSchema } from '@foreman-code/contracts/job-verification-runtime'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
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

/** The build computer that holds a verification profile prepares its own CI runtime; Main follows it. */
export function useComputerPreparation(workspaceId: string, profileId: string) {
  const cache = useQueryClient()
  const key = [...keys.root, 'preparation', sessionGeneration(), workspaceId, profileId] as const
  const url = `${path(workspaceId)}/runtime-profiles/${encodeURIComponent(profileId)}/computer-preparation`
  const status = useQuery({ queryKey: key, enabled: Boolean(workspaceId) && !sessionIsSwitching(), retry: false,
    refetchInterval: query => ['idle', 'qualified', 'failed'].includes(query.state.data?.state ?? 'idle') ? false : 5_000,
    queryFn: ({ signal }) => apiClient.request(url, BuildComputerPrepareStatusSchema, { signal }) })
  const start = useMutation({ retry: false,
    mutationFn: () => apiClient.request(url, BuildComputerPrepareStatusSchema, { method: 'POST', body: { commandId: crypto.randomUUID() } }),
    onSuccess: value => { cache.setQueryData(key, value) } })
  return { status, start }
}
