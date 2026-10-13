import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function computer({ prepareDatabase = false } = {}) {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
    ?? join(homedir(), '.cache/foreman-code/tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'warm-host-'))
  roots.push(root)
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  const offlineFailure = join(root, 'offline-failure')
  await mkdir(origin)
  await mkdir(bin)
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
  await writeFile(join(origin, 'pnpm-lock.yaml'), 'fixture-lock-one')
  if (prepareDatabase) {
    await mkdir(join(origin, 'scripts'))
    await writeFile(join(origin, 'scripts/ci-suite.sh'),
      '#!/bin/bash\ncorepack pnpm db:up\n')
  }
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  await writeFile(join(bin, 'corepack'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
if (args[1] === 'db:up') {
  if (!fs.existsSync('node_modules/dependency')) {
    console.error('Database preparation attempted to reinstall unfinished dependencies')
    process.exit(8)
  }
} else if (args[1] === 'install') {
  if (${prepareDatabase}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  if (args.includes('--offline') && fs.existsSync(${JSON.stringify(offlineFailure)})) process.exit(7)
  const storeIndex = args.indexOf('--store-dir')
  const store = storeIndex < 0 ? '.fixture-store' : args[storeIndex + 1]
  const metadataIndex = args.indexOf('--cache-dir')
  const metadata = path.join(metadataIndex < 0 ? '.fixture-metadata' : args[metadataIndex + 1], 'release-age')
  const seed = path.join(store, require('node:crypto').createHash('sha256').update(fs.readFileSync('pnpm-lock.yaml')).digest('hex'))
  if (args.includes('--offline') && (!fs.existsSync(seed) || !fs.existsSync(metadata))) process.exit(7)
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(seed, 'pristine')
  fs.mkdirSync(path.dirname(metadata), { recursive: true })
  fs.writeFileSync(metadata, 'verified package publication time')
  fs.mkdirSync('node_modules', { recursive: true })
  if (!fs.existsSync('node_modules/dependency')) fs.copyFileSync(seed, 'node_modules/dependency')
} else {
  console.log('dependency=' + fs.readFileSync('node_modules/dependency', 'utf8'))
  fs.writeFileSync('node_modules/dependency', 'modified by suite')
}
`, { mode: 0o755 })
  const system = systemHostCiPorts()
  const launched = new Map<string, { cwd: string; done: Promise<unknown> }>()
  const ports: HostCiPorts = { ...system, cpus: 16, memoryBytes: 16 * 2 ** 30,
    availableMemoryBytes: () => 16 * 2 ** 30,
    run: async (file, args, options) => {
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
      if (file === 'git' && args.some(value => value.startsWith('https://github.com/'))) {
        return system.run(file, args.map(arg => arg.startsWith('https://') ? origin : arg), options)
      }
      if (file === 'systemd-run') {
        const cwd = args.find(arg => arg.startsWith('--working-directory='))!.slice('--working-directory='.length)
        const env = Object.fromEntries(args.filter(arg => arg.startsWith('--setenv='))
          .map(arg => arg.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
        launched.set(args.at(-1)!, { cwd, done: system.run('/bin/bash', [args.at(-1)!], { cwd, env }) })
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl') return { code: 0, stdout: 'active', stderr: '' }
      return system.run(file, args, options)
    } }
  const runner = new HostCiRunner(join(root, 'runner'), ports, { ...environment, PATH: `${bin}:${process.env.PATH}` })
  async function run() {
    const runId = randomUUID()
    await runner.handle({ operation: 'start', runId, repository: 'example/project', commit: git('rev-parse', 'HEAD'),
      suite: 'lint', scope: 'affected', files: [] })
    await vi.waitFor(async () => {
      const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
      if (reply.operation !== 'read' || reply.run.state === 'starting') throw new Error('Run is starting')
    })
    const script = join(root, 'runner/runs', runId, 'run.sh')
    await launched.get(script)?.done
    return runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
  }
  const commands = async () => (await readFile(calls, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as string[])
  const failOffline = () => writeFile(offlineFailure, 'store unavailable')
  const slot = join(root, 'runner/slots/example/project/0/src')
  // A new slot starts without dependencies and installs them from the shared store.
  const removeDependencies = () => rm(join(slot, 'node_modules'), { recursive: true, force: true })
  // A checkout whose git link is broken cannot be reset to another commit.
  const breakCheckout = () => writeFile(join(slot, '.git'), 'gitdir: missing\n')
  return { run, commands, origin, git, failOffline, removeDependencies, breakCheckout, checkout: (...args: string[]) => execFileSync('git', args, {
    cwd: join(root, 'runner/git/example/project'), env: environment, encoding: 'utf8',
  }).trim() }
}

it('warms once, installs offline on later jobs, and keeps the store private from suite mutations', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=pristine') })
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await fixture.removeDependencies()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=pristine') })
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(installs.filter(args => !args.includes('--offline'))).toHaveLength(1)
  expect(installs.at(-1)).toEqual(expect.arrayContaining(['--offline', '--frozen-lockfile']))
})

it('allows one online fill for a changed lockfile and then returns to offline installation', async () => {
  const fixture = await computer()
  await fixture.run()
  await writeFile(join(fixture.origin, 'pnpm-lock.yaml'), 'fixture-lock-two')
  fixture.git('add', '.')
  fixture.git('commit', '-qm', 'dependency update')
  await fixture.run()
  await fixture.run()
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(installs.filter(args => !args.includes('--offline'))).toHaveLength(2)
  expect(installs.at(-1)).toEqual(expect.arrayContaining(['--offline', '--frozen-lockfile']))
})

it('retains release-age metadata for offline installs after slot dependencies are removed', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await fixture.removeDependencies()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(installs.filter(args => !args.includes('--offline'))).toHaveLength(1)
})

it('installs concurrent jobs offline from one warmed repository and store', async () => {
  const fixture = await computer()
  await fixture.run()
  const results = await Promise.all([fixture.run(), fixture.run()])
  for (const result of results) expect(result).toMatchObject({ run: { state: 'passed' } })
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(installs.filter(args => !args.includes('--offline'))).toHaveLength(1)
})

it('refills an unavailable warmed store online instead of failing the job', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await fixture.failOffline()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(installs.filter(args => !args.includes('--offline'))).toHaveLength(2)
})

it('waits for dependencies before database preparation can trigger another install', async () => {
  const fixture = await computer({ prepareDatabase: true })
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(await fixture.commands()).toContainEqual(['pnpm', 'db:up'])
})

it('falls back to a fresh checkout when the slot checkout is unusable, then recreates the slot', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await fixture.breakCheckout()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' },
    text: expect.stringContaining('[ci-checkout] persistent checkout unusable') })
  const next = await fixture.run()
  expect(next).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=pristine') })
  expect(next).toMatchObject({ text: expect.not.stringContaining('[ci-checkout]') })
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(installs.filter(args => !args.includes('--offline'))).toHaveLength(1)
})

it('fetches only the tested commit on a cold runner and on later jobs with explicit files', async () => {
  const fixture = await computer()
  const staleCommit = fixture.git('rev-parse', 'HEAD')
  fixture.git('branch', 'ci/stale', staleCommit)
  fixture.git('commit', '--allow-empty', '-qm', 'tested commit')
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(fixture.checkout('for-each-ref', '--format=%(refname)', 'refs/remotes/')).toBe('')
  expect(fixture.checkout('rev-list', '--count', fixture.git('rev-parse', 'HEAD'))).toBe('1')
  fixture.git('commit', '--allow-empty', '-qm', 'next tested commit')
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(fixture.checkout('for-each-ref', '--format=%(refname)', 'refs/remotes/')).toBe('')
  expect(fixture.checkout('rev-list', '--count', fixture.git('rev-parse', 'HEAD'))).toBe('1')
})
