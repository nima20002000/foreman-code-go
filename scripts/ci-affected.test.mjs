import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { affectedSnapshot, selectAffectedFiles } from './ci-affected.mjs'
import { selectByIndexes } from './ci-files.mjs'

const sources = new Map([
  ['packages/contracts/src/value.ts', 'export const value = 1'],
  ['apps/web/src/view.ts', "export { value } from '@foreman-code/contracts/value'"],
  ['apps/web/src/view.test.ts', "import './view.js'"],
  ['apps/web/src/unrelated.test.ts', 'export {}'],
  ['scripts/value.test.mjs', "import '../packages/contracts/src/value.js'"],
  ['backend/runtime/state.go', 'package runtime'],
  ['apps/api/src/frozen.ts', 'export {}'],
])
const exports = { './value': { import: './dist/value.js' } }

test('affected unit follows only reached retained imports and excludes frozen API checks', () => {
  const selected = selectAffectedFiles({ suite: 'unit', changedFiles: ['packages/contracts/src/value.ts'], sources, exports })
  assert.equal(selected.scope, 'affected')
  assert.deepEqual(selected.files, ['apps/web/src/view.test.ts', 'scripts/value.test.mjs'])
  const typed = selectAffectedFiles({ suite: 'typecheck', changedFiles: ['packages/contracts/src/value.ts'], sources, exports })
  assert.deepEqual(typed.files, ['apps/web/src/view.test.ts', 'apps/web/src/view.ts',
    'packages/contracts/src/value.ts', 'scripts/value.test.mjs'])
})

test('explicit changed script tests and Go static checks retain their exact roots', () => {
  assert.deepEqual(selectAffectedFiles({ suite: 'unit', changedFiles: ['scripts/value.test.mjs'], sources }).files,
    ['scripts/value.test.mjs'])
  for (const suite of ['typecheck', 'lint', 'build']) {
    assert.deepEqual(selectAffectedFiles({ suite, changedFiles: ['backend/runtime/state.go'], sources }).files,
      ['backend/runtime/state.go'])
  }
})

test('unresolved migration scope fails and never falls back to full', () => {
  for (const suite of ['unit', 'integration']) {
    assert.throws(() => selectAffectedFiles({ suite, changedFiles: ['backend/runtime/state.go'], sources }), /named test roots/)
  }
  for (const changedFiles of [['missing.ts'], ['apps/api/src/frozen.ts']]) {
    assert.throws(() => selectAffectedFiles({ suite: 'unit', changedFiles, sources }), /explicit|bounded/)
  }
  const unresolved = new Map(sources)
  unresolved.set('apps/web/src/view.ts', "import './missing.js'")
  assert.throws(() => selectAffectedFiles({ suite: 'unit', changedFiles: ['apps/web/src/view.ts'], sources: unresolved }), /unresolved/)
  unresolved.set('apps/web/src/view.css', '.view {}')
  unresolved.set('apps/web/src/data.json', '{}')
  for (const file of ['apps/web/src/view.css', 'apps/web/src/data.json']) {
    assert.throws(() => selectAffectedFiles({ suite: 'lint', changedFiles: [file], sources: unresolved }), /explicit affected consumers/)
  }
  assert.throws(() => selectAffectedFiles({ suite: 'unknown', changedFiles: [], sources }), /Unsupported/)
})

test('known documentation and unchanged snapshots select no checks without claiming a check ran', () => {
  for (const changedFiles of [[], ['README.md'], ['docs/design.md']]) {
    const result = selectAffectedFiles({ suite: 'unit', changedFiles, sources })
    assert.equal(result.scope, 'affected')
    assert.deepEqual(result.files, [])
  }
})

test('file indexes retain exact ordered files and reject out-of-range values', () => {
  assert.deepEqual(selectByIndexes(['a', 'b', 'c'], 's:0,2'), ['a', 'c'])
  assert.deepEqual(selectByIndexes(['a', 'b', 'c'], 'd:0.1'), ['a', 'b'])
  for (const invalid of ['-1', 's:3', 'd:A', 'd:1.', 'd:0.3']) {
    assert.throws(() => selectByIndexes(['a', 'b', 'c'], invalid), /Invalid/)
  }
})

test('snapshot scope reads committed sources and requires an available explicit comparison base', t => {
  const root = mkdtempSync(join(tmpdir(), 'affected-snapshot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts/value.test.mjs'), 'export {}')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)
  assert.throws(() => affectedSnapshot('HEAD', 'unit', root), /explicit affected base/)
  writeFileSync(join(root, 'scripts/value.test.mjs'), "import 'node:test'")
  git('add', '.'); git('commit', '-qm', 'selected test')
  const commit = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'scripts/value.test.mjs'), 'uncommitted invalid text')
  assert.deepEqual(affectedSnapshot(commit, 'unit', join(root, 'scripts'), 'missing', base).files, ['scripts/value.test.mjs'])
  assert.throws(() => affectedSnapshot(commit, 'unit', root, 'missing'), /No affected merge-base/)
  assert.throws(() => affectedSnapshot(commit, 'unit', root, 'missing', 'f'.repeat(40)), /unavailable|ancestor/)
  assert.throws(() => affectedSnapshot(commit, 'unit', root, 'missing', 'invalid'), /Invalid explicit affected base/)
})
