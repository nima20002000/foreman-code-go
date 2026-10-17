import { listOperatorToolNames } from '../clients/mcp.js'
import { setupFixtures } from '../harnesses/setup.js'
import { describeFailure } from '../reporting/report.js'
import type { ScenarioFailure, Target } from '../reporting/types.js'
import { startTarget, type TargetCleanupEvent } from '../runtime/target.js'
import type { Scenario } from '../scenario.js'
import { checkMcpCoverage, type CoverageResult } from './checks.js'

export type LiveCoverageResult = CoverageResult
  | { status: 'not-run'; reason: string }
  | { status: 'unavailable'; error: ScenarioFailure }

export async function checkLiveMcpCoverage(options: {
  target: Target
  repoRoot: string
  environment: NodeJS.ProcessEnv
  scenarios: readonly Scenario[]
  onCleanup?(event: TargetCleanupEvent): void
}): Promise<LiveCoverageResult> {
  let target: Awaited<ReturnType<typeof startTarget>> | undefined
  let result: LiveCoverageResult
  let discoveryFailure: unknown
  try {
    target = await startTarget({ target: options.target, repoRoot: options.repoRoot,
      environment: options.environment, fixtures: setupFixtures, operatorCredentials: true,
      ...(options.onCleanup ? { onCleanup: options.onCleanup } : {}) })
    if (!target.operatorToken) throw new Error('The isolated target did not issue its Operator credential')
    const names = await listOperatorToolNames({ baseUrl: target.baseUrl, token: target.operatorToken,
      signal: AbortSignal.timeout(30_000) })
    result = checkMcpCoverage(names, options.scenarios)
  } catch (error) {
    discoveryFailure = error
    result = { status: 'unavailable', error: describeFailure(error) }
  }
  try { await target?.close() }
  catch (error) {
    const failure = result.status === 'unavailable'
      ? new AggregateError([discoveryFailure, error], 'Live MCP discovery and cleanup failed') : error
    return { status: 'unavailable', error: describeFailure(failure) }
  }
  return result
}
