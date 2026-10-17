import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PublicHttpClient } from './clients/http.js'
import { describeFailure } from './reporting/report.js'
import type { ScenarioOutcome } from './reporting/types.js'
import type { TargetSession } from './runtime/target.js'
import type { Scenario, ScenarioContext } from './scenario.js'

export interface RunnerOptions {
  launch(scenario: Scenario): Promise<TargetSession>
  timeoutMs?: number
  onOutcome?(outcome: ScenarioOutcome): Promise<void> | void
  onProgress?(event: ScenarioProgress): void
}

export interface ScenarioProgress {
  type: 'start' | 'finish'
  phase: 'setup' | 'scenario'
  scenario: Pick<Scenario, 'id' | 'title' | 'lane'>
  executed: boolean
  status?: 'passed' | 'failed'
}

function scenarioDeadline(milliseconds: number, abort: AbortController): {
  expired: Promise<never>
  close(): void
} {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error('Scenario timeout must be positive')
  let timer: ReturnType<typeof setTimeout>
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Scenario did not finish within ${milliseconds} ms`)
      abort.abort(error)
      reject(error)
    }, milliseconds)
  })
  return { expired, close: () => clearTimeout(timer) }
}

async function executeScenario(scenario: Scenario, options: RunnerOptions): Promise<ScenarioOutcome> {
  const startedAt = performance.now()
  const abort = new AbortController()
  let target: TargetSession | undefined
  let executed = false
  let phase: ScenarioOutcome['phase'] = 'setup'
  let failed = false
  let failure: unknown
  let setupFinished = false
  options.onProgress?.({ type: 'start', phase: 'setup', scenario, executed: false })
  try {
    target = await options.launch(scenario)
    const scenarioDirectory = join(target.directory, 'scenario')
    await mkdir(scenarioDirectory, { mode: 0o700 })
    const context: ScenarioContext = {
      target,
      scenarioDirectory,
      signal: abort.signal,
      http: new PublicHttpClient({ baseUrl: target.baseUrl, browserOrigin: target.browserOrigin, signal: abort.signal }),
    }
    const deadline = scenarioDeadline(scenario.timeoutMs ?? options.timeoutMs ?? 30_000, abort)
    setupFinished = true
    options.onProgress?.({ type: 'finish', phase: 'setup', scenario, executed: false, status: 'passed' })
    try {
      phase = 'scenario'
      executed = true
      options.onProgress?.({ type: 'start', phase: 'scenario', scenario, executed })
      await Promise.race([Promise.resolve().then(() => scenario.run(context)), deadline.expired])
    } finally {
      deadline.close()
    }
  } catch (error) {
    failed = true
    failure = error
  } finally {
    abort.abort(new Error('Scenario finished'))
    if (!setupFinished) {
      options.onProgress?.({ type: 'finish', phase: 'setup', scenario, executed: false, status: 'failed' })
    }
    try { await target?.close() }
    catch (error) {
      if (!failed) {
        failure = error
        phase = 'cleanup'
      } else {
        failure = new AggregateError([failure, error], 'Scenario and target cleanup failed')
      }
      failed = true
    }
  }
  const outcome: ScenarioOutcome = {
    id: scenario.id,
    title: scenario.title,
    lane: scenario.lane,
    status: failed ? 'failed' : 'passed',
    phase,
    executed,
    durationMs: Math.max(0, performance.now() - startedAt),
  }
  if (failed) outcome.error = describeFailure(failure)
  if (executed) {
    options.onProgress?.({ type: 'finish', phase: 'scenario', scenario, executed, status: outcome.status })
  }
  return outcome
}

/** A missing route, failed assertion, or failed target setup never drops later scenarios. */
export async function runScenarios(scenarios: readonly Scenario[], options: RunnerOptions): Promise<ScenarioOutcome[]> {
  const seen = new Set<string>()
  for (const scenario of scenarios) {
    if (!scenario.id.trim() || seen.has(scenario.id)) throw new Error(`Duplicate or empty scenario ID: ${scenario.id}`)
    seen.add(scenario.id)
  }
  const outcomes: ScenarioOutcome[] = []
  for (const scenario of scenarios) {
    const outcome = await executeScenario(scenario, options)
    outcomes.push(outcome)
    await options.onOutcome?.(outcome)
  }
  return outcomes
}
