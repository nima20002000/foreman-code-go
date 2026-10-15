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
