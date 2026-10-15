import { describe, expect, it } from 'vitest'
import { DomainError } from '../errors.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { isTransientExecutionCode, isTransientExecutionError } from './executionRetryPolicy.js'

describe('lost original remote replies', () => {
  it('start a fresh attempt for an unretained physical reply and stop for an uncaptured source', () => {
    expect(isTransientExecutionError(new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'The original physical reply is no longer retained.', 409))).toBe(true)
    expect(isTransientExecutionError(new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original source is unavailable.', 409))).toBe(false)
  })
})

describe('explicit execution retry classification', () => {
  it.each([
    { code: 'CODEX_APP_SERVER_DISCONNECTED', retryable: false },
    { code: 'ECONNRESET', details: { retryable: false } },
    new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Authentication is required.', false),
    new HarnessExecutionError('CODEX_APP_SERVER_TIMEOUT', 'Do not replay this operation.', false),
    Object.assign(new Error('Permanent failure', { cause: { code: 'ECONNRESET' } }), { retryable: false }),
    { code: 'DATABASE_READ_TIMEOUT', retryable: false },
  ])('honors an explicit permanent classification %#', error => {
    expect(isTransientExecutionError(error)).toBe(false)
  })

  it.each(['CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'CODEX_APP_SERVER_VERSION_UNQUALIFIED',
    'CODEX_APP_SERVER_REQUEST_CANCELED', 'CODEX_APP_SERVER_RESPONSE_INVALID', 'CODEX_APP_SERVER_UNKNOWN'])
  ('does not infer retryability from the Codex prefix: %s', code => {
    expect(isTransientExecutionCode(code)).toBe(false)
    expect(isTransientExecutionError({ code })).toBe(false)
  })

  it.each(['CODEX_APP_SERVER_DISCONNECTED', 'CODEX_APP_SERVER_TIMEOUT', 'CODEX_APP_SERVER_REQUEST_UNCERTAIN'])
  ('retries a known transient code without an explicit classification: %s', code => {
    expect(isTransientExecutionCode(code)).toBe(true)
    expect(isTransientExecutionError({ code })).toBe(true)
  })

  it('honors an explicit transient classification for an unknown provider code', () => {
    expect(isTransientExecutionError(new HarnessExecutionError('PROVIDER_BUSY', 'Try later.', true))).toBe(true)
  })

  it('gives unclassified harness failures the same transient code defaults as execution retries', () => {
    const disconnected = new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Connection lost.')
    expect(disconnected.result.error?.retryable).toBe(true)
    expect(isTransientExecutionError(disconnected)).toBe(true)
    const rejected = new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Sign in again.')
    expect(rejected.result.error?.retryable).toBe(false)
    expect(isTransientExecutionError(rejected)).toBe(false)
  })
})
