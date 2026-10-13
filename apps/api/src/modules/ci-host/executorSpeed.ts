import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint, HostRef } from './serviceTypes.js'

const SAMPLES = 10
const MIN_FACTOR = 0.5
const MAX_FACTOR = 3

/** Actual over expected gate time per executor; cloud slots of one provider share a factor. */
export type ExecutorSpeeds = ReadonlyMap<string, number>

function refSpeedKey(hostRef: HostRef, computers: readonly HostCiComputer[]): string | undefined {
  if (hostRef.kind === 'cloud') return `cloud:${hostRef.provider}`
  return computers.find(computer => isDeepStrictEqual(computer.hostRef, hostRef))?.key
}

export function executorSpeedKey(computer: HostCiComputer): string {
  return computer.hostRef.kind === 'cloud' ? `cloud:${computer.hostRef.provider}` : computer.key
}

/** Median slowdown of each executor's latest passed gate integration parts, newest first, clamped to a sane range.
 * Parts another executor took were sized for different shards and are skipped; an applied factor is undone so the
 * estimate measures the executor, not the previous estimate. */
export function estimateExecutorSpeeds(runs: readonly CiRunRecord[],
  computers: readonly HostCiComputer[]): Map<string, number> {
  const samples = new Map<string, number[]>()
  for (const run of runs) {
    if (!run.gate || run.suite !== 'integration' || run.state !== 'passed' || !run.computer
      || !run.startedAt || !run.finishedAt || !run.expectedDurationMs || !run.plannedHostKey) continue
    const key = refSpeedKey(run.computer.hostRef, computers)
    const planned = computers.find(computer => computer.key === run.plannedHostKey)
    if (!key || !planned || executorSpeedKey(planned) !== key) continue
    const list = samples.get(key) ?? []
    if (list.length >= SAMPLES) continue
    const actual = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
    list.push(actual * (run.speedFactor ?? 1) / run.expectedDurationMs)
    samples.set(key, list)
  }
  return new Map([...samples].map(([key, ratios]) => {
    const sorted = [...ratios].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
    return [key, Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, median))]
  }))
}

/** Reads recent passed gate integration parts and estimates each current executor's speed. */
export async function readExecutorSpeeds(pool: pg.Pool, endpoint: HostCiEndpoint): Promise<Map<string, number>> {
  const rows = (await pool.query<{ record: unknown }>(`select record from ci_runs
    where state='passed' and record->>'suite'='integration' and record->>'gate'='true'
      and record->>'finishedAt' is not null order by created_at desc limit 300`)).rows
  return estimateExecutorSpeeds(rows.map(row => CiRunRecordSchema.parse(row.record)), await endpoint.computers())
}
