import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DriveLoginStateSchema, type DriveLoginState } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { ApiError, apiClient } from './client'
import { assertSession, sessionGeneration } from './sessionBoundary'

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  apiClient.request(path, DriveLoginStateSchema, { method: 'POST', body, ...(signal ? { signal } : {}) })
interface Operation { number: number; scope: string }
interface Completion extends Operation { loginId: string | null; token: string }
interface Cancellation extends Operation { loginId: string | null }
const terminal = (error: Error | null) => error instanceof ApiError && [403, 404].includes(error.status)

/** TanStack owns request/results; the counter fences callbacks from superseded user actions. */
export function useDriveConnection(target: DeviceProvisioningTarget) {
  const cache = useQueryClient()
  const generation = sessionGeneration()
  const host = target.hostRef
  const scope = JSON.stringify([generation, host.mainId, host.kind,
    host.kind === 'device' ? host.deviceId : null, target.applicationInstallationId,
    target.keyRevision, target.authorizationRevision])
  const operation = useRef(0)
  const queryKey = ['computer-drive-connect', generation, target]
  const next = (): Operation => ({ number: ++operation.current, scope })
  const active = (value: Operation | undefined) => value?.number === operation.current && value.scope === scope
  const check = (value: Operation) => {
    assertSession(generation)
    if (!active(value)) throw new Error('A newer Drive request replaced this request.')
  }
  const settle = () => {
    assertSession(generation)
    return cache.invalidateQueries({ queryKey: ['computer-accounts', generation] })
  }
  const start = useMutation<DriveLoginState, Error, Operation>({ retry: false,
    mutationFn: value => {
      check(value)
      return post('/api/management/computers/drive/connect', { target })
    },
    onMutate: async value => {
      check(value)
      await cache.cancelQueries({ queryKey })
      check(value)
      cache.removeQueries({ queryKey })
    },
  })
  const startData = active(start.variables) ? start.data : undefined
  const loginId = startData?.loginId ?? null
  const status = useQuery<DriveLoginState>({ queryKey: [...queryKey, loginId],
    enabled: loginId !== null, retry: false, gcTime: 0,
    refetchInterval: query => {
      if (terminal(query.state.error)) return false
      return ['waiting', 'connecting'].includes((query.state.data ?? startData)?.state ?? '') ? 3_000 : false
    },
    queryFn: async ({ signal }) => {
      assertSession(generation)
      const last = cache.getQueryData<DriveLoginState>([...queryKey, loginId]) ?? startData
      if (last && ['waiting', 'connecting'].includes(last.state) && last.expiresAt
        && Date.parse(last.expiresAt) <= Date.now()) {
        return { ...last, state: 'expired' as const, authorizationCommand: null,
          message: 'Google sign-in expired. Start again.' }
      }
      const state = await post('/api/management/computers/drive/connect/status', { target, loginId }, signal)
      if (state.state === 'connected') await settle()
      return state
    },
  })
  const complete = useMutation<DriveLoginState, Error, Completion>({ retry: false,
    mutationFn: value => {
      check(value)
      return post('/api/management/computers/drive/connect/complete', { target, loginId: value.loginId, token: value.token })
    },
    onMutate: () => cache.cancelQueries({ queryKey }),
    onSuccess: async (state, value) => {
      if (!active(value)) return
      await cache.cancelQueries({ queryKey })
      if (!active(value)) return
      assertSession(generation)
      cache.setQueryData([...queryKey, value.loginId], state)
      await settle()
    },
  })
  const disconnect = useMutation<DriveLoginState, Error, Operation>({ retry: false,
    mutationFn: value => {
      check(value)
      return post('/api/management/computers/drive/disconnect', { target })
    },
    onMutate: () => cache.cancelQueries({ queryKey }),
    onSuccess: async (_state, value) => {
      if (!active(value)) return
      await settle()
    },
  })
  const cancel = useMutation<DriveLoginState, Error, Cancellation>({ retry: false,
    mutationFn: value => {
      check(value)
      return post('/api/management/computers/drive/connect/cancel', { target, loginId: value.loginId })
    },
    onMutate: () => cache.cancelQueries({ queryKey }),
    onSuccess: async (_state, value) => {
      if (active(value)) await settle()
    },
  })
  const latest = <T extends Operation>(mutation: { variables: T | undefined; data: DriveLoginState | undefined;
    error: Error | null; isPending: boolean }) => ({
    data: active(mutation.variables) ? mutation.data : undefined,
    error: active(mutation.variables) ? mutation.error : null,
    isPending: active(mutation.variables) && mutation.isPending,
  })
  let current = latest(cancel).data ?? latest(disconnect).data ?? status.data ?? startData
  const terminalStatus = terminal(status.error)
  if (current && terminalStatus) current = { ...current, state: 'failed', message: status.error!.message }
  return {
    start: { ...start, ...latest(start), mutate: () => start.mutate(next()), mutateAsync: () => start.mutateAsync(next()) },
    complete: { ...complete, ...latest(complete), mutate: (token: string) => complete.mutate({
      number: operation.current, scope, loginId, token,
    }) },
    disconnect: { ...disconnect, ...latest(disconnect), mutate: () => disconnect.mutate(next()) },
    cancel: { ...cancel, ...latest(cancel), mutate: (onSuccess: () => void) => cancel.mutate({ ...next(), loginId }, { onSuccess }) },
    status, terminalStatus, current,
  }
}
