import { describe, expect, it } from 'vitest'
import { DomainError } from '../errors.js'
import { isTransientExecutionError } from './executionRetryPolicy.js'

describe('lost original remote replies', () => {
  it('start a fresh attempt for an unretained physical reply and stop for an uncaptured source', () => {
    expect(isTransientExecutionError(new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'The original physical reply is no longer retained.', 409))).toBe(true)
    expect(isTransientExecutionError(new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original source is unavailable.', 409))).toBe(false)
  })
})
