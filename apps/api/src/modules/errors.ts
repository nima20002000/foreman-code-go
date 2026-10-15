import type { FailureClass } from '@foreman-code/contracts/failure'
import { deviceApplicationFailure } from './devices/deviceApplicationError.js'

export class DomainError extends Error {
  // Transport handlers reuse a denial already recorded by the domain service.
  denialAudited = false

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DomainError'
  }
}

/** The `class` a public HTTP or MCP error reply adds, so a retryable failure is not read as final. Omitted when
 * the error already states `details.retryable` or is permanent. */
export function publicFailureClass(error: unknown): FailureClass | undefined {
  if (error instanceof DomainError && typeof error.details?.retryable === 'boolean') return undefined
  const failure = deviceApplicationFailure(error)
  return failure.class === 'permanent' ? undefined : failure.class
}

/** Safe read retries never expose database statements or persisted payloads. */
export function databaseReadFailure(error: unknown): unknown {
  if (error instanceof DomainError) return error
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const readTimeout = error instanceof Error && error.message === 'Query read timeout'
  if (code !== '57014' && code !== '55P03' && !readTimeout) return error
  const failure = new DomainError('DATABASE_READ_TIMEOUT',
    'The database read exceeded its deadline. Retry the request.', 503, {
      retryable: true,
      reason: readTimeout ? 'query_read_timeout' : code === '55P03' ? 'lock_timeout' : 'query_canceled',
      ...(readTimeout ? {} : { sqlState: code }),
    })
  failure.cause = error
  return failure
}

/** Replays an idempotent read after a lock or statement timeout; a timeout that persists becomes DATABASE_READ_TIMEOUT. */
export async function retryDatabaseRead<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      const failure = databaseReadFailure(error)
      if (failure === error || attempt >= attempts) throw failure
    }
  }
}
