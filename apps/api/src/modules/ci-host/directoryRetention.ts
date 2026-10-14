import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { CiHostRequestSchema, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'

export const CI_DIRECTORY_RETENTION_MS = 3 * 86_400_000
export const CI_DIRECTORY_KEEP = 200
const terminalStates = new Set(['passed', 'failed', 'canceled', 'lost'])

/** Main's saved ticket, including its executor attempts, determines which local directories can expire. */
export async function ciDirectoryCleanupCandidates(pool: pg.Pool, host: CiRunRecord['computer'], now = Date.now()) {
  if (!host) return []
  const hostRef = { ...host.hostRef }
  delete hostRef.slot
  const rows = (await pool.query<{ run_id: string; state: string; finished_at: string | null;
    collection: string | null; rank: string }>(`
    with attempts as (
      select id::text as run_id, state, record->>'finishedAt' as finished_at,
        record->>'collection' as collection, record#>'{computer,hostRef}' as host_ref
      from ci_runs where record->'setupRetry' is null
      union all
      select id::text, state, record->>'finishedAt', record->>'collection',
        record#>'{setupRetry,failedComputer}' from ci_runs where record->'setupRetry' is not null
      union all
      select record#>>'{setupRetry,runId}', state, record->>'finishedAt', record->>'collection',
        record#>'{computer,hostRef}' from ci_runs where record->'setupRetry' is not null
    ), ranked as (
      select *, row_number() over (order by finished_at::timestamptz desc nulls first, run_id desc) as rank
      from attempts where host_ref @> $1::jsonb and state in ('passed','failed','canceled','lost')
    )
    select run_id,state,finished_at,collection,rank from ranked where rank > $2`,
  [JSON.stringify(hostRef), CI_DIRECTORY_KEEP])).rows
  const cutoff = now - CI_DIRECTORY_RETENTION_MS
  return rows.filter(row => terminalStates.has(row.state) && row.collection !== 'pending'
    && row.finished_at !== null && Date.parse(row.finished_at) < cutoff).map(row => row.run_id)
}

/** Unknown, active and locally busy directories remain, even when Main has finished the ticket. */
export async function sweepCiRunDirectories(options: {
  root: string
  runIds: readonly string[]
  isInUse: (runId: string) => boolean
  withRun: (runId: string, work: () => Promise<boolean>) => Promise<boolean | undefined>
}): Promise<string[]> {
  const request = CiHostRequestSchema.parse({ operation: 'status', cleanupRunIds: options.runIds }) as
    Extract<CiHostRequest, { operation: 'status' }>
  const runIds = request.cleanupRunIds ?? []
  const removed: string[] = []
  for (const runId of new Set(runIds)) {
    if (options.isInUse(runId)) continue
    try {
      const deleted = await options.withRun(runId, async () => {
        if (options.isInUse(runId)) return false
        const directory = join(options.root, 'runs', runId)
        const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')) as { state: string }
        if (!terminalStates.has(meta.state) || options.isInUse(runId)) return false
        await rm(directory, { recursive: true, force: true })
        return true
      })
      if (deleted) removed.push(runId)
    } catch (error) {
      if (!['ENOENT', 'CI_RUN_UNKNOWN'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return removed
}
