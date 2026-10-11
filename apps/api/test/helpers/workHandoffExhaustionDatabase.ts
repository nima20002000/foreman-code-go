import { afterAll, beforeAll } from 'vitest'
import { currentDatabase } from './eng04CurrentDatabase.js'

export function sharedWorkHandoffExhaustionDatabase() {
  let database: Awaited<ReturnType<typeof currentDatabase>> | undefined
  beforeAll(async () => {
    database = await currentDatabase()
  }, 120000)
  afterAll(async () => {
    await database?.close()
  }, 120000)
  return () => {
    if (!database) throw new Error('Work handoff exhaustion database has not been initialized')
    return database
  }
}
