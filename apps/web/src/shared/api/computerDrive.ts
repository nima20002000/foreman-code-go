import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DriveLoginStateSchema, type DriveLoginState } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { ApiError, apiClient } from './client'
import { assertSession, sessionGeneration } from './sessionBoundary'

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  apiClient.request(path, DriveLoginStateSchema, { method: 'POST', body, ...(signal ? { signal } : {}) })

/** Request state stays in TanStack Query; each new operation clears the previous operation's result. */
export function useDriveConnection(target: DeviceProvisioningTarget) {
  const cache = useQueryClient()
  const generation = sessionGeneration()
  const queryKey = ['computer-drive-connect', generation, target]
  const settle = () => {
    assertSession(generation)
    return cache.invalidateQueries({ queryKey: ['computer-accounts', generation] })
  }
  const start = useMutation<DriveLoginState, Error, void>({ retry: false,
    mutationFn: () => {
      assertSession(generation)
      return post('/api/management/computers/drive/connect', { target })
    },
    onMutate: async () => {
      assertSession(generation)
      disconnect.reset()
      complete.reset()
      await cache.cancelQueries({ queryKey })
      cache.removeQueries({ queryKey })
    },
  })
  const loginId = start.data?.loginId ?? null
  const status = useQuery<DriveLoginState>({ queryKey: [...queryKey, loginId],
    enabled: loginId !== null, retry: false, gcTime: 0,
    refetchInterval: query => ['waiting', 'connecting'].includes((query.state.data ?? start.data)?.state ?? '') ? 3_000 : false,
    queryFn: async ({ signal }) => {
      assertSession(generation)
      const last = cache.getQueryData<DriveLoginState>([...queryKey, loginId]) ?? start.data
      if (last?.state === 'waiting' && last.expiresAt && Date.parse(last.expiresAt) <= Date.now()) {
        return { ...last, state: 'expired' as const, message: 'Google sign-in expired. Start again.' }
      }
      const state = await post('/api/management/computers/drive/connect/status', { target, loginId }, signal)
      if (state.state === 'connected') await settle()
      return state
    },
  })
  const complete = useMutation<DriveLoginState, Error, string>({ retry: false,
    mutationFn: (token: string) => {
      assertSession(generation)
      return post('/api/management/computers/drive/connect/complete', { target, loginId, token })
    },
    onMutate: () => cache.cancelQueries({ queryKey }),
    onSuccess: async state => {
      assertSession(generation)
      cache.setQueryData([...queryKey, loginId], state)
      await settle()
    },
  })
  const disconnect = useMutation<DriveLoginState, Error, void>({ retry: false,
    mutationFn: () => {
      assertSession(generation)
      return post('/api/management/computers/drive/disconnect', { target })
    },
    onMutate: async () => {
      assertSession(generation)
      await cache.cancelQueries({ queryKey })
    },
    onSuccess: async () => {
      assertSession(generation)
      start.reset()
      complete.reset()
      await settle()
    },
  })
  let current: DriveLoginState | undefined = disconnect.data ?? status.data ?? start.data
  if (!disconnect.data && current && status.error instanceof ApiError && status.error.code === 'DRIVE_LOGIN_NOT_FOUND') {
    current = { ...current, state: 'failed', message: status.error.message }
  }
  return { start, complete, disconnect, status, current }
}
