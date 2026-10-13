import type pg from 'pg'
import { CiRunRecordSchema, type CiDurations, type CiRunRecord } from '@foreman-code/contracts'
import { saveQueuedCiRun } from './dispatch.js'
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

export async function readCiGateReservation(pool: pg.Pool) {
  const rows = (await pool.query<{ record: unknown }>(`select record from ci_runs
    where state in ('queued','starting','running','failed','lost') and record->>'gate'='true'
    order by record->>'queuedAt',group_id,id`)).rows
  const runs = rows.map(row => CiRunRecordSchema.parse(row.record))
  // A gate with a failed or lost part cannot pass, so it no longer holds the barrier or host reservations.
  const doomed = new Set(runs.filter(run => run.state === 'failed' || run.state === 'lost').map(run => run.groupId))
  const live = runs.filter(run => !doomed.has(run.groupId) && ['queued', 'starting', 'running'].includes(run.state))
  const gate = live[0]
  const reservedHosts = new Set(live.filter(run => run.groupId === gate?.groupId && run.suite === 'integration')
    .map(run => run.plannedHostKey))
  return { gate, reservedHosts }
}

/** Full requests collect failures from both tiers; affected requests stop after a fast-tier failure. */
export async function releaseCiSlowTier(pool: pg.Pool, queued: CiRunRecord[]): Promise<CiRunRecord[]> {
  const deferred = queued.filter(run => run.deferred)
  if (!deferred.length) return queued
  const groups = [...new Set(deferred.map(run => run.groupId))]
  const rows = (await pool.query<{ group_id: string; state: string }>(
    `select record->>'groupId' as group_id, state from ci_runs
      where record->>'groupId' = any($1::text[]) and coalesce((record->>'deferred')::boolean, false) = false`,
    [groups])).rows
  const waiting = new Set<string>()
  for (const groupId of groups) {
    const states = rows.filter(row => row.group_id === groupId).map(row => row.state)
    const slowRuns = deferred.filter(run => run.groupId === groupId)
    const continueAfterFailure = slowRuns.some(run => run.gate || run.scope === 'full')
    const stop = states.some(state => state === 'canceled' || state === 'lost'
      || state === 'failed' && !continueAfterFailure)
    if (stop) {
      const now = new Date().toISOString()
      for (const run of slowRuns) {
        const skipped = { ...run, state: 'canceled' as const, finishedAt: now,
          message: 'Skipped: slow tests run only after every other test of this request passed, and some did not.' }
        await saveQueuedCiRun(pool, run, skipped)
      }
      waiting.add(groupId)
    } else if (states.some(state => state !== 'passed' && state !== 'failed')) waiting.add(groupId)
  }
  return queued.filter(run => !run.deferred || !waiting.has(run.groupId))
}
