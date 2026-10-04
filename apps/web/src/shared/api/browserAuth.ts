import {
  BrowserAccessLogoutSchema, BrowserSignInRequestSchema, BrowserSignInResponseSchema,
  OwnerSetupRequestSchema, OwnerSetupResponseSchema, OwnerSetupStatusSchema,
  type BrowserSignInRequest, type OwnerSetupRequest,
} from '@foreman-code/contracts/management'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from './client'

export const browserAuthClient = {
  setupStatus: (signal?: AbortSignal) => apiClient.request('/api/auth/setup', OwnerSetupStatusSchema, signal ? { signal } : {}),
  setup: (input: OwnerSetupRequest) => apiClient.request('/api/auth/setup', OwnerSetupResponseSchema,
    { method: 'POST', body: OwnerSetupRequestSchema.parse(input) }),
  signIn: (input: BrowserSignInRequest) => apiClient.request('/api/auth/sign-in/email', BrowserSignInResponseSchema,
    { method: 'POST', body: BrowserSignInRequestSchema.parse(input) }),
  signOut: () => apiClient.request('/api/auth/logout', BrowserAccessLogoutSchema, { method: 'POST' }),
}

export function useOwnerSetupStatus() {
  return useQuery({ queryKey: ['browser-auth', 'setup'], retry: false, staleTime: 0,
    queryFn: ({ signal }) => browserAuthClient.setupStatus(signal) })
}
