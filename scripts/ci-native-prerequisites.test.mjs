import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativePrerequisiteFixture, prerequisitePlan, prerequisiteScenario, prerequisiteSelector }
  from './test-support/native-prerequisite-fixture.mjs'

// These synthetic process/report cases prove prerequisite ordering only. Native six-scenario CI stays separate.
const installs = fixture => fixture.calls().filter(call => call.tool === 'postgres-tools' && call.args[0] === 'install')
const adapters = fixture => fixture.calls().filter(call => call.tool === 'adapter')
const launches = fixture => fixture.calls().filter(call => call.tool === 'corepack' && call.args.includes('run')
  && call.args[call.args.indexOf('run') + 1] === 'conformance' && !call.args.includes('--list'))

function assertClean(fixture) {
  const homes = fixture.calls().map(call => call.home).filter(home => /^\/tmp\/fci\.[A-Za-z0-9]{6}\/home$/.test(home))
  assert.ok(homes.length > 0)
  assert.equal(homes.some(home => existsSync(home)), false, 'Every observed owned runtime HOME must be cleaned.')
  assert.equal(readFileSync(join(fixture.home, 'existing-state'), 'utf8'), 'untouched')
  assert.equal(fixture.run('integration', 'cleanup').status, 0)
}

for (const phase of ['prepare', 'start', 'direct']) {
  test(`cold selected native prerequisites finish before the adapter starts through ${phase}`, t => {
    const fixture = nativePrerequisiteFixture(t)
    if (phase !== 'direct') {
      const prepared = fixture.run('integration', phase)
      assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr)
      assert.equal(adapters(fixture).length, 0)
      assert.equal(fixture.sessions().length, 0)
    }
    const result = fixture.run('integration')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(fixture.results().summary, { passed: 1, failed: 0, skipped: 0 })
    // Genuine old production completes the selected fixture before failing this public ordering assertion.
    assert.equal(adapters(fixture)[0].postgresReady, true, 'The adapter test must start with its selected PostgreSQL tools prepared.')
    assert.equal(installs(fixture).filter(call => call.cold).length, 1)
    const calls = fixture.calls()
    const cold = calls.findIndex(call => call.tool === 'postgres-tools' && call.args[0] === 'install' && call.cold)
    const started = calls.findIndex(call => call.tool === 'adapter')
    assert.ok(cold >= 0 && cold < started, 'Cold tool installation belongs before the started adapter test.')
    assert.equal(installs(fixture).length, 2)
    assert.equal(installs(fixture)[1].cold, false)
    assert.notEqual(installs(fixture)[0].home, installs(fixture)[1].home)
    assert.notEqual(installs(fixture)[0].state, installs(fixture)[1].state)
    assert.deepEqual(launches(fixture).map(call => call.args.slice(call.args.indexOf('conformance', call.args.indexOf('run')) + 1)),
      [['--target', 'ts', '--scenario', prerequisiteScenario.id]])
    assert.equal(fixture.calls().some(call => call.tool === 'go' || call.tool === 'gofmt' || call.tool === 'staticcheck'), false)
    assert.equal(fixture.calls().some(call => call.tool === 'docker' && call.args[0] === 'run'), false)
    const [session] = fixture.sessions()
    assert.equal(fixture.sessions().length, 1)
    assert.deepEqual(fixture.sessionJson(session, 'expected.json').requiredKinds, ['conformance-ts'])
    const input = fixture.sessionJson(session, 'native-input.json')
    assert.deepEqual(input.selection.request.files, [prerequisiteSelector])
    assert.deepEqual(input.selection.request.conformanceScenarios, [])
    const inner = fixture.sessionJson(session, 'suite-state/affected-selection.json')
    assert.deepEqual(inner.files, fixture.request.files)
    assert.deepEqual(inner.conformanceScenarios, [prerequisiteScenario.id])
    assert.equal(inner.conformanceTarget, 'ts')
    assertClean(fixture)
  })
}

