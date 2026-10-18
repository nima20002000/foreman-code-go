import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
const repositoryFiles = ['backend/runtime/state.go', 'conformance/health.test.ts', 'scripts/value.test.mjs']

function selectionFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'affected-ci-input-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const path of ['home', 'state', 'bin', 'scripts', 'backend/runtime', 'conformance']) {
    mkdirSync(join(directory, path), { recursive: true })
  }
  for (const file of repositoryFiles) writeFileSync(join(directory, file), '// Temporary selected repository file.\n')
  for (const file of ['ci-affected-run.mjs', 'ci-affected-scope.mjs', 'ci-affected-contracts.mjs',
    'ci-files.mjs', 'ci-test-results.mjs', 'ci-report-io.mjs', 'ci-native-reports.mjs', 'ci-conformance-report.mjs']) {
    copyFileSync(new URL(file, import.meta.url), join(directory, 'scripts', file))
  }
  mkdirSync(join(directory, 'packages/contracts/src'), { recursive: true })
  copyFileSync(new URL('../packages/contracts/src/ciImportGraph.mjs', import.meta.url),
    join(directory, 'packages/contracts/src/ciImportGraph.mjs'))
  symlinkSync('value.test.mjs', join(directory, 'scripts/linked.test.mjs'))
  const dispatched = join(directory, 'dispatched.txt')
  writeFileSync(join(directory, 'scripts/ci-suite.sh'), `#!/bin/bash
printf '%s\\n' "$SUITE" "$SCOPE" "$CI" "\${SELECTED_FILES-unset}" "\${SLICE-unset}" \\
  "\${CI_PARTITION-unset}" "\${CI_SELECTION_COMMIT-unset}" > "$FIXTURE_DISPATCH_OUTPUT"
exit "\${FIXTURE_EXIT:-0}"
`)
  writeFileSync(join(directory, 'bin/git'), `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'ls-files -z') throw new Error('Unexpected fixture git command')
process.stdout.write(JSON.parse(process.env.FIXTURE_REPOSITORY_FILES).join('\\0') + '\\0')
`, { mode: 0o755 })
  const env = { ...process.env, HOME: join(directory, 'home'), CI_STATE: join(directory, 'state'),
    XDG_CONFIG_HOME: join(directory, 'home/config'), XDG_CACHE_HOME: join(directory, 'home/cache'),
    XDG_STATE_HOME: join(directory, 'home/state'), PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    FIXTURE_REPOSITORY_FILES: JSON.stringify(repositoryFiles), FIXTURE_DISPATCH_OUTPUT: dispatched,
    SCOPE: 'affected', SELECTED_FILES: 's:0', SLICE: '1/9', CI_PARTITION: '{}',
    CI_SELECTION_COMMIT: 'inherited-selection', BASH_ENV: '', ENV: '', CI_PROGRESS_FILE: '',
    TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '', CI_AFFECTED_SELECTION_FILE: '', CI_NATIVE_REPORTS_DIR: '', CI_NATIVE_SELECTOR: '' }
  delete env.NODE_TEST_CONTEXT
  return {
    directory,
    dispatched,
    select(text) { writeFileSync(join(directory, 'selected.json'), text) },
    run(args, extra = {}) {
      const result = spawnSync(process.execPath, [join(directory, 'scripts/ci-affected-run.mjs'), 'unit', ...args], {
        cwd: directory, env: { ...env, ...extra }, encoding: 'utf8',
      })
      assert.ifError(result.error)
      return result
    },
  }
}

for (const [name, text, error] of [
  ['malformed JSON', '["scripts/value.test.mjs"', /SyntaxError/],
  ['blank JSON', ' \n', /SyntaxError/],
  ['an object payload', '{}', /bounded affected request/],
  ['a null payload', 'null', /bounded affected request/],
  ['a non-string entry', '["scripts/value.test.mjs",7]', /Invalid CI files/],
  ['multiple missing files', '["scripts/missing.test.mjs","backend/missing.go"]',
    /CI selection must contain existing repository files: scripts\/missing\.test\.mjs/],
  ['a directory', '["backend/runtime"]', /CI selection must contain existing repository files: backend\/runtime/],
  ['a symlink', '["scripts/linked.test.mjs"]', /CI selection must contain existing repository files: scripts\/linked\.test\.mjs/],
]) {
  test(`affected CLI rejects ${name} before launching selected checks`, t => {
    const fixture = selectionFixture(t)
    fixture.select(text)
    const result = fixture.run(['--files-from', 'selected.json'])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, error)
    assert.equal(existsSync(fixture.dispatched), false)
  })
}

for (const path of ['', '../outside.test.mjs', '/outside.test.mjs', 'C:\\outside.test.mjs',
  'scripts/../scripts/value.test.mjs', './scripts/value.test.mjs', 'scripts//value.test.mjs',
  'scripts\\value.test.mjs', 'scripts/value.test.mjs\0']) {
  test(`affected CLI rejects the invalid repository path ${JSON.stringify(path)} before launch`, t => {
    const fixture = selectionFixture(t)
    fixture.select(JSON.stringify([path]))
    const result = fixture.run(['--files-from', 'selected.json'])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Invalid CI files?/)
    assert.equal(existsSync(fixture.dispatched), false)
  })
}

for (const [args, error] of [
  [['--files-from'], /Pass a selection file after --files-from/],
  [['--files-from', 'missing.json'], /ENOENT/],
  [['--files-from', 'selected.json', 'unexpected'], /Unexpected arguments/],
  [['--unknown', 'selected.json'], /Pass --files-from or --indexes/],
  [['--indexes', 's:-1'], /Invalid integration file index/],
  [['--indexes', 's:99'], /Invalid integration file index/],
  [['--indexes', 'd:0.'], /Invalid integration file index/],
]) {
  test(`affected CLI validates selection arguments before launch: ${args.join(' ')}`, t => {
    const fixture = selectionFixture(t)
    fixture.select('[]')
    const result = fixture.run(args)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, error)
    assert.equal(existsSync(fixture.dispatched), false)
  })
}

for (const files of [[], ['scripts/value.test.mjs']]) {
  test(`a valid ${files.length}-file selection preserves its scope and failing exit`, t => {
    const fixture = selectionFixture(t)
    fixture.select(JSON.stringify(files))
    const result = fixture.run(['--files-from', 'selected.json'], { FIXTURE_EXIT: '7' })
    assert.equal(result.status, files.length ? 7 : 1, result.stderr)
    if (files.length) {
      assert.deepEqual(readFileSync(fixture.dispatched, 'utf8').trim().split('\n'),
        ['unit', 'affected', 'true', 'unset', 'unset', 'unset', 'unset'])
    } else {
      assert.equal(existsSync(fixture.dispatched), false)
      assert.match(result.stderr, /selected zero files/)
    }
  })
}

for (const spec of ['s:2', 'd:2']) {
  test(`a valid index selection preserves selected scope: ${spec}`, t => {
    const fixture = selectionFixture(t)
    const result = fixture.run(['--indexes', spec])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(fixture.dispatched, 'utf8').trim().split('\n'),
      ['unit', 'affected', 'true', 'unset', 'unset', 'unset', 'unset'])
  })
}
