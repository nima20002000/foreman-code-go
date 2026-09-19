import { useEffect, useState } from 'react'
import { ApiError } from '../../shared/api/client'
import { isAuthAccessError } from './accessError'

/** UI-only denial latch: a later network failure must not reveal an old protected draft. */
export function useProtectedAccessError(query: {
  error: unknown; failureReason: unknown; isSuccess: boolean; failureCount: number; dataUpdatedAt: number
}, mutationError?: unknown): ApiError | undefined {
  const current = isAuthAccessError(query.error) ? query.error
    : isAuthAccessError(query.failureReason) ? query.failureReason
      : isAuthAccessError(mutationError) ? mutationError : undefined
  const [latched, setLatched] = useState<ApiError>()
  useEffect(() => {
    if (current) setLatched(current)
    else if (query.isSuccess && query.failureCount === 0) setLatched(undefined)
  }, [current, query.isSuccess, query.failureCount, query.dataUpdatedAt])
  return current ?? latched
}
