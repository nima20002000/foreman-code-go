import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger } from '../modules/diagnostics/logger.js'

export function isDatabaseTimeout(error: unknown): boolean {
  const seen = new Set<object>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const code = 'code' in error ? error.code : undefined
    // 57014 also covers explicit cancellation; only a statement timeout is transient.
    if (code === '57014') return error instanceof Error && /time(d)? ?out/i.test(error.message)
    if (code === 'DATABASE_READ_TIMEOUT') return true
    if (code !== undefined && code !== 'GRAPH_TRANSACTION_FAILED') return false
    if (error instanceof Error && error.message === 'Query read timeout') return true
    if (error instanceof Error && error.message === 'Connection terminated due to connection timeout') return true
    error = 'cause' in error ? error.cause : undefined
  }
  return false
}

export interface DatabaseRetryOptions {
  signal?: AbortSignal | undefined
  check?(): void
}

/** Retry only replay-safe bookkeeping. Native submissions are never passed here. */
export function retryDatabaseTimeout<T>(work: () => Promise<T>, options: DatabaseRetryOptions = {}): Promise<T> {
  return retryDatabaseOperation(work, isDatabaseTimeout, options)
}

export async function retryDatabaseOperation<T>(
  work: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: DatabaseRetryOptions = {},
): Promise<T> {
  let waitMs = 100
  for (;;) {
    options.signal?.throwIfAborted()
    options.check?.()
    try {
      const result = await work()
      options.signal?.throwIfAborted()
      options.check?.()
      return result
    } catch (error) {
      options.signal?.throwIfAborted()
      options.check?.()
      if (!isRetryable(error)) throw error
      if (waitMs === 100) {
        componentLogger('engine').warn('Database operation is temporarily unavailable; retrying.')
      }
      await delay(waitMs, undefined, { signal: options.signal })
      waitMs = Math.min(1_000, waitMs * 2)
    }
  }
}
