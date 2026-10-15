import { expect, it } from 'vitest'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { isTransientExecutionError } from '../runs/executionRetryPolicy.js'

it.each(['40P01', 'ECONNRESET'])('retains the retry classification of a redacted %s failure', code => {
  const secret = `opm_${'x'.repeat(43)}`
  const cause = Object.assign(new Error(`Database failure with ${secret}`), { code })
  const failure = new Error(`Native failure with ${secret}`, { cause })
  const redacted = nativePersistenceRedactor([secret]).error(failure)
  expect(redacted).toMatchObject({ cause: { code, message: 'Database failure with [REDACTED]' } })
  expect(isTransientExecutionError(redacted)).toBe(true)
  expect(redacted).not.toBe(failure)
  expect(JSON.stringify(redacted)).not.toContain(secret)
})
