import type pg from 'pg'
import { CiRunRecordSchema, type CiDurations } from '@foreman-code/contracts'
import { CI_QUEUE_ORDER } from './priority.js'

export async function readQueuedCiRuns(pool: pg.Pool) {
  // Eligibility is resolved after loading the queue; blocked entries cannot hide runnable work.
  const queuedRows = (await pool.query<{ record: unknown; durations: CiDurations | null }>(
    `select record,durations from ci_runs where state='queued' and record->>'supersededBy' is null
      order by ${CI_QUEUE_ORDER}`)).rows
  const parsed = queuedRows.map(row => CiRunRecordSchema.parse(row.record))
  const durations = new Map(queuedRows.map((row, index) => [parsed[index]!.id, row.durations]))
  return { parsed, durations }
}

export async function readCiGateReservation(pool: pg.Pool) {
  const rows = (await pool.query<{ record: unknown }>(`select record from ci_runs
    where state in ('queued','starting','running') and record->>'gate'='true'
    order by record->>'queuedAt',group_id,id`)).rows
  const runs = rows.map(row => CiRunRecordSchema.parse(row.record))
  if (!runs.length) return { gate: undefined, reservedHosts: new Set<string | undefined>() }
  const groups = [...new Set(runs.map(run => run.groupId))]
  const failed = (await pool.query<{ group_id: string }>(`select distinct group_id from ci_runs
    where group_id=any($1::uuid[]) and state in ('failed','lost') and record->>'gate'='true'`, [groups])).rows
  // A failed or lost sibling releases the group's barrier and host reservations.
  const doomed = new Set(failed.map(row => row.group_id))
  const live = runs.filter(run => !doomed.has(run.groupId))
  const gate = live[0]
  const reservedHosts = new Set(live.filter(run => run.groupId === gate?.groupId && run.suite === 'integration')
    .map(run => run.plannedHostKey))
  return { gate, reservedHosts }
}
