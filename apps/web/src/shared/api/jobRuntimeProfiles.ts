import { JobRuntimeApprovalRecordSchema, JobRuntimeProfileListRecordSchema,
  type JobRuntimeApprovalRecord } from '@foreman-code/contracts/job-verification-runtime'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { JobRuntimeQualificationCommandSchema } from '@foreman-code/contracts/job-runtime'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'

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
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Runtime approval readback belongs to another workspace.' })
      return result
    } })
}
export function useApproveJobRuntime(workspaceId: string) {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...keys.workspace(workspaceId), 'approve'],
    mutationFn: async ({ approval, commandId }: { approval: JobRuntimeApprovalRecord; commandId: string }) => {
      if (approval.workspaceId !== workspaceId) throw new ApiError({ code: 'INVALID_REQUEST', message: 'Select the original workspace for this runtime approval.' })
      // The client sends the browser session through its existing credential boundary.
      const { approval: result } = await apiClient.request(`${path(workspaceId)}/runtime-qualifications/${encodeURIComponent(approval.id)}/approve`,
        z.object({ approval: JobRuntimeApprovalRecordSchema }).strict(), { method: 'POST', body: JobRuntimeQualificationCommandSchema.parse({ commandId }) })
      if (result.id !== approval.id || result.workspaceId !== workspaceId || result.profileId !== approval.profileId || result.profileRevision !== approval.profileRevision
        || result.qualificationId !== approval.qualificationId || result.fingerprintDigest !== approval.fingerprintDigest || !sameWorkflowValue(result.fingerprint, approval.fingerprint)
        || result.status !== 'approved' || !result.approvedByPrincipalId || !result.approvedAt)
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Approval was not confirmed for this exact runtime fingerprint.' })
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: keys.workspace(workspaceId) }),
    onError: () => client.invalidateQueries({ queryKey: keys.workspace(workspaceId) }),
  })
}
