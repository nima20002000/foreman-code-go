import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

export interface CheckpointStore {
  readonly saver: BaseCheckpointSaver
  setup(): Promise<void>
  ping(): Promise<void>
  close(): Promise<void>
}

export function createCheckpointStore(connectionString: string, schema: string): CheckpointStore {
  const saver = PostgresSaver.fromConnString(connectionString, { schema })

  return {
    saver,
    async setup() {
      await saver.setup()
    },
    async ping() {
      await saver.getTuple({ configurable: { thread_id: '__graphql_healthcheck__' } })
    },
    async close() {
      await saver.end()
    },
  }
}
