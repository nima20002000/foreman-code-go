import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformanceGate } from './ci-conformance-gate.mjs'
import { conformanceFixture, conformanceScenario } from './test-support/conformance-report-fixture.mjs'

// These identities and outcomes are synthetic unit fixtures, never benchmark evidence.
const mainCommitSha = '1'.repeat(40)
const currentCommitSha = '2'.repeat(40)
const error = { name: 'FixtureFailure', message: 'The fixture target has not implemented this behavior.' }
const cli = fileURLToPath(new URL('./ci-conformance-gate.mjs', import.meta.url))

function coverageGap() {
  const surface = { status: 'passed', required: 1, covered: 1, missing: [], unexpected: [] }
  return { http: { ...surface, status: 'failed', covered: 0, missing: ['fixture HTTP behavior'] },
    mcp: { status: 'not-run', reason: 'Fixture discovery did not run.' }, behaviors: { ...surface }, complete: false }
}

function partialImplementation(options = {}) {
  return conformanceFixture({ commitSha: currentCommitSha, scenarios: [conformanceScenario(),
    conformanceScenario({ id: 'fixture.engine', title: 'Fixture engine behavior', lane: 'E',
      status: 'failed', phase: 'setup', executed: false, error })], coverage: coverageGap(), ...options })
}

function evaluate(fixture, options = {}) {
  return conformanceGate(fixture.report, fixture.expected,
    { launcherExit: fixture.report.status === 'passed' ? 0 : 1, ...options })
}

test('incremental CI preserves full failed outcomes and coverage while requiring real skeleton passes', () => {
  const fixture = partialImplementation()
  const original = structuredClone(fixture.report)
  const gate = evaluate(fixture)
  assert.equal(gate.status, 'passed')
  assert.equal(gate.fullConformance.status, 'failed')
  assert.equal(gate.fullConformance.reportedStatus, 'failed')
  assert.equal(gate.fullConformance.executed, 1)
  assert.deepEqual(gate.fullConformance.totals, { total: 2, passed: 1, failed: 1, skipped: 0 })
  assert.deepEqual(gate.fullConformance.lanes.E, { total: 1, passed: 0, failed: 1, skipped: 0 })
  assert.deepEqual(gate.fullConformance.coverage, original.coverage)
  assert.deepEqual(gate.skeleton.passedIds, ['fixture.health'])
  assert.equal(gate.nonRegression.status, 'not-available')
  assert.equal(Object.hasOwn(gate.nonRegression, 'compared'), false)
  assert.deepEqual(fixture.report, original)
})

test('complete acceptance fails on raw scenario failures or coverage gaps and passes a complete fixture', () => {
  const failed = evaluate(partialImplementation(), { mode: 'complete' })
  assert.equal(failed.status, 'failed')
  assert.match(failed.reasons.join('\n'), /outcomes failed/)
  assert.match(failed.reasons.join('\n'), /coverage is incomplete/)
  assert.equal(evaluate(conformanceFixture(), { mode: 'complete' }).status, 'passed')
})

test('an exact-main comparison uses only its actual executed passing IDs and retains its failed full status', () => {
  const baseline = partialImplementation({ commitSha: mainCommitSha, commitSource: 'environment' })
  const candidate = partialImplementation()
  const gate = evaluate(candidate, { mainReport: baseline.report, mainCommitSha })
  assert.equal(gate.status, 'passed')
  assert.equal(gate.nonRegression.status, 'passed')
  assert.equal(gate.nonRegression.mainReportedStatus, 'failed')
  assert.equal(gate.nonRegression.mainCommitSha, mainCommitSha)
  assert.equal(gate.nonRegression.mainCommitSource, 'environment')
  assert.deepEqual(gate.nonRegression.passingScenarioIds, ['fixture.health'])
  assert.equal(gate.nonRegression.compared, 1)
  assert.deepEqual(gate.nonRegression.regressions, [])
})

