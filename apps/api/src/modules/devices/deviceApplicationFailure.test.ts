import { describe, expect, it } from 'vitest'
import { deviceApplicationFailure } from './deviceApplicationError.js'

describe('device application failure codes', () => {
  it('reports a handler that timed out as a retryable timeout, not a rejected extension', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(deviceApplicationFailure(timeout)).toEqual({ code: 'timeout', retryable: true })
  })
})
