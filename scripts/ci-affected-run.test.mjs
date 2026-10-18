import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'

function delegatedSuite(t) {
  const fixture = goCiFixture(t)
  const bin = join(fixture.directory, 'bin')
  const fallback = join(bin, 'fallback')
  mkdirSync(fallback)
  copyFileSync(join(bin, 'corepack.cjs'), join(fallback, 'corepack.cjs'))
  writeFileSync(join(bin, 'corepack.cjs'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const args = process.argv.slice(2)
const nodeTests = args.slice(0, 3).join(' ') === 'pnpm exec node'
const command = nodeTests ? args.slice(3) : [join(__dirname, 'fallback/corepack.cjs'), ...args]
const result = spawnSync(process.execPath, command, { env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
`)
  const prepared = fixture.run('unit', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  return fixture
}

for (const files of [
  ['scripts/missing.test.mjs'],
  ['scripts/missing.test.mjs', 'apps/web/src/missing.test.tsx'],
]) {
  test(`affected unit selection reports missing files: ${files.join(', ')}`, t => {
    const fixture = delegatedSuite(t)
    const root = fixture.directory
    const selection = join(root, 'selected.json')
    writeFileSync(selection, JSON.stringify(files))

    const result = spawnSync(process.execPath, [join(fixture.directory, 'scripts/ci-affected-run.mjs'),
      'unit', '--files-from', selection], { cwd: root, env: fixture.environment, encoding: 'utf8' })

    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(`CI selection must contain existing repository files: ${files[0]}`),
      result.stderr)
    assert.doesNotMatch(result.stderr, /ENOENT/)
  })
}

for (const file of ['../outside.test.mjs', '/outside.test.mjs']) {
  test(`affected unit selection rejects a path outside its repository: ${file}`, t => {
    const fixture = delegatedSuite(t)
    const selection = join(fixture.directory, 'selected.json')
    writeFileSync(selection, JSON.stringify([file]))
    const result = spawnSync(process.execPath, [join(fixture.directory, 'scripts/ci-affected-run.mjs'),
      'unit', '--files-from', selection], { cwd: fixture.directory, env: fixture.environment, encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Invalid CI file:/)
    assert.equal(fixture.calls().some(call => call.tool === 'go' && call.args[0] === 'test'), false)
  })
}

for (const failing of [false, true]) {
  test(`affected Node tests retain reports and exit with the ${failing ? 'failing' : 'passing'} suite outcome`, t => {
    const fixture = delegatedSuite(t)
    const root = fixture.directory
    mkdirSync(join(root, 'reports'))
    const file = 'scripts/value.test.mjs'
    writeFileSync(join(root, 'scripts/unselected.test.mjs'), `import { test } from 'node:test'
test('unselected', () => { throw new Error('An unrelated file was executed') })
`)
    writeFileSync(join(root, file), `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('passes', () => assert.equal(1, 1))
test('second case', () => assert.equal(1, ${failing ? 2 : 1}))
`)
    const selection = join(root, 'selected.json')
    writeFileSync(selection, JSON.stringify([file]))
    const progress = join(root, 'reports', 'progress.jsonl')
    const environment = { ...fixture.environment,
      CI_PROGRESS_FILE: progress, CI_REPOSITORY_ROOT: root }
    // The child suite needs its own reporters rather than the parent test IPC channel.
    delete environment.NODE_TEST_CONTEXT
    delete environment.TEST_RESULTS_OUTPUT
    const result = spawnSync(process.execPath, [join(fixture.directory, 'scripts/ci-affected-run.mjs'),
      'unit', '--files-from', selection], { cwd: root, env: environment, encoding: 'utf8' })
    assert.equal(result.status, failing ? 1 : 0, result.stderr)
    assert.doesNotMatch(result.stderr, /EINVAL|Unhandled 'error' event/)
    assert.equal(fixture.calls().some(call => call.tool === 'go' && call.args[0] === 'test'), false)
    const results = JSON.parse(readFileSync(join(fixture.state, 'affected-retained.results.json'), 'utf8'))
    assert.deepEqual(results.summary, { passed: failing ? 1 : 2, failed: failing ? 1 : 0, skipped: 0 })
    assert.equal(results.files.length, 1)
    assert.equal(results.files[0].status, failing ? 'failed' : 'passed')
    assert.deepEqual(results.files[0].tests.map(({ name, status }) => [name, status]).sort(),
      [['passes', 'passed'], ['second case', failing ? 'failed' : 'passed']])
    if (failing) assert.match(results.files[0].tests.find(item => item.status === 'failed').message, /Expected values/)
    const events = readFileSync(progress, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(events.filter(event => event.type === 'finish' && event.kind === 'test' && event.file === file)
      .map(event => event.name).sort(), ['passes', 'second case'])
  })
}

test('affected Node tests publish structured results when results are requested', t => {
  const fixture = delegatedSuite(t)
  const root = fixture.directory
  const file = 'scripts/value.test.mjs'
  writeFileSync(join(root, file), `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('passes', () => assert.equal(1, 1))
`)
  const selection = join(root, 'selected.json')
  writeFileSync(selection, JSON.stringify([file]))
  const output = join(root, 'test-results.json')
  const environment = { ...fixture.environment, TEST_RESULTS_OUTPUT: output }
  delete environment.NODE_TEST_CONTEXT
  delete environment.CI_PROGRESS_FILE
  const result = spawnSync(process.execPath, [join(fixture.directory, 'scripts/ci-affected-run.mjs'),
    'unit', '--files-from', selection], { cwd: root, env: environment, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const results = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual(results.summary, { passed: 1, failed: 0, skipped: 0 })
  const nodeResult = results.files.find(result => result.file === file)
  assert.ok(nodeResult, JSON.stringify(results.files))
  assert.equal(nodeResult.status, 'passed')
  assert.deepEqual(nodeResult.tests.map(({ name, status }) => [name, status]), [['passes', 'passed']])
  assert.deepEqual(results.files.map(result => result.file), [file])
  const durations = JSON.parse(readFileSync(fixture.environment.DURATIONS_OUTPUT, 'utf8'))
  assert.ok(durations[file] > 0)
})

test('an explicitly selected file with zero tests fails', t => {
  const fixture = delegatedSuite(t)
  const file = 'scripts/empty.test.mjs'
  writeFileSync(join(fixture.directory, file), '// No registered tests.\n')
  const selection = join(fixture.directory, 'selected.json')
  writeFileSync(selection, JSON.stringify([file]))
  const environment = { ...fixture.environment }
  delete environment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [join(fixture.directory, 'scripts/ci-affected-run.mjs'),
    'unit', '--files-from', selection], { cwd: fixture.directory, env: environment, encoding: 'utf8' })
  assert.equal(result.status, 1, JSON.stringify({ stderr: result.stderr, stdout: result.stdout,
    results: fixture.results() }))
  assert.match(result.stderr, /executed zero tests/)
})
