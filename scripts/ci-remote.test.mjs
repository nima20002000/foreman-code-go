import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { snapshot } from './ci-remote.mjs'

const script = new URL('./ci-remote.mjs', import.meta.url).pathname

function repository() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-remote-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); writeFileSync(join(root, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'first')
  return { root, git }
}

test('snapshots uncommitted and untracked changes as a commit on HEAD without touching the index or branch', t => {
  const { root, git } = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const head = git('rev-parse', 'HEAD')
  assert.equal(snapshot(root), head)
  writeFileSync(join(root, 'a.txt'), 'two\n'); writeFileSync(join(root, 'new.txt'), 'new\n')
  const commit = snapshot(root)
  assert.notEqual(commit, head)
  assert.equal(git('rev-parse', `${commit}^`), head)
  assert.equal(git('show', `${commit}:a.txt`), 'two')
  assert.equal(git('show', `${commit}:new.txt`), 'new')
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('status', '--porcelain'), 'M a.txt\n?? new.txt')
})

test('runs the local command on a CI machine and keeps its exit code', () => {
  const run = spawnSync(process.execPath, [script, 'unit', '--', process.execPath, '-e', 'process.exit(3)'],
    { env: { ...process.env, CI: 'true' } })
  assert.equal(run.status, 3)
})

test('refuses to run tests on a developer machine when Main is unreachable, and says how to proceed', () => {
  const run = spawnSync(process.execPath, [script, 'unit', '--', process.execPath, '-e', 'process.exit(0)'],
    { env: { ...process.env, CI: '', FOREMAN_CODE_CI_LOCAL: '', FOREMAN_CODE_MAIN_URL: 'http://127.0.0.1:9',
      FOREMAN_CODE_OPERATOR_TOKEN: 'test-token' }, encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /FOREMAN_CODE_CI_LOCAL=1/)
})