test('a previously passing non-skeleton scenario cannot fail or disappear behind the incremental verdict', () => {
  const engine = conformanceScenario({ id: 'fixture.engine', title: 'Fixture engine behavior', lane: 'E' })
  const baseline = conformanceFixture({ commitSha: mainCommitSha, scenarios: [conformanceScenario(), engine] })
  for (const candidate of [partialImplementation(), conformanceFixture({ commitSha: currentCommitSha })]) {
    const gate = evaluate(candidate, { mainReport: baseline.report, mainCommitSha })
    assert.equal(gate.status, 'failed')
    assert.equal(gate.nonRegression.status, 'failed')
    assert.equal(gate.nonRegression.compared, 2)
    assert.deepEqual(gate.nonRegression.regressions.map(outcome => outcome.id), ['fixture.engine'])
  }
})

test('a real main report with no passing IDs retains actual execution counts without claiming regression proof', () => {
  for (const executed of [true, false]) {
    const baseline = conformanceFixture({ commitSha: mainCommitSha, scenarios: [conformanceScenario({
      status: 'failed', phase: executed ? 'scenario' : 'setup', executed, error })] })
    const gate = evaluate(partialImplementation(), { mainReport: baseline.report, mainCommitSha })
    assert.equal(gate.status, 'passed')
    assert.equal(gate.nonRegression.status, 'not-established')
    assert.equal(gate.nonRegression.mainReportedStatus, 'failed')
    assert.equal(gate.nonRegression.mainExecuted, executed ? 1 : 0)
    assert.equal(gate.nonRegression.compared, 0)
    assert.deepEqual(gate.nonRegression.passingScenarioIds, [])
  }
})

test('exact-main evidence cannot substitute a different commit, target, or unfinished selection', () => {
  const candidate = conformanceFixture({ commitSha: currentCommitSha })
  const baseline = conformanceFixture({ commitSha: mainCommitSha })
  assert.throws(() => evaluate(candidate, { mainReport: baseline.report }), /supplied together/)
  assert.throws(() => evaluate(candidate, { mainCommitSha }), /supplied together/)
  assert.throws(() => evaluate(candidate, { mainReport: baseline.report, mainCommitSha: currentCommitSha }), /exact commit identity/)
  const wrongTarget = conformanceFixture({ target: 'ts', commitSha: mainCommitSha })
  assert.throws(() => evaluate(candidate, { mainReport: wrongTarget.report, mainCommitSha }), /exact commit identity/)
  const filtered = conformanceFixture({ commitSha: mainCommitSha,
    scope: { kind: 'full', lanes: ['SKEL'], scenarioIds: [], completeSelection: false } })
  assert.throws(() => evaluate(candidate, { mainReport: filtered.report, mainCommitSha }), /full-selection report/)
})

for (const [name, fixture] of [
  ['a smoke selection', conformanceFixture({ scope: { kind: 'smoke', lanes: [], scenarioIds: [], completeSelection: false } })],
  ['a filtered full selection', conformanceFixture({ scope: { kind: 'full', lanes: ['SKEL'], scenarioIds: [], completeSelection: false } })],
  ['zero selected scenarios', conformanceFixture({ scenarios: [] })],
  ['an unexecuted skeleton setup failure', conformanceFixture({ scenarios: [conformanceScenario({ status: 'failed', phase: 'setup', executed: false, error })] })],
  ['an executed skeleton failure', conformanceFixture({ scenarios: [conformanceScenario({ status: 'failed', error })] })],
  ['no skeleton scenarios', conformanceFixture({ scenarios: [conformanceScenario({ id: 'fixture.engine', lane: 'E' })] })],
  ['runner setup failure', conformanceFixture({ setupError: error })],
  ['runner cleanup failure', conformanceFixture({ cleanupError: error })],
]) {
  test(`incremental CI remains red for ${name}`, () => {
    assert.equal(evaluate(fixture).status, 'failed')
  })
}

test('a full-selection claim needs every terminal ID from the actual captured inventory', () => {
  const fixture = conformanceFixture({ inventoryScenarios: [conformanceScenario(),
    conformanceScenario({ id: 'fixture.readiness', title: 'Fixture readiness response' })] })
  assert.throws(() => evaluate(fixture), /missing terminal inventory IDs/)
  delete fixture.expected.inventory
  assert.throws(() => evaluate(fixture), /actual full conformance inventory/)
})

