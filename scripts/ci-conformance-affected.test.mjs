import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conformanceGate } from './ci-conformance-gate.mjs'
import { conformanceFixture, conformanceScenario } from './test-support/conformance-report-fixture.mjs'

// Synthetic public reports test CI policy only; these are never conformance execution receipts.
const health = conformanceScenario()
const engine = conformanceScenario({ id: 'fixture.engine', title: 'Engine result', lane: 'E' })
const error = { name: 'FixtureFailure', message: 'The selected behavior did not complete.' }
function selectedFixture(scenarios = [health], options = {}) {
  return conformanceFixture({ scenarios, inventoryScenarios: [health, engine],
    scope: { kind: 'full', lanes: [], scenarioIds: [health.id], completeSelection: false }, ...options })
}
function evaluate(fixture, options = {}) {
  return conformanceGate(fixture.report, fixture.expected, {
    selectionIds: [health.id], launcherExit: fixture.report.status === 'passed' ? 0 : 1, ...options,
  })
}

test('an exact affected conformance selection passes without changing the full verdict or lane totals', () => {
  const fixture = selectedFixture()
  const original = structuredClone(fixture.report)
  const gate = evaluate(fixture)
  assert.equal(gate.status, 'passed')
  assert.equal(gate.mode, 'affected')
  assert.equal(gate.fullConformance.status, 'failed')
  assert.deepEqual(gate.fullConformance.lanes, original.lanes)
  assert.deepEqual(gate.fullConformance.scope, original.scope)
  assert.deepEqual(gate.selection.passedIds, [health.id])
  assert.equal(gate.nonRegression.status, 'not-established')
  assert.equal(gate.skeleton.status, 'not-established')
  assert.deepEqual(fixture.report, original)
})

test('a selected non-skeleton scenario requires its own real passed outcome', () => {
  const fixture = selectedFixture([engine], {
    scope: { kind: 'full', lanes: [], scenarioIds: [engine.id], completeSelection: false },
  })
  assert.equal(evaluate(fixture, { selectionIds: [engine.id] }).status, 'passed')
  const failed = selectedFixture([{ ...engine, status: 'failed', error }], {
    scope: { kind: 'full', lanes: [], scenarioIds: [engine.id], completeSelection: false },
  })
  assert.equal(evaluate(failed, { selectionIds: [engine.id] }).status, 'failed')
})

test('empty, duplicate and unknown selected scenario IDs cannot be accepted', () => {
  for (const selectionIds of [[], [health.id, health.id], ['fixture.unknown'], undefined]) {
    assert.throws(() => evaluate(selectedFixture(), { mode: 'affected', selectionIds }), /scenario IDs/)
  }
})

test('a selected scenario missing its outcome stays red without inventing an executed case', () => {
  const fixture = selectedFixture([], {})
  const gate = evaluate(fixture)
  assert.equal(gate.status, 'failed')
  assert.equal(gate.selection.executed, 0)
  assert.deepEqual(gate.selection.missingIds, [health.id])
  assert.deepEqual(gate.fullConformance.totals, { total: 0, passed: 0, failed: 0, skipped: 0 })
})

test('a broader raw selection cannot substitute for the exact requested conformance IDs', () => {
  const fixture = selectedFixture([health, engine], {
    scope: { kind: 'full', lanes: [], scenarioIds: [health.id, engine.id], completeSelection: false },
  })
  const gate = evaluate(fixture)
  assert.equal(gate.status, 'failed')
  assert.deepEqual(gate.selection.unexpectedIds, [engine.id])
})

test('scenario setup, scenario assertion, runner setup and cleanup failures stay red', () => {
  for (const fixture of [
    selectedFixture([{ ...health, status: 'failed', phase: 'setup', executed: false, error }]),
    selectedFixture([{ ...health, status: 'failed', error }]),
    selectedFixture([health], { setupError: error }),
    selectedFixture([health], { cleanupError: error }),
  ]) assert.equal(evaluate(fixture).status, 'failed')
})

test('launcher crashes and contradictory exits cannot become affected conformance success', () => {
  for (const launcherExit of [1, 2, 137, undefined]) {
    assert.equal(evaluate(selectedFixture(), { launcherExit }).status, 'failed')
  }
})

test('affected policy does not reinterpret smoke, lane-only or complete selections', () => {
  for (const scope of [
    { kind: 'smoke', lanes: [], scenarioIds: [health.id], completeSelection: false },
    { kind: 'full', lanes: ['SKEL'], scenarioIds: [health.id], completeSelection: false },
    { kind: 'full', lanes: [], scenarioIds: [], completeSelection: true },
  ]) {
    const fixture = selectedFixture([health], { scope, inventoryScenarios: [health] })
    assert.equal(evaluate(fixture).status, 'failed')
  }
  assert.throws(() => evaluate(selectedFixture(), { mainReport: conformanceFixture().report,
    mainCommitSha: '1'.repeat(40) }), /full exact-main/)
})

test('existing full incremental and complete policies retain their original selection requirements', () => {
  const fixture = selectedFixture()
  assert.equal(conformanceGate(fixture.report, fixture.expected, { launcherExit: 0 }).status, 'failed')
  assert.throws(() => evaluate(fixture, { mode: 'complete' }), /affected conformance policy/)
})
