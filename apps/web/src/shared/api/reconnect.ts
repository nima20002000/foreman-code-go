import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useQueryClient, type Query } from '@tanstack/react-query'
import { ApiError } from './client'

export const reconnectingMessage = 'Updating — reconnecting…'

export function isApiRestartError(error: unknown): boolean {
  return ApiError.is(error) && (error.code === 'NETWORK_ERROR' || error.status === 502 || error.status === 503)
}

function needsReconnect(query: Query): boolean {
  return query.isActive() && (isApiRestartError(query.state.error) || isApiRestartError(query.state.fetchFailureReason))
}

/** Request failures stay in Query; recovery refreshes the other mounted reads too. */
export function useApiReconnect(): boolean {
  const client = useQueryClient()
  const cache = client.getQueryCache()
  const reconnecting = useSyncExternalStore(
    listener => cache.subscribe(listener),
    () => cache.getAll().some(needsReconnect),
  )
  const wasReconnecting = useRef(false)
  useEffect(() => {
    if (!reconnecting) {
      if (wasReconnecting.current) void client.invalidateQueries({
        refetchType: 'active',
        predicate: query => query.meta?.refetchOnApiReconnect !== false,
      })
      wasReconnecting.current = false
      return
    }
    wasReconnecting.current = true
    const timer = window.setInterval(() => {
      void client.refetchQueries({ predicate: needsReconnect, type: 'active' }, { cancelRefetch: false })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [client, reconnecting])
  return reconnecting
}
