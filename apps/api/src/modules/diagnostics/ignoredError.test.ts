import { afterEach, expect, it, vi } from 'vitest'
import { logger } from './logger.js'
import { fallbackOnError, ignoreError } from './ignoredError.js'

afterEach(() => { vi.restoreAllMocks() })

function captureWarnings() {
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = []
  const child = { warn: (fields: Record<string, unknown>, message: string) => { lines.push({ fields, message }) } }
  vi.spyOn(logger, 'child').mockReturnValue(child as never)
  return lines
}

it('logs an ignored failure with component, operation, ids and error, then resolves to undefined', async () => {
  const lines = captureWarnings()
  const failure = new Error('rollback refused')
  await expect(Promise.reject(failure).catch(ignoreError('db', 'transaction rollback', { commandId: 'command-1' }))).resolves.toBeUndefined()
  expect(lines).toHaveLength(1)
  expect(lines[0]!.message).toBe('Ignored failure of transaction rollback')
  expect(lines[0]!.fields).toMatchObject({ operation: 'transaction rollback', commandId: 'command-1', err: failure })
})

it('keeps expected error codes silent and resolves to the fallback', async () => {
  const lines = captureWarnings()
  const missing = Object.assign(new Error('gone'), { code: 'ENOENT' })
  await expect(Promise.reject(missing).catch(fallbackOnError(null, 'jobs', 'read exit file', {}, ['ENOENT']))).resolves.toBeNull()
  expect(lines).toHaveLength(0)
  await expect(Promise.reject(new Error('denied')).catch(fallbackOnError(null, 'jobs', 'read exit file', {}, ['ENOENT']))).resolves.toBeNull()
  expect(lines).toHaveLength(1)
})
