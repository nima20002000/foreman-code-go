import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitHubLoginStateSchema, type GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { apiClient } from './client'
import { sessionGeneration } from './sessionBoundary'

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  apiClient.request(path, GitHubLoginStateSchema, { method: 'POST', body, signal })

export function useGitHubLogin(target: DeviceProvisioningTarget) {
  const cache = useQueryClient()
  const queryPrefix = ['computer-github-login', sessionGeneration(), target]
  const settle = () => cache.invalidateQueries({ queryKey: ['computer-accounts'] })
  const clearStatus = async () => {
    await cache.cancelQueries({ queryKey: queryPrefix })
    cache.removeQueries({ queryKey: queryPrefix })
  }
  const start = useMutation({ retry: false,
    onMutate: async () => {
      logout.reset()
      setup.reset()
      await clearStatus()
    },
    mutationFn: () => post('/api/management/computers/github/login', { target }),
  })
  const logout = useMutation({ retry: false,
    mutationFn: () => post('/api/management/computers/github/logout', { target }),
    onMutate: clearStatus,
    onSuccess: async () => {
      start.reset()
      setup.reset()
      await settle()
    },
  })
  const loginId = start.data?.loginId ?? null
  const queryKey = [...queryPrefix, loginId]
  const setup = useMutation({ retry: false,
    mutationFn: () => post('/api/management/computers/github/setup-git', { target, loginId }),
    onSuccess: async state => {
      cache.setQueryData(queryKey, state)
      await settle()
    },
  })
  const status = useQuery<GitHubLoginState>({ queryKey,
    enabled: loginId !== null && !start.isPending && !logout.isPending && !logout.data, retry: false, gcTime: 0,
    refetchInterval: query => {
      const state = query.state.data ?? start.data
      if (query.state.error || state?.state !== 'waiting') return false
      return Math.max(1, Math.min(3_000, Date.parse(state.expiresAt!) - Date.now()))
    },
    queryFn: async ({ signal }) => {
      const previous = cache.getQueryData<GitHubLoginState>(queryKey) ?? start.data
      if (previous?.state === 'waiting' && previous.expiresAt && Date.parse(previous.expiresAt) <= Date.now()) {
        return { ...previous, state: 'expired' as const, code: null, message: 'The one-time code expired. Start again.' }
      }
      const state = await post('/api/management/computers/github/login/status', { target, loginId }, signal)
      if (state.state === 'signed-in' || state.state === 'git-setup-failed') await settle()
      return state
    },
  })
  const current: GitHubLoginState | undefined = logout.data ?? status.data ?? start.data
  return { start, logout, setup, status, current }
}
