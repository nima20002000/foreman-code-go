import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { executionFiles, executionSelection } from './ci-selection.mjs'

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-selection-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  const write = (file, text) => { mkdirSync(dirname(join(cwd, file)), { recursive: true }); writeFileSync(join(cwd, file), text) }
  const files = ['backend/runtime/state.go', 'backend/runtime/state_test.go', 'apps/api/test/frozen.test.ts',
    'apps/web/src/fast.test.tsx', 'apps/web/src/heavy.test.tsx', 'packages/contracts/src/value.test.ts', 'scripts/value.test.mjs']
  for (const file of files) write(file, file.endsWith('.go') ? 'package runtime' : 'export {}')
  write('apps/web/heavy-tests.json', JSON.stringify({ files: ['src/heavy.test.tsx'] }))
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)
  return { cwd, git, write, files, base }
}

test('existing API part names select Go while retained parts exclude the frozen API', t => {
  const f = repository(t)
  assert.deepEqual(executionFiles(f.files, 'typecheck-api', f.cwd), ['backend/runtime/state.go', 'backend/runtime/state_test.go'])
  assert.deepEqual(executionFiles(f.files, 'unit-web', f.cwd), ['apps/web/src/fast.test.tsx'])
  assert.deepEqual(executionFiles(f.files, 'unit-web-heavy', f.cwd), ['apps/web/src/heavy.test.tsx'])
  assert.deepEqual(executionFiles(f.files, 'unit-other', f.cwd), ['packages/contracts/src/value.test.ts', 'scripts/value.test.mjs'])
  assert.equal(executionFiles(f.files, 'unit', f.cwd).some(file => file.startsWith('apps/api/')), false)
  assert.throws(() => executionFiles(f.files, 'unit-unknown', f.cwd), /Unsupported/)
})

test('exact changed test partitions cover only affected retained files', t => {
  const f = repository(t)
  for (const file of ['apps/web/src/fast.test.tsx', 'apps/web/src/heavy.test.tsx']) f.write(file, "import 'node:test'")
  f.git('add', '.'); f.git('commit', '-qm', 'two affected tests')
  const slices = [0, 1].map(index => executionSelection({ commit: 'HEAD', baseCommit: f.base,
    executionSuite: 'unit', partition: { index, count: 2 }, cwd: f.cwd }))
  assert.ok(slices.every(slice => slice.scope === 'affected'))
  assert.deepEqual(slices.flatMap(slice => slice.files).sort(), ['apps/web/src/fast.test.tsx', 'apps/web/src/heavy.test.tsx'])
})

test('unavailable bases and implicit default-head scope fail without a full fallback', t => {
  const f = repository(t)
  assert.throws(() => executionSelection({ commit: 'HEAD', executionSuite: 'unit', cwd: f.cwd }), /explicit affected base/)
  assert.throws(() => executionSelection({ commit: 'HEAD', baseCommit: 'f'.repeat(40), executionSuite: 'unit', cwd: f.cwd }), /unavailable/)
  assert.deepEqual(executionSelection({ commit: 'HEAD', baseCommit: f.base, executionSuite: 'unit', cwd: f.cwd }).files, [])
  const release = executionSelection({ commit: 'HEAD', executionSuite: 'unit', cwd: f.cwd, release: true })
  assert.equal(release.scope, 'full')
  assert.deepEqual(release.files, [])
})