test('launcher crashes and contradictory exit codes cannot be treated as ordinary conformance gaps', () => {
  for (const launcherExit of [2, 137, undefined, 0]) {
    assert.equal(evaluate(partialImplementation(), { launcherExit }).status, 'failed')
  }
  assert.equal(evaluate(conformanceFixture(), { launcherExit: 1 }).status, 'failed')
  const unexplained = conformanceFixture()
  unexplained.report.status = 'failed'
  assert.match(evaluate(unexplained).reasons.join('\n'), /unexplained failure/)
})

test('TypeScript incremental comparison leaves full oracle certification separate and never accepts zero execution', () => {
  const fixture = partialImplementation({ target: 'ts' })
  const gate = evaluate(fixture)
  assert.equal(gate.status, 'passed')
  assert.equal(gate.fullConformance.status, 'failed')
  assert.equal(gate.skeleton.status, 'not-applicable')
  assert.equal(evaluate(fixture, { mode: 'complete' }).status, 'failed')
  assert.equal(evaluate(conformanceFixture({ target: 'ts', scenarios: [] })).status, 'failed')
})

function runCli(t, fixture, { mode = 'incremental', mainFixture, mainCommit = mainCommitSha,
  inventory = fixture.inventory, overwriteRaw = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'conformance-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'raw.json')
  const inventoryPath = join(directory, 'inventory.json')
  const output = overwriteRaw ? input : join(directory, 'gate.json')
  const raw = `${JSON.stringify(fixture.report)}\n`
  writeFileSync(input, raw)
  writeFileSync(inventoryPath, JSON.stringify(inventory))
  const args = [cli, '--target', fixture.expected.target, '--input', input, '--inventory', inventoryPath,
    '--output', output, '--commit', fixture.expected.commitSha, '--commit-source', fixture.expected.commitSource,
    '--launcher-exit', fixture.report.status === 'passed' ? '0' : '1']
  if (mainFixture) {
    const mainInput = join(directory, 'main.json')
    writeFileSync(mainInput, JSON.stringify(mainFixture.report))
    args.push('--main-input', mainInput, '--main-commit', mainCommit)
  }
  const env = { ...process.env, HOME: directory, CI_STATE: join(directory, 'state'), CONFORMANCE_GATE: mode,
    CI_PROGRESS_FILE: '', TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '' }
  delete env.NODE_TEST_CONTEXT
  const processResult = spawnSync(process.execPath, args, { encoding: 'utf8', env })
  assert.ifError(processResult.error)
  assert.equal(readFileSync(input, 'utf8'), raw)
  return { processResult, gate: JSON.parse(readFileSync(output, 'utf8')) }
}

test('the CLI publishes a separate early gate and names unavailable baseline evidence without rewriting raw failures', t => {
  const { processResult, gate } = runCli(t, partialImplementation())
  assert.equal(processResult.status, 0, processResult.stderr)
  assert.equal(gate.fullConformance.status, 'failed')
  assert.match(processResult.stdout, /incremental CI gate passed; full conformance failed; exact-main non-regression not-available/)
  assert.match(processResult.stdout, /1\/2 scenarios executed/)
})

test('the CLI publishes red evidence for a missing inventory outcome, rejected main identity, and invalid gate mode', t => {
  const fixture = partialImplementation()
  const inventory = structuredClone(fixture.inventory)
  inventory.scenarios.push({ id: 'fixture.extra', title: 'Fixture extra behavior', lane: 'SKEL' })
  const invalidInventory = runCli(t, fixture, { inventory })
  assert.equal(invalidInventory.processResult.status, 1)
  assert.equal(invalidInventory.gate.evidence, 'invalid')
  assert.match(invalidInventory.gate.reasons[0], /missing terminal inventory IDs/)
  const wrongMain = runCli(t, fixture, { mainFixture: conformanceFixture({ commitSha: mainCommitSha }), mainCommit: currentCommitSha })
  assert.equal(wrongMain.processResult.status, 1)
  assert.match(wrongMain.gate.reasons[0], /exact commit identity/)
  const invalidMode = runCli(t, fixture, { mode: 'skip' })
  assert.equal(invalidMode.processResult.status, 1)
  assert.match(invalidMode.gate.reasons[0], /incremental or complete/)
})

test('the CLI refuses to replace the raw report with a policy verdict', t => {
  const { processResult } = runCli(t, partialImplementation(), { overwriteRaw: true })
  assert.equal(processResult.status, 1)
  assert.match(processResult.stderr, /gate output must be separate/)
})
