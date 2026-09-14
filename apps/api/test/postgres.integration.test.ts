import { randomUUID } from 'node:crypto'

import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import { describe, expect, it } from 'vitest'

import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'

const connectionString =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://graphql:graphql@127.0.0.1:5432/graphql'

describe('PostgreSQL infrastructure', () => {
  it('connects and keeps a LangGraph checkpoint after the saver is reopened', async () => {
    const database = createDatabase({
      connectionString,
      maxConnections: 2,
      connectionTimeoutMs: 5000,
    })
    const firstStore = createCheckpointStore(connectionString, 'langgraph_test')
    const threadId = `integration-${randomUUID()}`

    try {
      await database.ping()
      let savedConfig: RunnableConfig
      try {
        await firstStore.setup()
        const checkpoint = emptyCheckpoint()
        checkpoint.channel_values = { marker: 'durable-checkpoint' }
        checkpoint.channel_versions = { marker: 1 }
        savedConfig = await firstStore.saver.put(
          { configurable: { thread_id: threadId } },
          checkpoint,
          { source: 'input', step: -1, parents: {} },
          { marker: 1 },
        )
      } finally {
        await firstStore.close()
      }

      const reopenedStore = createCheckpointStore(connectionString, 'langgraph_test')
      try {
        await reopenedStore.ping()
        const restored = await reopenedStore.saver.getTuple(savedConfig)
        expect(restored?.checkpoint.channel_values).toEqual({ marker: 'durable-checkpoint' })
        await reopenedStore.saver.deleteThread(threadId)
      } finally {
        await reopenedStore.close()
      }
    } finally {
      await database.close()
    }
  })
})
