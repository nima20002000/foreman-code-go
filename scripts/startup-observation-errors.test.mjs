import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withProductionSourceSnapshot } from './local-production-runtime.mjs'
import { publishWorkerArtifactsToGitHub } from './worker-release-artifacts.mjs'

async function fixture(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'startup-observation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('does not erase an existing source tree after a broken repository probe', async t => {
  const root = await fixture(t)
  const repository = join(root, 'repository')
  await mkdir(repository)
  const git = args => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git(['init', '--quiet'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
  git(['remote', 'add', 'origin', 'https://github.com/example/project.git'])
  const directory = join(root, 'build')
  const source = join(directory, 'source')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, '.git'), 'gitdir: missing-directory\n')
  await writeFile(join(source, 'retained'), 'retained')
  await assert.rejects(withProductionSourceSnapshot(repository, directory, async () => undefined))
  assert.equal(await readFile(join(source, 'retained'), 'utf8'), 'retained')
})

test('does not create a release or retry an authentication failure', async t => {
  const root = await fixture(t)
  const failure = Object.assign(new Error('HTTP 401: authentication required'), { code: 1 })
  const calls = []
  const waits = []
  const run = async (binary, args) => {
    calls.push([binary, ...args])
    if (args[1] === 'view') throw failure
  }
  await assert.rejects(publishWorkerArtifactsToGitHub({ directory: root, name: 'example/project',
    commit: 'a'.repeat(40), artifacts: [], run, sleep: async ms => waits.push(ms) }), error => error === failure)
  assert.equal(calls.length, 1)
  assert.deepEqual(waits, [])
})

test('fails with a named prerequisite error when tracked startup status is missing', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'corepack'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const result = spawnSync('bash', ['scripts/ci-suite.sh'], { encoding: 'utf8',
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CI_STATE: join(root, 'missing'),
      SUITE: 'unit', CI_HOST_RUNNER: '1', CI_WATCHDOG_ACTIVE: '1', FOREMAN_CODE_CI_TYPECHECK_CACHE: '' } })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /db.*(missing|unavailable)|prerequisite.*db/i)
})
