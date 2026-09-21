import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from './client'

/** Token stays in component memory, never in query keys, URLs, browser storage or mutation variables. */
export interface UserApprovalCredential { id: string; token?: string; signal: AbortSignal }
export type UserApprovalResponseInput = Parameters<typeof apiClient.respondToUserInteraction>[1]

export function useUserInteractionQuery(interactionId: string, credential: UserApprovalCredential) {
  return useQuery({
    queryKey: ['user-approval', credential.id, interactionId],
    queryFn: ({ signal }) => apiClient.getUserInteraction(interactionId, credential.token,
      { signal: AbortSignal.any([signal, credential.signal]) }),
    retry: false, gcTime: 0, staleTime: 0, refetchInterval: 5_000,
  })
}

export function useUserInteractionResponse(credential: UserApprovalCredential) {
  const client = useQueryClient()
  return useMutation({
    mutationKey: ['user-approval-response', credential.id],
    mutationFn: (input: UserApprovalResponseInput) => apiClient.respondToUserInteraction(credential.token, input, { signal: credential.signal }),
    retry: false, gcTime: 0,
    onSettled: async () => { await client.invalidateQueries({ queryKey: ['user-approval', credential.id] }) },
  })
}
