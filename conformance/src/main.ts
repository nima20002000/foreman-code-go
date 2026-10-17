import { fileURLToPath } from 'node:url'
import { checkBehaviorCoverage, checkHttpCoverage } from './coverage/checks.js'
import { checkLiveMcpCoverage, type LiveCoverageResult } from './coverage/live.js'
import { httpRoutes, runtimeHttpRoutes } from './coverage/http-routes.js'
import { setupFixtures } from './harnesses/setup.js'
import { parseOptions } from './options.js'
import { allScenarios, smokeScenarios } from './registry.js'
import { createReport, describeFailure, writeReport } from './reporting/report.js'
import { readRunIdentity } from './reporting/revision.js'
import { runScenarios } from './runner.js'
import { startTarget } from './runtime/target.js'

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const options = parseOptions(process.argv.slice(2), repoRoot, process.env)
  const candidates = options.smoke ? smokeScenarios : allScenarios
  const scenarios = candidates.filter(scenario =>
    (options.lanes.length === 0 || options.lanes.includes(scenario.lane))
    && (options.scenarioIds.length === 0 || options.scenarioIds.includes(scenario.id)))
  if (options.list) {
    process.stdout.write(`${JSON.stringify({ kind: 'conformance-inventory', target: options.target,
      scope: options.smoke ? 'smoke' : 'full', scenarios: scenarios.map(({ id, title, lane, covers }) => ({ id, title, lane, covers })) })}\n`)
    return
  }
  const identity = await readRunIdentity(repoRoot)
  const startedAt = new Date()
  const outcomes = await runScenarios(scenarios, {
    launch: scenario => startTarget({ target: options.target, repoRoot, fixtures: setupFixtures,
      operatorCredentials: scenario.authentication === 'operator' }),
    onOutcome: outcome => { process.stdout.write(`${JSON.stringify({ kind: 'conformance-scenario', ...outcome })}\n`) },
  })
  const http = checkHttpCoverage([...httpRoutes, ...runtimeHttpRoutes], allScenarios)
  const behaviors = checkBehaviorCoverage(allScenarios)
  let mcp: LiveCoverageResult = { status: 'not-run', reason: 'A smoke or filtered run cannot establish complete coverage.' }
  const completeSelection = !options.smoke && options.lanes.length === 0 && options.scenarioIds.length === 0
  if (completeSelection) {
    mcp = await checkLiveMcpCoverage({ target: options.target, repoRoot, environment: process.env, scenarios: allScenarios })
  }
  const report = createReport({ identity, target: options.target, startedAt, finishedAt: new Date(), scenarios: outcomes })
  const coverageComplete = http.status === 'passed' && behaviors.status === 'passed' && mcp.status === 'passed'
  if (completeSelection && !coverageComplete) report.status = 'failed'
  const result = { ...report,
    scope: { kind: options.smoke ? 'smoke' : 'full', lanes: options.lanes, scenarioIds: options.scenarioIds, completeSelection },
    coverage: { http, mcp, behaviors, complete: coverageComplete },
    executed: outcomes.filter(outcome => outcome.executed).length,
  }
  await writeReport(options.output, result)
  process.stdout.write(`${JSON.stringify({ kind: 'conformance-summary', ...result })}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ kind: 'conformance-startup-error', error: describeFailure(error) })}\n`)
  process.exitCode = 1
})
