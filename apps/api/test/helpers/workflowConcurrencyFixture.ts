import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { agent3Database } from './wave25Agent3.js'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'

export function workflowConcurrencyFixture() {
  let database: Awaited<ReturnType<typeof agent3Database>> | undefined

  beforeAll(async () => {
    database = await agent3Database()
  }, 60_000)

  afterAll(async () => {
    await database?.close()
  }, 60_000)

  return (options: { workerParallelism?: number } = {}) => {
    if (!database) throw new Error('Workflow concurrency database is not initialized')
    return checkpointRuntimeFixture(1, 1, {
      ...options,
      database,
      fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
      approvalNodeIds: [],
    })
  }
}
