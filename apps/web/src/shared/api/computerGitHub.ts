import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitHubLoginStateSchema, type GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { apiClient } from './client'
import { sessionGeneration } from './sessionBoundary'

const post = (path: string, body: unknown) => apiClient.request(path, GitHubLoginStateSchema, { method: 'POST', body })

export function useGitHubLogin(target: DeviceProvisioningTarget) {
  const cache = useQueryClient()
  const settle = () => cache.invalidateQueries({ queryKey: ['computer-accounts'] })
  const start = useMutation({ retry: false, mutationFn: () => post('/api/management/computers/github/login', { target }) })
  const logout = useMutation({ retry: false, mutationFn: () => post('/api/management/computers/github/logout', { target }),
    onSuccess: settle })
  const loginId = start.data?.loginId ?? null
  const status = useQuery({ queryKey: ['computer-github-login', sessionGeneration(), target, loginId],
    enabled: loginId !== null, retry: false, gcTime: 0,
    refetchInterval: query => (query.state.data ?? start.data)?.state === 'waiting' ? 3_000 : false,
    queryFn: async () => {
      const state = await post('/api/management/computers/github/login/status', { target, loginId })
      if (state.state === 'signed-in') await settle()
      return state
    } })
  const current: GitHubLoginState | undefined = status.data ?? start.data
  return { start, logout, status, current }
}
