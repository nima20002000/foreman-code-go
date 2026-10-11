export class DomainError extends Error {
  // Transport handlers reuse a denial already recorded by the domain service.
  denialAudited = false

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

/** Safe read retries never expose database statements or persisted payloads. */
export function databaseReadFailure(error: unknown): unknown {
  if (error instanceof DomainError) return error
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const readTimeout = error instanceof Error && error.message === 'Query read timeout'
  if (code !== '57014' && !readTimeout) return error
  const failure = new DomainError('DATABASE_READ_TIMEOUT',
    'The database read exceeded its deadline. Retry the request.', 503, {
      retryable: true,
      reason: readTimeout ? 'query_read_timeout' : 'query_canceled',
      ...(code === '57014' ? { sqlState: code } : {}),
    })
  failure.cause = error
  return failure
}
