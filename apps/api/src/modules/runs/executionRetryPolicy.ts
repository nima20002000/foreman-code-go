import { setTimeout as delay } from 'node:timers/promises'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import { ZodError } from 'zod'
import { componentLogger } from '../diagnostics/logger.js'
import { isDatabasePoolTimeout, isDatabaseTimeout } from '../../infrastructure/transientErrors.js'
import { isTransientExecutionCode } from '../../shared/executionFailureCodes.js'
export { isTransientExecutionCode } from '../../shared/executionFailureCodes.js'

/** Agent failure attempts per work activation, including the first. At-least-once: an Agent
 * turn may run again after an infrastructure failure; only results are deduped. */
export const EXECUTION_MAX_ATTEMPTS = 3
export const EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS = 10 * 60_000
/** Wait before attempt 2, 3, ... (the last value repeats). */
export const EXECUTION_RETRY_BACKOFF_MS: readonly number[] = [10_000, 30_000, 60_000]

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const result = (error as { result?: ExecutionResult }).result
  if (result?.outcome === 'failed' && result.error?.code) return result.error.code
  return 'code' in error && error.code !== undefined ? String(error.code) : undefined
}

/** Shared classification. Transient: database timeouts and connection loss,
 * device/transport loss, MCP not ready, uncertain start or dispatch, interrupted
 * attempts, Worker restart and the credential failures they cause, and uncoded
 * runtime errors. Everything else (an Agent's failed result, an invalid output
 * contract, Stop, budget exhaustion, revoked access) is a real failure. */
export function isTransientExecutionError(error: unknown): boolean {
  const seen = new Set<object>()
  while (typeof error === 'object' && error !== null && !seen.has(error)) {
    seen.add(error)
    const wrapped = error as {
      result?: ExecutionResult; details?: { retryable?: boolean }; retryable?: boolean; cause?: unknown
    }
    const retryable = wrapped.retryable ?? wrapped.result?.error?.retryable ?? wrapped.details?.retryable
    if (typeof retryable === 'boolean') return retryable
    if (error instanceof ZodError || error instanceof AggregateError) return false
    if (isDatabaseTimeout(error) || isDatabasePoolTimeout(error)) return true
    const code = errorCode(error)
    if (code !== undefined && isTransientExecutionCode(code)) return true
    if (typeof wrapped.cause !== 'object' || wrapped.cause === null) {
      return code === undefined && error instanceof Error
    }
    error = wrapped.cause
  }
  return false
}

/** The recorded cause of one abandoned attempt; retryable marks it for a fresh attempt. */
export function transientExecutionFailure(error: unknown, fallbackCode = 'EXECUTION_START_INTERRUPTED'): ExecutionResult {
  const code = errorCode(error)
  const message = error instanceof Error && error.message ? error.message.slice(0, 2_000)
    : 'The attempt stopped before it produced an accepted result.'
  return { outcome: 'failed', error: { code: code ?? fallbackCode, message, retryable: true } }
}

export function isTransientExecutionResult(result: ExecutionResult | undefined): boolean {
  return result?.outcome === 'failed' && result.error?.retryable === true
}

/** Delay before starting the attempt after `failedAttempt`. */
export function executionRetryDelayMs(failedAttempt: number): number {
  const configured = process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS?.split(',').map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
  const backoff = configured?.length ? configured : EXECUTION_RETRY_BACKOFF_MS
  return backoff[Math.min(Math.max(failedAttempt, 1), backoff.length) - 1]!
}

/** Recorded infrastructure abandonment is separate from an Agent's retryable failed result. */
export function hasExecutionRetryBudget(failed: HarnessExecution, attempts: readonly {
  execution: HarnessExecution; infrastructureFailure: boolean
}[], now = Date.now()): boolean {
  const infrastructure = attempts.filter(attempt => attempt.infrastructureFailure)
  if (!infrastructure.some(attempt => attempt.execution.id === failed.id)) {
    return attempts.length - infrastructure.length < EXECUTION_MAX_ATTEMPTS
  }
  const firstFailureAt = infrastructure.reduce((earliest, attempt) =>
    Math.min(earliest, Date.parse(attempt.execution.finishedAt ?? '')), Infinity)
  const nextStartAt = now + executionRetryDelayMs(failed.attempt)
  return nextStartAt < firstFailureAt + EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS
}

/** Back off before a queued retry starts. A replayed retry that already started does not wait again. */
export async function waitBeforeRetry(failed: HarnessExecution, next: HarnessExecution, signal: AbortSignal): Promise<void> {
  if (next.state !== 'queued' || next.startedAt) return
  const waitMs = executionRetryDelayMs(failed.attempt)
  componentLogger('engine').warn({ runId: failed.runId, workflowNodeId: failed.workflowNodeId,
    executionId: failed.id, nextExecutionId: next.id, attempt: next.attempt, waitMs,
    code: failed.result?.outcome === 'failed' ? failed.result.error?.code : undefined }, 'Retrying work in a fresh attempt')
  await delay(waitMs, undefined, { signal })
}
