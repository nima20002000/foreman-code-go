/** Pure database error predicates; free of database and server imports so the Worker bundle can classify retries. */
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

export function isDatabasePoolTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'timeout exceeded when trying to connect'
    || error.message === 'Connection terminated due to connection timeout'
  )
}

const transientConnectionCodes = new Set([
  '55P03', '40001', '40P01', '57P01', '57P02', '57P03', '53300', 'DATABASE_RETRY_DEADLINE_EXCEEDED',
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
])

export function isTransientDatabaseOrSocketCode(code: string): boolean {
  return transientConnectionCodes.has(code) || /^08[A-Z0-9]{3}$/.test(code)
}

export function isTransientDatabaseOrSocketError(error: unknown): boolean {
  const seen = new Set<object>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    if (isDatabaseTimeout(error) || isDatabasePoolTimeout(error)) return true
    const code = 'code' in error ? error.code : undefined
    if (typeof code === 'string' && isTransientDatabaseOrSocketCode(code)) return true
    if (error instanceof Error && error.message === 'Connection terminated unexpectedly') return true
    error = 'cause' in error ? error.cause : undefined
  }
  return false
}
