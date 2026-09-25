import type pg from 'pg'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { RepeatAuthoringService } from './authoring.js'
import { RepeatReadbackService } from './readback.js'
import { PostgresRepeatOccurrenceReadStore } from './postgresReadStore.js'

export interface RepeatServices {
  authoring: RepeatAuthoringService
  readback: RepeatReadbackService
}

/** Shared HTTP/Operator composition. The store reads the actual migrated
 * occurrence tables; it is not an execution owner, scheduler or native adapter. */
export function createRepeatServices(pool: pg.Pool, commands: PostgresCommandCoordinator): RepeatServices {
  return {
    authoring: new RepeatAuthoringService(pool, commands, true),
    readback: new RepeatReadbackService(pool, new PostgresRepeatOccurrenceReadStore(pool)),
  }
}