for (const phase of ['prepare', 'start', 'direct']) {
  test(`selected PostgreSQL setup failure through ${phase} stays before adapter execution and releases its runtime`, t => {
    const fixture = nativePrerequisiteFixture(t, { FAIL_POSTGRES_COMMAND: 'install' })
    let result
    if (phase !== 'direct') result = fixture.run('integration', phase)
    if (phase !== 'prepare') result = fixture.run('integration')
    assert.notEqual(result.status, null)
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.equal(adapters(fixture).length, 0, 'A failed selected prerequisite must not start the adapter test.')
    assert.equal(launches(fixture).length, 0)
    assert.equal(fixture.sessions().length, 0)
    assert.equal(existsSync(fixture.environment.TEST_RESULTS_OUTPUT), false)
    assert.equal(installs(fixture).length, 1)
    assertClean(fixture)
  })
}

test('an unselected native binding does not prepare tools for an ordinary selected Node test', t => {
  const fixture = nativePrerequisiteFixture(t)
  const selected = 'scripts/ordinary.test.mjs'
  fixture.put(selected, "import { test } from 'node:test'\ntest('ordinary selected behavior', () => {})\n")
  writeFileSync(fixture.selection, JSON.stringify([selected]))
  const result = fixture.run('unit')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(installs(fixture).length, 0)
  assert.equal(adapters(fixture).length, 0)
  assert.equal(launches(fixture).length, 0)
  assert.deepEqual(fixture.results().summary, { passed: 1, failed: 0, skipped: 0 })
  assert.equal(fixture.isolatedHomeExists(), false)
})

test('an uncommitted native-report claim does not request PostgreSQL preparation or gain native results', t => {
  const fixture = nativePrerequisiteFixture(t)
  const selected = 'scripts/ordinary.test.mjs'
  fixture.put(selected, "import { test } from 'node:test'\ntest('ordinary selected behavior', () => {})\n")
  writeFileSync(fixture.selection, JSON.stringify({ files: [selected],
    nativeReports: { [selected]: { requiredKinds: ['conformance-ts'], optionalKinds: [] } } }))
  const result = fixture.run('unit')
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /Required native report is missing: conformance-ts/)
  assert.equal(installs(fixture).length, 0)
  assert.equal(launches(fixture).length, 0)
  const [session] = fixture.sessions()
  assert.deepEqual(fixture.sessionJson(session, 'metadata.json').nativeCounts,
    { reported: 0, executed: 0, passed: 0, failed: 0, skipped: 0 })
  assert.equal(fixture.isolatedHomeExists(), false)
})

for (const mode of ['failed', 'zero', 'missing']) {
  test(`prepared native adapter preserves the ${mode} selected synthetic conformance outcome`, t => {
    const fixture = nativePrerequisiteFixture(t, { CONFORMANCE_TS_MODE: mode })
    const result = fixture.run('integration')
    assert.notEqual(result.status, null)
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.equal(adapters(fixture).length, 1)
    assert.equal(adapters(fixture)[0].postgresReady, true)
    assert.equal(launches(fixture).length, 1)
    const [session] = fixture.sessions()
    const metadata = fixture.sessionJson(session, 'metadata.json')
    assert.equal(metadata.failed, true)
    assert.equal(metadata.nativeCounts.executed, mode === 'failed' ? 1 : 0)
    assert.equal(metadata.nativeCounts.passed, 0)
    assert.equal(metadata.nativeCounts.skipped, 0)
    assert.notEqual(fixture.sessionJson(session, 'wrapper-status.json').wrapperExit, 0)
    assertClean(fixture)
  })
}

test('a standalone cold TS selection prepares its own tools and executes only its requested scenario', t => {
  const fixture = nativePrerequisiteFixture(t)
  fixture.environment.CI_AFFECTED_SELECTION_FILE = join(fixture.directory, prerequisitePlan)
  const result = fixture.run('integration')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(adapters(fixture).length, 0)
  assert.equal(fixture.sessions().length, 0)
  assert.equal(installs(fixture).filter(call => call.cold).length, 1)
  assert.deepEqual(launches(fixture).map(call => call.target), ['ts'])
  assert.deepEqual(fixture.results().summary, { passed: 1, failed: 0, skipped: 0 })
  assertClean(fixture)
})
