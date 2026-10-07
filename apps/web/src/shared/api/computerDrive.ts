import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DriveLoginStateSchema, type DriveLoginState } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { apiClient } from './client'
import { sessionGeneration } from './sessionBoundary'

const post = (path: string, body: unknown) => apiClient.request(path, DriveLoginStateSchema, { method: 'POST', body })

/** Google Drive on one computer: start the Google sign-in, follow it until Drive is mounted, or disconnect. */
export function useDriveConnection(target: DeviceProvisioningTarget) {
  const cache = useQueryClient()
  const settle = () => cache.invalidateQueries({ queryKey: ['computer-accounts'] })
  const start = useMutation({ retry: false, mutationFn: () => post('/api/management/computers/drive/connect', { target }) })
  const disconnect = useMutation({ retry: false, mutationFn: () => post('/api/management/computers/drive/disconnect', { target }),
    onSuccess: settle })
  const loginId = start.data?.loginId ?? null
  const status = useQuery({ queryKey: ['computer-drive-connect', sessionGeneration(), target, loginId],
    enabled: loginId !== null, retry: false, gcTime: 0,
    refetchInterval: query => ['waiting', 'connecting'].includes((query.state.data ?? start.data)?.state ?? '') ? 3_000 : false,
    queryFn: async () => {
      const state = await post('/api/management/computers/drive/connect/status', { target, loginId })
      if (state.state === 'connected') await settle()
      return state
    } })
  const current: DriveLoginState | undefined = disconnect.data ?? status.data ?? start.data
  return { start, disconnect, current }
}
