import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformanceFixture, conformanceScenario } from './test-support/conformance-report-fixture.mjs'

// Candidate-entrypoint regressions use synthetic process/report fixtures, never native execution receipts.
const cli = fileURLToPath(new URL('./ci-conformance-gate.mjs', import.meta.url))
const health = conformanceScenario()
const inventory = [health, conformanceScenario({ id: 'fixture.other', title: 'Another fixture response', lane: 'E' })]

function gateProcess(t, scenarios, { overwriteSelection = false } = {}) {
  const fixture = conformanceFixture({ scenarios, inventoryScenarios: inventory,
    scope: { kind: 'full', lanes: [], scenarioIds: [health.id], completeSelection: false } })
  const directory = mkdtempSync(join(tmpdir(), 'affected-conformance-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const raw = join(directory, 'raw.json')
  const fullInventory = join(directory, 'inventory.json')
  const selection = join(directory, 'selected.json')
  const output = overwriteSelection ? selection : join(directory, 'gate.json')
  const rawText = `${JSON.stringify(fixture.report)}\n`
  const selectionText = JSON.stringify([health.id])
  writeFileSync(raw, rawText)
  writeFileSync(fullInventory, JSON.stringify(fixture.inventory))
  writeFileSync(selection, selectionText)
  const env = { ...process.env, HOME: directory, CI_STATE: join(directory, 'state'), CI_PROGRESS_FILE: '',
    TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '' }
  delete env.CONFORMANCE_GATE
  delete env.NODE_TEST_CONTEXT
  delete env.CI_NATIVE_REPORTS_DIR
  delete env.CI_NATIVE_SELECTOR
  const result = spawnSync(process.execPath, [cli, '--target', 'go', '--input', raw, '--inventory', fullInventory,
    '--output', output, '--commit', fixture.expected.commitSha, '--commit-source', fixture.expected.commitSource,
    '--launcher-exit', fixture.report.status === 'passed' ? '0' : '1', '--selection', selection], { env, encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(readFileSync(raw, 'utf8'), rawText)
  assert.equal(readFileSync(selection, 'utf8'), selectionText)
  return { result, gate: overwriteSelection ? undefined : JSON.parse(readFileSync(output, 'utf8')) }
}

test('the affected CLI publishes a selected verdict while preserving raw full scope and measured cases', t => {
  const { result, gate } = gateProcess(t, [health])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(gate.status, 'passed')
  assert.equal(gate.mode, 'affected')
  assert.equal(gate.fullConformance.status, 'failed')
  assert.equal(gate.fullConformance.scope.completeSelection, false)
  assert.deepEqual(gate.selection, { scenarioIds: [health.id], requested: 1, reported: 1, executed: 1,
    passedIds: [health.id], failedIds: [], missingIds: [], unexpectedIds: [] })
})

test('the affected CLI fails missing outcomes with zero actual cases and refuses to overwrite selection evidence', t => {
  const zero = gateProcess(t, [])
  assert.equal(zero.result.status, 1)
  assert.equal(zero.gate.selection.requested, 1)
  assert.equal(zero.gate.selection.reported, 0)
  assert.equal(zero.gate.selection.executed, 0)
  assert.deepEqual(zero.gate.selection.missingIds, [health.id])
  const collision = gateProcess(t, [health], { overwriteSelection: true })
  assert.equal(collision.result.status, 1)
  assert.match(collision.result.stderr, /output must be separate/)
})
