import { HarnessNativeEventSchema, type HarnessNativeEvent } from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

/** The native-event insert and its Run Activity reference either both commit or neither does. */
export async function appendNativeEvent(client: pg.Pool | pg.ClientBase, event: HarnessNativeEvent): Promise<void> {
  const parsed = HarnessNativeEventSchema.parse(event)
  const written = await client.query(
    `with appended as (
       insert into harness_native_events (execution_id,sequence,record) values ($1,$2,$3::jsonb)
       on conflict (execution_id,sequence) do nothing returning execution_id
     )
     insert into run_activity (run_id,source,kind,harness_execution_id,occurred_at,payload)
       select e.run_id,'harness','harness_output',e.id,$4::timestamptz,
         jsonb_build_object('nativeEventSequence',$2::integer,'nativeEventType',$5::text)
       from appended a join harness_executions e on e.id=a.execution_id`,
    [parsed.executionId, parsed.sequence, JSON.stringify(parsed), parsed.occurredAt, parsed.type],
  )
  if (written.rowCount === 1) return
  // Re-reading the same history is a storage replay, not permission to replay a
  // native action. Never silently overwrite or renumber a conflicting event.
  const existing = await client.query<{ matches: boolean }>(
    'select record=$3::jsonb as matches from harness_native_events where execution_id=$1 and sequence=$2',
    [parsed.executionId, parsed.sequence, JSON.stringify(parsed)],
  )
  if (!existing.rows[0]?.matches) {
    throw new DomainError('NATIVE_EVENT_IDENTITY_CONFLICT', 'This native event sequence is already bound to different history.', 409)
  }
}
