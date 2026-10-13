import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { CiDurationsSchema, CiRunRecordSchema, CiTestResultsSchema, type CiDurations,
  type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint, HostRef } from './serviceTypes.js'

const SAMPLES = 10
const MIN_FACTOR = 0.5
const MAX_FACTOR = 3

export interface ExecutorThroughput {
  factor: number
  throughput: number
  conservativeThroughput: number
}
/** Cloud slots of one provider share measurements; build computers have individual measurements. */
export type ExecutorSpeeds = ReadonlyMap<string, number | ExecutorThroughput>

function refSpeedKey(hostRef: HostRef, computers: readonly HostCiComputer[]): string | undefined {
  if (hostRef.kind === 'cloud') return `cloud:${hostRef.provider}`
  return computers.find(computer => isDeepStrictEqual(computer.hostRef, hostRef))?.key
}

export function executorSpeedKey(computer: HostCiComputer): string {
  return computer.hostRef.kind === 'cloud' ? `cloud:${computer.hostRef.provider}` : computer.key
}

/** Recent passed parts, newest first, measure file work per wall time. Cloud slowdown estimates undo the
 * previously applied factor and exclude parts planned for a different executor. */
export function estimateExecutorSpeeds(runs: readonly CiRunRecord[],
  computers: readonly HostCiComputer[], durations: ReadonlyMap<string, CiDurations> = new Map())
  : Map<string, number | ExecutorThroughput> {
  const samples = new Map<string, number[]>()
  const throughput = new Map<string, number[]>()
  for (const run of runs) {
    if (!run.gate || run.suite !== 'integration' || run.state !== 'passed' || !run.computer
      || !run.startedAt || !run.finishedAt) continue
    const key = refSpeedKey(run.computer.hostRef, computers)
    if (!key) continue
    const actual = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
    if (!Number.isFinite(actual) || actual <= 0) continue
    const measured = durations.get(run.id)
    const work = run.files.reduce((sum, file) => sum + (measured?.[file] ?? 0), 0)
    if (run.files.length && run.files.every(file => (measured?.[file] ?? 0) > 0) && work > 0) {
      const list = throughput.get(key) ?? []
      if (list.length < SAMPLES) list.push(work / actual)
      throughput.set(key, list)
    }
    const planned = computers.find(computer => computer.key === run.plannedHostKey)
    if (!planned || executorSpeedKey(planned) !== key || !run.expectedDurationMs) continue
    const list = samples.get(key) ?? []
    if (list.length >= SAMPLES) continue
    list.push(actual * (run.speedFactor ?? 1) / run.expectedDurationMs)
    samples.set(key, list)
  }
  const result = new Map<string, number | ExecutorThroughput>([...samples].map(([key, ratios]) =>
    [key, Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, median(ratios)))]))
  for (const [key, values] of throughput) {
    const typical = median(values)
    const factor = result.get(key)
    result.set(key, { factor: typeof factor === 'number' ? factor : 1, throughput: typical,
      conservativeThroughput: Math.min(typical, values[0]!) })
  }
  return result
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Reads recent passed gate integration parts and estimates each current executor's speed. */
export async function readExecutorSpeeds(pool: pg.Pool, endpoint: HostCiEndpoint)
  : Promise<Map<string, number | ExecutorThroughput>> {
  const rows = (await pool.query<{ record: unknown; durations?: unknown; test_results?: unknown }>(
    `select record,durations,test_results from ci_runs
    where state='passed' and record->>'suite'='integration' and record->>'gate'='true'
      and record->>'finishedAt' is not null order by created_at desc limit 300`)).rows
  const runs = rows.map(row => CiRunRecordSchema.parse(row.record))
  const durations = new Map<string, CiDurations>()
  for (const [index, row] of rows.entries()) {
    const results = row.test_results ? CiTestResultsSchema.parse(row.test_results) : null
    const measured = results ? Object.fromEntries(results.files.map(file => [file.file, file.durationMs ?? 0])) : null
    const run = runs[index]!
    if (measured && run.files.length && run.files.every(file => (measured[file] ?? 0) > 0)) {
      durations.set(run.id, measured)
    } else if (row.durations) {
      durations.set(run.id, CiDurationsSchema.parse(row.durations))
    }
  }
  return estimateExecutorSpeeds(runs, await endpoint.computers(), durations)
}
