import { afterEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { DomainError } from '../src/modules/errors.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import {
  EXECUTION_MAX_ATTEMPTS, executionRetryDelayMs, isTransientExecutionError, transientExecutionFailure,
} from '../src/modules/runs/executionRetryPolicy.js'

const testBackoff = process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS
afterEach(() => {
  if (testBackoff === undefined) delete process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS
  else process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS = testBackoff
})

describe('execution failure classification', () => {
  it.each([
    new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'Dispatch may have occurred.', 409),
    new DomainError('EXECUTION_INTERRUPTED', 'interrupted', 409),
    new HarnessExecutionError('CODEX_APP_MCP_NOT_READY', 'MCP did not start'),
    new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'closed'),
    new DomainError('DEVICE_TRANSPORT_ERROR', 'link lost', 503),
    new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'no route', 503),
    new DomainError('WORKER_CREDENTIAL_EXPIRING', 'renewal failed', 409),
    new DomainError('DATABASE_READ_TIMEOUT', 'slow', 503),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    new Error('Query read timeout'),
    new Error('Native process is gone'),
  ])('retries infrastructure failure %#', (error) => {
    expect(isTransientExecutionError(error)).toBe(true)
  })

  it.each([
    new DomainError('WORK_RESULT_INVALID', 'contract', 409),
    new DomainError('WORKFLOW_EXECUTION_BUDGET_EXHAUSTED', 'budget', 409),
    new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'active budget', 409),
    new DomainError('AUTH_REVOKED', 'revoked by the owner', 401),
    new DomainError('GRAPH_STOP_CONFLICT', 'stopped', 409),
    new HarnessExecutionError('CODEX_TURN_FAILED', 'the Agent failed'),
    new ZodError([]),
    new AggregateError([new Error('close failed')], 'closure pending'),
  ])('does not retry task failure %#', (error) => {
    expect(isTransientExecutionError(error)).toBe(false)
  })

  it('records the original infrastructure code as a retryable cause', () => {
    expect(transientExecutionFailure(new HarnessExecutionError('CODEX_APP_MCP_NOT_READY', 'MCP did not start')))
      .toEqual({ outcome: 'failed', error: { code: 'CODEX_APP_MCP_NOT_READY', message: 'MCP did not start', retryable: true } })
    expect(transientExecutionFailure(new Error('Query read timeout')))
      .toEqual({ outcome: 'failed', error: { code: 'EXECUTION_START_INTERRUPTED', message: 'Query read timeout', retryable: true } })
  })

  it('backs off 10 s, 30 s, then 60 s and allows three attempts', () => {
    delete process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS
    expect(EXECUTION_MAX_ATTEMPTS).toBe(3)
    expect([1, 2, 3, 4].map(executionRetryDelayMs)).toEqual([10_000, 30_000, 60_000, 60_000])
    process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS = '5,7'
    expect([1, 2, 3].map(executionRetryDelayMs)).toEqual([5, 7, 7])
  })
})
