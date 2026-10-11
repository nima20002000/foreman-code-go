import { afterAll, beforeAll } from 'vitest'
import { currentDatabase } from './eng04CurrentDatabase.js'

/** Cases use distinct fixture IDs; migration setup is shared within each suite. */
export function workHandoffJoinDatabase() {
  let database: Awaited<ReturnType<typeof currentDatabase>> | undefined
  beforeAll(async () => {
    database = await currentDatabase()
  }, 120000)
  afterAll(async () => {
    await database?.close()
  }, 120000)
  return () => {
    if (!database) throw new Error('Join test database is not initialized')
    return database
  }
}
