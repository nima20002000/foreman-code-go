import type pg from 'pg'
import { CiRunRecordSchema, type CiDurations } from '@foreman-code/contracts'
import { CI_QUEUE_ORDER } from './priority.js'

export async function readQueuedCiRuns(pool: pg.Pool) {
  // Check parts must remain visible even behind more than one batch of integration partitions.
  const queuedRows = (await pool.query<{ record: unknown; durations: CiDurations | null }>(
    `select record,durations from ci_runs where id in
      (select id from ci_runs where state='queued' and record->>'supersededBy' is null order by ${CI_QUEUE_ORDER} limit 50)
      or id in (select id from ci_runs where state='queued' and record->>'supersededBy' is null
        and record->>'suite'<>'integration'
        order by ${CI_QUEUE_ORDER} limit 50)
      order by ${CI_QUEUE_ORDER}`)).rows
  const parsed = queuedRows.map(row => CiRunRecordSchema.parse(row.record))
  const durations = new Map(queuedRows.map((row, index) => [parsed[index]!.id, row.durations]))
  return { parsed, durations }
}
