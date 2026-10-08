import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitHubLoginStateSchema, type GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { ApiError, apiClient } from './client'
import { assertSession, sessionGeneration } from './sessionBoundary'

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  apiClient.request(path, GitHubLoginStateSchema, { method: 'POST', body, signal })

export function useGitHubLogin(target: DeviceProvisioningTarget) {
  const cache = useQueryClient()
  const generation = sessionGeneration()
  // Queued requests may finish after a newer intent; only the latest may clear another mutation.
  const intent = useRef(0)
  const scope = { id: JSON.stringify(['computer-github-login', generation, target]) }
  const queryPrefix = ['computer-github-login', generation, target]
  const settle = () => cache.invalidateQueries({ queryKey: ['computer-accounts'] })
  const clearStatus = async () => {
    await cache.cancelQueries({ queryKey: queryPrefix })
    cache.removeQueries({ queryKey: queryPrefix })
  }
  const start = useMutation<GitHubLoginState, Error, number>({ retry: false, scope,
    onMutate: async () => {
      logout.reset()
      setup.reset()
      await clearStatus()
    },
    mutationFn: () => {
      assertSession(generation)
      return post('/api/management/computers/github/login', { target })
    },
  })
  const logout = useMutation<GitHubLoginState, Error, number>({ retry: false, scope,
    mutationFn: () => {
      assertSession(generation)
      return post('/api/management/computers/github/logout', { target })
    },
    onMutate: clearStatus,
    onSuccess: async (_state, operation) => {
      if (operation === intent.current) {
        start.reset()
        setup.reset()
      }
      if (sessionGeneration() === generation) await settle()
    },
  })
  const loginId = start.data?.loginId ?? null
  const queryKey = useMemo(() => ['computer-github-login', generation, target, loginId],
    [generation, target, loginId])
  const setup = useMutation<GitHubLoginState, Error, number>({ retry: false, scope,
    mutationFn: () => {
      assertSession(generation)
      return post('/api/management/computers/github/setup-git', { target, loginId })
    },
    onSuccess: async (state, operation) => {
      if (operation !== intent.current || sessionGeneration() !== generation) return
      cache.setQueryData(queryKey, state)
      await settle()
    },
  })
  const status = useQuery<GitHubLoginState>({ queryKey,
    enabled: loginId !== null && !start.isPending && !logout.isPending && !logout.data, retry: false, gcTime: 0,
    refetchInterval: query => {
      const state = query.state.data ?? start.data
      if (query.state.error || state?.state !== 'waiting') return false
      if (!state.code || !state.expiresAt) return 3_000
      return Math.max(1, Math.min(3_000, Date.parse(state.expiresAt!) - Date.now()))
    },
    queryFn: async ({ signal }) => {
      const previous = cache.getQueryData<GitHubLoginState>(queryKey) ?? start.data
      if (previous?.state === 'waiting' && previous.code && previous.expiresAt && Date.parse(previous.expiresAt) <= Date.now()) {
        return expiredLogin(previous)
      }
      const state = await post('/api/management/computers/github/login/status', { target, loginId }, signal)
      if (state.state === 'signed-in' || state.state === 'git-setup-failed') await settle()
      return state
    },
  })
  const current: GitHubLoginState | undefined = logout.data ?? status.data ?? start.data
  const terminalError = ApiError.is(status.error) && [403, 404].includes(status.error.status)
  const accessDenied = ApiError.is(status.error) && status.error.status === 403
  const expiresAt = current?.state === 'waiting' && current.code && !terminalError && !start.isPending && !logout.isPending
    ? current.expiresAt : null
  useEffect(() => {
    if (!expiresAt) return
    const timer = setTimeout(() => {
      cache.setQueryData<GitHubLoginState>(queryKey, previous => {
        const state = previous ?? current
        return state?.state === 'waiting' ? expiredLogin(state) : state
      })
    }, Math.max(0, Date.parse(expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [cache, queryKey, current, expiresAt])
  return {
    start: { ...start, mutate: () => start.mutate(++intent.current) },
    logout: { ...logout, mutate: () => logout.mutate(++intent.current) },
    setup: { ...setup, mutate: () => setup.mutate(++intent.current) },
    status, current, terminalError, accessDenied,
  }
}


function expiredLogin(state: GitHubLoginState): GitHubLoginState {
  return { ...state, state: 'expired', code: null, message: 'The one-time code expired. Start again.' }
}
