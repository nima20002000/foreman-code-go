import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GetRunRequestSchema, type GetRunRequest } from '@foreman-code/contracts'
import { z } from 'zod'

import { apiClient } from './client'
import { queryKeys } from './query'

export async function cancelRun(input: GetRunRequest) {
  const request = GetRunRequestSchema.parse(input)
  // The command acknowledgement carries no domain state. Read the canonical,
  // contract-validated run after the command instead of projecting its status.
  await apiClient.request(
    `/api/workspaces/${encodeURIComponent(request.workspaceId)}/runs/${encodeURIComponent(request.runId)}/cancel`,
    z.unknown(),
    { method: 'POST' },
  )
  return apiClient.getRun(request)
}

export function useCancelRunMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: cancelRun,
    onSuccess: (details, input) => {
      client.setQueryData(queryKeys.run(input.workspaceId, input.runId), details)
    },
  })
}
