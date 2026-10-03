import { expect, it } from 'vitest'
import { logger, serializeError } from './logger.js'

it('serializes original error identity and bounded cyclic causes without child process handles', () => {
  const child: { child?: unknown } = {}; child.child = child
  const cause = Object.assign(new Error('Original capture deadline.'), { code: 'ABORT_ERR', child })
  const error = Object.assign(new Error('Source capture failed.', { cause }), { code: 'SOURCE_CAPTURE_FAILED', child })
  Object.assign(cause, { cause: error })
  const serialized = serializeError(error)
  expect(() => JSON.stringify(serialized)).not.toThrow()
  expect(serialized).toMatchObject({ type: 'Error', message: 'Source capture failed.', code: 'SOURCE_CAPTURE_FAILED',
    cause: { message: 'Original capture deadline.', code: 'ABORT_ERR', cause: { message: 'Repeated or truncated error cause.' } } })
  expect(serialized).not.toHaveProperty('child')
  const serializers = Reflect.get(logger, Symbol.for('pino.serializers')) as { err(value: unknown): unknown; error(value: unknown): unknown }
  expect(serializers.err(error)).toEqual(serialized); expect(serializers.error(error)).toEqual(serialized)
})
