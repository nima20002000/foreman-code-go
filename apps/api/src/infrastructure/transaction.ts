import type pg from 'pg'

/** A supplied client belongs to the caller's transaction, including its commit/rollback. */
export async function inTransaction<T>(
  pool: pg.Pool,
  supplied: pg.ClientBase | undefined,
  perform: (client: pg.ClientBase) => Promise<T>,
): Promise<T> {
  if (supplied) return perform(supplied)
  const client = await pool.connect()
  let releaseError: Error | undefined
  try {
    await client.query('begin')
    const result = await perform(client)
    await client.query('commit')
    return result
  } catch (error) {
    try { await client.query('rollback') } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed.')
    }
    throw error
  } finally { client.release(releaseError) }
}
