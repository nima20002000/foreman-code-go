import type { LogComponent } from './logComponent.js'

interface OperationalFailure {
  component: LogComponent
  operation: string
  status: 'degraded'
  lastError: string
  failureCount: number
  firstFailedAt: string
  lastFailedAt: string
}

const failures = new Map<string, OperationalFailure>()

/** Retain codes and fixed operation labels, never native output or credentials. */
export function recordOperationalFailure(component: LogComponent, operation: string, error: unknown): void {
  const key = `${component}:${operation}`
  const previous = failures.get(key)
  const code = (error as { code?: unknown } | null)?.code
  const now = new Date().toISOString()
  const lastError = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(code) ? code : 'OPERATION_FAILED'
  if (!previous && failures.size === 512) failures.delete(failures.keys().next().value!)
  failures.set(key, { component, operation, status: 'degraded', lastError,
    failureCount: (previous?.failureCount ?? 0) + 1, firstFailedAt: previous?.firstFailedAt ?? now, lastFailedAt: now })
}

export function readOperationalFailures(): OperationalFailure[] {
  return [...failures.values()].map(failure => ({ ...failure }))
}
