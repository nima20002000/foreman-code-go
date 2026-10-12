import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger } from '../modules/diagnostics/logger.js'

export function isDatabaseTimeout(error: unknown): boolean {
  const seen = new Set<object>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const code = 'code' in error ? error.code : undefined
    if (code === '57014') return true
    if (code !== undefined && !['GRAPH_TRANSACTION_FAILED', 'DATABASE_READ_TIMEOUT'].includes(String(code))) return false
    if (error instanceof Error && error.message === 'Query read timeout') return true
    error = 'cause' in error ? error.cause : undefined
  }
  return false
}

/** Retry only replay-safe bookkeeping. Native submissions are never passed here. */
export async function retryDatabaseTimeout<T>(work: () => Promise<T>, options: {
  signal?: AbortSignal | undefined
  check?(): void
} = {}): Promise<T> {
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
      if (!isDatabaseTimeout(error)) throw error
      if (waitMs === 100) {
        componentLogger('engine').warn('Database bookkeeping timed out; retaining native work while retrying.')
      }
      await delay(waitMs, undefined, { signal: options.signal })
      waitMs = Math.min(1_000, waitMs * 2)
    }
  }
}
