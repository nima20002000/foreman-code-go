import { expect, it } from 'vitest'
import { createTestPool } from './helpers/testPool.mjs'

it('accepts an idle administrative termination arriving after pool teardown', async () => {
  const pool = createTestPool({ max: 1 })
  const closing = pool.end()
  const error = Object.assign(new Error('Administrative termination'), { code: '57P01' })
  expect(() => pool.emit('error', error)).not.toThrow()
  await closing
  expect(() => pool.emit('error', error)).not.toThrow()
})

it('reports administrative termination while the pool is still usable', async () => {
  const pool = createTestPool({ max: 1 })
  const error = Object.assign(new Error('Administrative termination'), { code: '57P01' })
  try {
    expect(() => pool.emit('error', error)).toThrow(error)
  } finally {
    await pool.end()
  }
})

it('reports other idle errors after pool teardown', async () => {
  const pool = createTestPool({ max: 1 })
  await pool.end()
  for (const code of ['08006', '57P02', undefined]) {
    const error = Object.assign(new Error('Unexpected connection failure'), { code })
    expect(() => pool.emit('error', error)).toThrow(error)
  }
})
