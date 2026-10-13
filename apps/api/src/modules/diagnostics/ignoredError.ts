import type { LogComponent } from './logComponent.js'
import { componentLogger } from './logger.js'

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code

/**
 * Makes a failure that must not change control flow visible: a warn line naming the component, the operation
 * that failed, caller-supplied ids, and the error. Use it for best-effort cleanup (rollback, kill, close, remove).
 * Errors whose `code` is in `expected` (for example ENOENT on an idempotent remove) stay silent.
 */
export function logIgnoredError(component: LogComponent, operation: string, error: unknown, context: Record<string, unknown> = {},
  expected: readonly string[] = []): void {
  const code = codeOf(error)
  if (typeof code === 'string' && expected.includes(code)) return
  componentLogger(component).warn({ operation, ...context, err: error }, `Ignored failure of ${operation}`)
}

/** A `.catch` handler that logs through `logIgnoredError` and resolves to `fallback`. */
export function fallbackOnError<T>(fallback: T, component: LogComponent, operation: string, context: Record<string, unknown> = {},
  expected: readonly string[] = []): (error: unknown) => T {
  return (error) => { logIgnoredError(component, operation, error, context, expected); return fallback }
}

/** A `.catch` handler that logs through `logIgnoredError` and resolves to undefined. */
export function ignoreError(component: LogComponent, operation: string, context: Record<string, unknown> = {},
  expected: readonly string[] = []): (error: unknown) => undefined {
  return fallbackOnError(undefined, component, operation, context, expected)
}
