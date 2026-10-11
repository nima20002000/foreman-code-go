import { afterAll, afterEach, beforeAll } from 'vitest'
import { agent3Database } from './wave25Agent3.js'

export function lifecycleParityFixture() {
  let database: Awaited<ReturnType<typeof agent3Database>> | undefined
  const closes: Array<() => Promise<void>> = []

  // Each case seeds distinct workflow/run IDs; only migrations and the pool are shared.
  beforeAll(async () => {
    database = await agent3Database()
  }, 60000)

  afterEach(async () => {
    while (closes.length) await closes.pop()!()
  })

  afterAll(async () => {
    if (database) await database.close()
  })

  return {
    database() {
      if (!database) throw new Error('Lifecycle parity database is not initialized')
      return database
    },
    closeAfterEach(close: () => Promise<void>) {
      closes.push(close)
    },
  }
}
