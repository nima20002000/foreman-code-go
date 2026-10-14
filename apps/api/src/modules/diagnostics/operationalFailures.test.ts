import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import * as diagnostics from './logger.js'
import * as ignored from './ignoredError.js'
import { fallbackOnError } from './ignoredError.js'

vi.mock('pino-roll', () => ({ default: async () => new PassThrough() }))

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

it('exposes invalid provided retention settings while preserving documented defaults', async () => {
  await diagnostics.enableFileLogging({ LOG_FILE: '/fixture/uncreated/log.log', LOG_MAX_FILES: 'invalid' })
  expect(diagnostics.readOperationalFailures()).toContainEqual(expect.objectContaining({
    operation: 'read log retention configuration', lastError: 'INVALID_LOG_CONFIG' }))
})

it('counts disconnected resource cleanup failures without replacing the primary outcome', async () => {
  expect(ignored).toHaveProperty('settleObserved')
  const settle = Reflect.get(ignored, 'settleObserved') as (component: string, operation: string,
    tasks: Promise<unknown>[]) => Promise<PromiseSettledResult<unknown>[]>
  const failure = Object.assign(new Error('Cleanup failed'), { code: 'EIO' })
  const outcomes = await settle('http', 'close disconnected MCP resources', [Promise.reject(failure), Promise.resolve()])
  expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'fulfilled'])
  expect(diagnostics.readOperationalFailures()).toContainEqual(expect.objectContaining({
    operation: 'close disconnected MCP resources', lastError: 'EIO', failureCount: 1 }))
})

it('retains a sanitized underlying cause when the wrapper has no classification', () => {
  const cause = Object.assign(new Error('Private storage details'), { code: 'EIO' })
  ignored.logIgnoredError('db', 'record secondary audit failure', new Error('Audit failed', { cause }))
  expect(diagnostics.readOperationalFailures()).toContainEqual(expect.objectContaining({
    operation: 'record secondary audit failure', lastError: 'EIO' }))
  expect(JSON.stringify(diagnostics.readOperationalFailures())).not.toContain('Private storage details')
})
