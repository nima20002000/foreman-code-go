import { listOperatorToolNames } from '../clients/mcp.js'
import { setupFixtures } from '../harnesses/setup.js'
import { describeFailure } from '../reporting/report.js'
import type { ScenarioFailure, Target } from '../reporting/types.js'
import { startTarget } from '../runtime/target.js'
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
}): Promise<LiveCoverageResult> {
  let target: Awaited<ReturnType<typeof startTarget>> | undefined
  let result: LiveCoverageResult
  try {
    target = await startTarget({ target: options.target, repoRoot: options.repoRoot,
      environment: options.environment, fixtures: setupFixtures, operatorCredentials: true })
    if (!target.operatorToken) throw new Error('The isolated target did not issue its Operator credential')
    const names = await listOperatorToolNames({ baseUrl: target.baseUrl, token: target.operatorToken,
      signal: AbortSignal.timeout(30_000) })
    result = checkMcpCoverage(names, options.scenarios)
  } catch (error) {
    result = { status: 'unavailable', error: describeFailure(error) }
  }
  try { await target?.close() }
  catch (error) { return { status: 'unavailable', error: describeFailure(error) } }
  return result
}
