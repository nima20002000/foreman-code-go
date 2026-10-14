import { expect, it } from 'vitest'
import * as diagnostics from './logger.js'
import { fallbackOnError } from './ignoredError.js'

it('retains sanitized warning causes, failure counts and age for owner readback', async () => {
  const failure = Object.assign(new Error('secret provider output'), { code: 'EIO' })
  const fallback = fallbackOnError(null, 'jobs', 'inspect retained CI logs')
  await Promise.reject(failure).catch(fallback)
  await Promise.reject(failure).catch(fallback)
  expect(diagnostics).toHaveProperty('readOperationalFailures')
  const read = Reflect.get(diagnostics, 'readOperationalFailures') as () => unknown[]
  const records = read()
  expect(records).toContainEqual(expect.objectContaining({ operation: 'inspect retained CI logs',
    status: 'degraded', lastError: 'EIO', failureCount: 2, firstFailedAt: expect.any(String),
    lastFailedAt: expect.any(String) }))
  expect(JSON.stringify(records)).not.toContain('secret provider output')
})
