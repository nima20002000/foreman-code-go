import pg from 'pg'

export function createTestPool(options) {
  const pool = new pg.Pool(options)
  pool.on('error', error => {
    // Pool.end() can resolve before idle sockets close and a forced drop reaches them.
    if (pool.ending && error.code === '57P01') return
    throw error
  })
  return pool
}
