import { HarnessNativeEventSchema, type HarnessNativeEvent } from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

/** The native-event insert, sequence allocation and Run Activity reference commit atomically. */
export async function appendNativeEvent(client: pg.Pool | pg.ClientBase, event: HarnessNativeEvent): Promise<void> {
  const parsed = HarnessNativeEventSchema.parse(event)
  try {
    // One server-side statement works with a Pool, an autocommit Client, or a
    // supplied ownership-fenced transaction. Never BEGIN/COMMIT the caller's
    // transaction or use different Pool connections for the lock and append.
    await client.query('select append_harness_native_event($1::jsonb)', [JSON.stringify(parsed)])
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'PNE01') {
      throw new DomainError('NATIVE_EVENT_IDENTITY_CONFLICT', 'The native source identity is already bound to different history.', 409)
    }
    throw error
  }
}
