import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'

function selectedGo(t, { tests = false, ...overrides } = {}) {
  const f = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', SELECTED_FILES: '', ...overrides })
  mkdirSync(join(f.directory, 'backend/runtime'))
  const file = tests ? 'backend/runtime/state_test.go' : 'backend/runtime/state.go'
  writeFileSync(join(f.directory, file), 'package runtime\n')
  const selection = join(f.directory, 'selection.json')
  writeFileSync(selection, JSON.stringify({ files: [file], ...tests ? { goTestRoots: { './runtime': ['TestRuntimeState'] } } : {} }))
  f.environment.CI_AFFECTED_SELECTION_FILE = selection
  return { ...f, file, selection }
}

test('affected typecheck and lint use exact Go packages and files without contracts setup', t => {
  for (const suite of ['typecheck-api', 'lint-api', 'build-api']) {
    const f = selectedGo(t)
    const result = f.run(suite)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const commands = f.calls().filter(call => call.tool === 'go' && ['build', 'vet'].includes(call.args[0]))
    if (suite === 'typecheck-api') assert.deepEqual(commands.map(call => call.args), [['build', './runtime'], ['vet', './runtime']])
    if (suite === 'build-api') assert.deepEqual(commands.map(call => call.args), [['build', './runtime']])
    if (suite === 'lint-api') {
      assert.deepEqual(f.calls().filter(call => call.tool === 'gofmt').map(call => call.args), [['-l', f.file]])
      assert.deepEqual(f.calls().filter(call => call.tool === 'staticcheck' && call.args[0] !== '-version')
        .map(call => call.args), [['./runtime'], ['-tags', 'integration', './runtime']])
    }
    assert.equal(f.calls().some(call => call.tool === 'corepack' || call.args.includes('./...')), false)
    assert.equal(existsSync(join(f.directory, 'packages/contracts/dist')), false)
    assert.equal(f.isolatedHomeExists(), false)
  }
})

for (const mode of ['normal', 'failed', 'zero']) {
  test(`bounded Go ${mode} fixture preserves native and guard outcomes separately`, t => {
    const f = selectedGo(t, { tests: true, GO_TEST_MODE: mode })
    const result = f.run('unit-api')
    assert.equal(result.status, mode === 'normal' ? 0 : mode === 'failed' ? 7 : 1, result.stdout + result.stderr)
    const calls = f.calls().filter(call => call.tool === 'go' && call.args[0] === 'test')
    assert.deepEqual(calls.map(call => call.args), [['test', '-json', '-count=1', '-run', '^(TestRuntimeState)$', './runtime']])
    const status = JSON.parse(readFileSync(join(f.state, 'go/unit.action-status.json'), 'utf8'))
    assert.equal(status.nativeExit, mode === 'failed' ? 7 : 0)
    assert.equal(status.converterExit, mode === 'normal' ? 0 : 1)
    assert.equal(status.captureExit, 0)
    const commands = readFileSync(join(f.state, 'go/unit.commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(commands, [{ package: './runtime', filter: '^(TestRuntimeState)$', exit: status.nativeExit }])
    assert.equal(readFileSync(join(f.state, 'go/unit.stderr.log'), 'utf8'), `synthetic Go stderr: ${mode}\n`)
    assert.ok(readFileSync(join(f.state, 'go/unit.jsonl'), 'utf8').includes('example.test/backend/runtime'))
    assert.deepEqual(f.results().summary, mode === 'normal' ? { passed: 1, failed: 0, skipped: 0 }
      : mode === 'failed' ? { passed: 0, failed: 1, skipped: 0 } : { passed: 0, failed: 0, skipped: 0 })
    assert.equal(f.isolatedHomeExists(), false)
  })
}

test('an unknown or empty invoked scope fails before any product command', t => {
  for (const files of [undefined, []]) {
    const f = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', SELECTED_FILES: '' })
    if (files) {
      const selection = join(f.directory, 'empty.json')
      writeFileSync(selection, JSON.stringify(files))
      f.environment.CI_AFFECTED_SELECTION_FILE = selection
    }
    const result = f.run('typecheck-api')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unresolved|zero files/)
    assert.deepEqual(f.calls(), [])
  }
  const f = goCiFixture(t, { SCOPE: 'full', FOREMAN_CODE_CI_RELEASE: '' })
  assert.equal(f.run('typecheck-api').status, 2)
  assert.deepEqual(f.calls(), [])
})

test('scope resolution follows the copied suite module when invoked from the contracts directory', t => {
  const f = selectedGo(t)
  const result = spawnSync('bash', [join(f.directory, 'scripts/ci-suite.sh')], {
    cwd: join(f.directory, 'packages/contracts'), env: { ...f.environment, SUITE: 'typecheck-api' }, encoding: 'utf8',
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(f.calls().filter(call => call.tool === 'go' && ['build', 'vet'].includes(call.args[0]))
    .map(call => call.cwd), [join(f.directory, 'backend'), join(f.directory, 'backend')])
})

test('known host integration setup defers without a check claim and later unbound files remain red', t => {
  const f = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', SELECTED_FILES: '', TEST_RESULTS_OUTPUT: '',
    FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: 'host-results.json' })
  const prepared = f.run('integration', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  assert.match(prepared.stdout, /setup deferred/)
  assert.deepEqual(f.calls(), [])
  assert.equal(existsSync(join(f.state, 'runtime-root')), false)
  mkdirSync(join(f.directory, 'apps/api/test'), { recursive: true })
  writeFileSync(join(f.directory, 'apps/api/test/unbound.integration.test.ts'), 'export {}')
  const result = spawnSync(process.execPath, [join(f.directory, 'scripts/ci-root-suite.mjs'), 'integration', '--',
    'node', 'scripts/test-integration.mjs', '--files', 'apps/api/test/unbound.integration.test.ts'],
  { cwd: f.directory, env: f.environment, encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Unsupported affected file/)
  assert.deepEqual(f.calls(), [])
})
