import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { agent3Database } from './wave25Agent3.js'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'

export function lifecycleFixtures() {
  let database: Awaited<ReturnType<typeof agent3Database>>
  const closes: Array<() => Promise<void>> = []

  // Runs and providers stay independent; only migrations and the pool are shared.
  beforeAll(async () => {
    database = await agent3Database()
  }, 60000)

  afterEach(async () => {
    try {
      while (closes.length) await closes.pop()!()
    } finally {
      vi.restoreAllMocks()
    }
  })

  afterAll(async () => {
    if (database) await database.close()
  })

  return async (options: Parameters<typeof checkpointRuntimeFixture>[2] = {}) => {
    const runtime = await checkpointRuntimeFixture(2, 1, { ...options, database })
    closes.push(runtime.close)
    return runtime
  }
}
