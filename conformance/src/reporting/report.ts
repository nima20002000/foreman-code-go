import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LANES, type Lane, type ResultTotals, type RunIdentity, type RunReport,
  type ScenarioFailure, type ScenarioOutcome, type Target } from './types.js'

function emptyTotals(): ResultTotals {
  return { total: 0, passed: 0, failed: 0, skipped: 0 }
}

function failureDescription(error: unknown, seen: Set<Error>): ScenarioFailure {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  if (seen.has(error)) return { name: error.name, message: 'Repeated error cause' }
  seen.add(error)
  const details = 'details' in error ? error.details : undefined
  const result: ScenarioFailure = { name: error.name, message: error.message,
    ...(details === undefined ? {} : { details }) }
  if (error instanceof AggregateError) {
    result.causes = error.errors.map((cause: unknown) => failureDescription(cause, seen))
  }
  if (error.cause !== undefined) result.cause = failureDescription(error.cause, seen)
  return result
}

export function describeFailure(error: unknown): ScenarioFailure {
  return failureDescription(error, new Set())
}

export function setupFailureOutcomes(
  scenarios: readonly { id: string; title: string; lane: Lane }[],
  error: unknown,
): ScenarioOutcome[] {
  const failure = describeFailure(error)
  return scenarios.map(scenario => ({
    id: scenario.id, title: scenario.title, lane: scenario.lane,
    status: 'failed', phase: 'setup', executed: false, durationMs: 0, error: failure,
  }))
}

export interface ReportInput {
  identity: RunIdentity
  target: Target
  startedAt: Date
  finishedAt: Date
  scenarios: readonly ScenarioOutcome[]
  setupError?: unknown
  cleanupError?: unknown
}

export function createReport(input: ReportInput): RunReport {
  const totals = emptyTotals()
  const lanes = Object.fromEntries(LANES.map(lane => [lane, emptyTotals()])) as Record<Lane, ResultTotals>
  const seen = new Set<string>()
  for (const scenario of input.scenarios) {
    if (seen.has(scenario.id)) throw new Error(`Duplicate conformance scenario ID: ${scenario.id}`)
    seen.add(scenario.id)
    if (!LANES.includes(scenario.lane)) throw new Error(`Unknown conformance lane: ${scenario.lane}`)
    if (!['passed', 'failed'].includes(scenario.status)) throw new Error(`Invalid scenario status: ${scenario.id}`)
    if (scenario.status === 'passed' && !scenario.executed) throw new Error(`Unexecuted scenario cannot pass: ${scenario.id}`)
    if (scenario.phase === 'setup' && scenario.executed) throw new Error(`Setup failure cannot be marked executed: ${scenario.id}`)
    if (!Number.isFinite(scenario.durationMs) || scenario.durationMs < 0) {
      throw new Error(`Invalid scenario duration: ${scenario.id}`)
    }
    for (const count of [totals, lanes[scenario.lane]]) {
      count.total += 1
      count[scenario.status] += 1
    }
  }
  const setupError = input.setupError === undefined ? undefined : describeFailure(input.setupError)
  const cleanupError = input.cleanupError === undefined ? undefined : describeFailure(input.cleanupError)
  return {
    ...input.identity,
    schemaVersion: 1,
    target: input.target,
    status: totals.total > 0 && totals.failed === 0 && !setupError && !cleanupError ? 'passed' : 'failed',
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    totals,
    lanes,
    scenarios: [...input.scenarios],
    ...(setupError ? { setupError } : {}),
    ...(cleanupError ? { cleanupError } : {}),
  }
}

/** Publish a complete result even when the chosen target cannot start. */
export async function writeReport(filename: string, report: RunReport): Promise<void> {
  await mkdir(dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, filename)
}
