import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

// Suite mapping and disposable prerequisites are exercised in ci-suite-go.test.mjs.
function runNodeBootstrap(t, failedAttempts, restoredNode = false) {
  const base = process.env.TMPDIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(join(base, 'ci-node-bootstrap-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  mkdirSync(home)
  mkdirSync(join(directory, '.logs'))
  if (restoredNode) {
    const bin = join(home, '.nvm/versions/node/v22.23.2/bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  }
  const callsFile = join(directory, 'calls')
  const shellEnvironment = join(directory, 'shell-environment')
  writeFileSync(callsFile, '')
  writeFileSync(shellEnvironment, '')
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
  const { parse } = require('yaml')
  const configuration = parse(readFileSync(new URL('../.circleci/config.yml', import.meta.url), 'utf8'))
  const command = configuration.jobs.ci.steps.find(step => step.run?.name === 'Node and pnpm').run.command
  const fixture = `
    attempts=0
    nvm() {
      printf '%s\\n' "nvm $*" >> "$CALLS_FILE"
      if [ "$1" = install ]; then
        attempts=$((attempts + 1))
        if [ "$attempts" -le "$FAILED_ATTEMPTS" ]; then
          echo "Version '$2' not found" >&2
          return 3
        fi
      elif [ "$1" = which ]; then
        printf '%s\\n' "$NODE_BINARY"
      fi
    }
    corepack() { printf '%s\\n' "corepack $*" >> "$CALLS_FILE"; }
    node() { printf '%s\\n' "node $*" >> "$CALLS_FILE"; }
    sleep() { printf '%s\\n' "sleep $*" >> "$CALLS_FILE"; }
    chmod() { :; }
    mkdir() { :; }
    export -f nvm corepack node sleep chmod mkdir
  `
  const result = spawnSync('bash', ['-ec', fixture + command], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, SUITE: 'install', CALLS_FILE: callsFile, FAILED_ATTEMPTS: String(failedAttempts),
      NODE_BINARY: process.execPath, BASH_ENV: shellEnvironment, HOME: home },
  })
  assert.equal(result.error, undefined, result.error?.message)
  return { result, calls: readFileSync(callsFile, 'utf8').trim().split('\n'),
    shellEnvironment: readFileSync(shellEnvironment, 'utf8') }
}

test('cloud Node bootstrap recovers from a transient version lookup failure using the same pinned version', t => {
  const { result, calls, shellEnvironment } = runNodeBootstrap(t, 1)
  assert.equal(result.status, 0, result.stderr)
  const installs = calls.filter(call => call.startsWith('nvm install '))
  assert.deepEqual(installs, ['nvm install 22.23.2', 'nvm install 22.23.2'])
  assert.ok(calls.includes('nvm which 22.23.2'))
  assert.ok(calls.includes('corepack enable'))
  assert.ok(calls.includes('node --version'))
  assert.ok(shellEnvironment.includes(process.execPath.slice(0, process.execPath.lastIndexOf('/'))))
})

test('cloud Node bootstrap stops after three failed installs before enabling the package manager', t => {
  const { result, calls, shellEnvironment } = runNodeBootstrap(t, 10)
  assert.equal(result.status, 3)
  assert.equal(calls.filter(call => call === 'nvm install 22.23.2').length, 3)
  assert.equal(calls.some(call => call.startsWith('corepack ')), false)
  assert.equal(shellEnvironment, '')
  assert.match(result.stderr, /Version '22\.23\.2' not found/)
})

for (const provider of ['github', 'circleci', 'circleci-ssh']) {
  test(`${provider} checkout retains only the tested commit and its comparison base`, t => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-checkout-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const origin = join(directory, 'origin')
    const checkout = join(directory, 'checkout')
    mkdirSync(origin)
    mkdirSync(checkout)
    const environment = { ...process.env, BASH_ENV: '', GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_EMAIL: 'fixture@example.org' }
    const git = (cwd, ...args) => {
      const result = spawnSync('git', args, { cwd, env: environment, encoding: 'utf8' })
      assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    git(origin, 'init', '-q', '-b', 'main')
    git(origin, 'commit', '--allow-empty', '-qm', 'old history')
    const stale = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'branch', 'ci/stale', stale)
    git(origin, 'commit', '--allow-empty', '-qm', 'comparison base')
    const base = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'commit', '--allow-empty', '-qm', 'tested commit')
    const commit = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'branch', 'ci/tested', commit)
    git(origin, 'commit', '--allow-empty', '-qm', 'default branch advances')
    const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
    const { parse } = require('yaml')
    if (provider === 'github') {
      const configuration = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
      const action = configuration.jobs.ci.steps.find(step => step.uses?.startsWith('actions/checkout@'))
      // Execute the documented checkout action ref/depth contract against the fixture remote.
      const inputs = { ref: commit, base_commit: base }
      const refInput = action.with.ref
      const selectedRef = refInput.startsWith('${{')
        ? Function('inputs', `return (${refInput.slice(3, -2)})`)(inputs) : refInput
      const depthInput = action.with['fetch-depth']
      const depth = typeof depthInput === 'number' ? depthInput
        : Function('inputs', `return (${depthInput.slice(3, -2)})`)(inputs)
      git(checkout, 'init', '-q')
      git(checkout, 'remote', 'add', 'origin', `file://${origin}`)
      if (depth === 0) git(checkout, 'fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*')
      else git(checkout, 'fetch', '--no-tags', `--depth=${depth}`, 'origin', selectedRef)
      git(checkout, 'checkout', '--detach', 'FETCH_HEAD')
    } else {
      const configuration = parse(readFileSync(new URL('../.circleci/config.yml', import.meta.url), 'utf8'))
      const step = configuration.jobs.ci.steps[0]
      if (step === 'checkout') {
        git(directory, 'clone', '-q', `file://${origin}`, checkout)
        git(checkout, 'checkout', '--detach', commit)
      } else {
        let repositoryUrl = `file://${origin}`
        const bin = join(directory, 'bin')
        mkdirSync(bin)
        if (provider === 'circleci-ssh') {
          repositoryUrl = 'git@github.com:octo/site-ci.git'
          writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('git@github.com:octo/site-ci.git')) process.exit(42)
const mapped = args.map(value => value === 'https://github.com/octo/site-ci.git' ? process.env.FIXTURE_ORIGIN : value)
const result = spawnSync(process.env.FIXTURE_GIT, mapped, { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`, { mode: 0o755 })
        }
        const gitExecutable = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', env: environment }).stdout.trim()
        const result = spawnSync('bash', ['-ec', step.run.command], { cwd: checkout, encoding: 'utf8',
          env: { ...environment, PATH: `${bin}${delimiter}${process.env.PATH}`, FIXTURE_GIT: gitExecutable,
            FIXTURE_ORIGIN: `file://${origin}`, CIRCLE_REPOSITORY_URL: repositoryUrl,
            CIRCLE_SHA1: commit, BASE_COMMIT: base } })
        assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.status, 0, result.stderr)
      }
    }
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), commit)
    assert.equal(git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/remotes/'), '')
    assert.equal(git(checkout, 'rev-list', '--count', 'HEAD'), '2')
    assert.equal(git(checkout, 'merge-base', base, 'HEAD'), base)
    const absent = spawnSync('git', ['cat-file', '-e', stale], { cwd: checkout })
    assert.equal(absent.error, undefined, absent.error?.message)
    assert.equal(absent.status, 1)
  })
}

test('cloud Node bootstrap uses the cached toolchain without invoking nvm', t => {
  const { result, calls, shellEnvironment } = runNodeBootstrap(t, 10, true)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(calls.some(call => call.startsWith('nvm ')), false)
  assert.ok(calls.includes('corepack enable'))
  assert.ok(calls.includes('node --version'))
  assert.match(shellEnvironment, /\.nvm\/versions\/node\/v22\.23\.2\/bin/)
})
