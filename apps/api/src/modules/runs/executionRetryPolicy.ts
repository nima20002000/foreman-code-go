import { setTimeout as delay } from 'node:timers/promises'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import { ZodError } from 'zod'
import { componentLogger } from '../diagnostics/logger.js'
import { isDatabasePoolTimeout, isDatabaseTimeout } from '../../infrastructure/transientErrors.js'

/** Agent failure attempts per work activation, including the first. At-least-once: an Agent
 * turn may run again after an infrastructure failure; only results are deduped. */
export const EXECUTION_MAX_ATTEMPTS = 3
export const EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS = 10 * 60_000
/** Wait before attempt 2, 3, ... (the last value repeats). */
export const EXECUTION_RETRY_BACKOFF_MS: readonly number[] = [10_000, 30_000, 60_000]

/** Infrastructure failures: the work itself did not fail, the way to run it did. */
const transientCodes = new Set([
  'EXECUTION_INTERRUPTED', 'EXECUTION_START_INTERRUPTED', 'NATIVE_SESSION_START_UNCERTAIN',
  'NATIVE_EXECUTION_FAILED', 'NATIVE_HISTORY_GAP', 'CODEX_OBSERVER_UNAVAILABLE', 'CODEX_APP_MCP_NOT_READY',
  'APP_MCP_PREFLIGHT_FAILED', 'APP_MCP_PREFLIGHT_TIMEOUT', 'DATABASE_READ_TIMEOUT',
  'REMOTE_DISPATCH_UNAVAILABLE', 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'WORKER_WORKFLOW_UNAVAILABLE', 'WORKER_MCP_UNAVAILABLE', 'WORKER_MCP_LEASE_UNAVAILABLE',
  'WORKER_CREDENTIAL_EXPIRING', 'WORKER_CREDENTIAL_LOST', 'WORKER_CREDENTIAL_RENEWAL_BUSY',
  'CLAUDE_SESSION_UNAVAILABLE', 'CLAUDE_MCP_CONTROL_UNAVAILABLE', 'CLAUDE_OWNER_UNAVAILABLE',
  'DEVICE_TRANSPORT_ERROR', 'DEVICE_RUNTIME_CLOSING', 'DEVICE_RUNTIME_UNAVAILABLE', 'DEVICE_CONNECTION_UNAVAILABLE',
  'DEVICE_HOST_UNAVAILABLE', 'DEVICE_CHANNEL_BACKPRESSURE', 'DEVICE_TRANSFER_CONNECTION_CHANGED', 'DEVICE_TRANSFER_EXPIRED',
  // PostgreSQL statement timeout, connection and restart failures; Node socket failures.
  '57014', '55P03', '40001', '40P01', '57P01', '57P02', '57P03', '53300', '08000', '08001', '08003', '08006',
  'DATABASE_RETRY_DEADLINE_EXCEEDED',
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
])
const transientPrefixes = ['CODEX_APP_SERVER_']

export function isTransientExecutionCode(code: string): boolean {
  return transientCodes.has(code) || transientPrefixes.some((prefix) => code.startsWith(prefix))
}

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
    if (error instanceof ZodError || error instanceof AggregateError) return false
    if (isDatabaseTimeout(error) || isDatabasePoolTimeout(error)) return true
    const wrapped = error as {
      result?: ExecutionResult; details?: { retryable?: boolean }; retryable?: boolean; cause?: unknown
    }
    if (wrapped.retryable === true || wrapped.result?.error?.retryable === true
      || wrapped.details?.retryable === true) return true
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
