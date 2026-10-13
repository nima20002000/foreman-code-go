import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
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

/** A build computer with a real git origin standing in for GitHub and a corepack shim that records each install. */
async function computer() {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
    ?? join(homedir(), '.cache/foreman-code/tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'slot-host-'))
  roots.push(root)
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  const started = join(root, 'started')
  await mkdir(join(origin, 'src'), { recursive: true })
  await mkdir(bin)
  await mkdir(started)
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
  await writeFile(join(origin, 'pnpm-lock.yaml'), 'fixture-lock')
  await writeFile(join(origin, '.gitignore'), 'node_modules/\ndist/\n')
  await writeFile(join(origin, 'src/kept.ts'), 'export const kept = 1\n')
  await writeFile(join(origin, 'src/removed.ts'), 'export const removed = 1\n')
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  // install records whether the checkout already had dependencies; lint can wait until `parallel` parts run at once.
  await writeFile(join(bin, 'corepack'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[1] === 'install') {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cwd: process.cwd(), args,
    installed: fs.existsSync('node_modules/dependency') }) + '\\n')
  fs.mkdirSync('node_modules', { recursive: true })
  fs.writeFileSync('node_modules/dependency', 'installed')
} else {
  const parallel = Number(process.env.FIXTURE_PARALLEL ?? 1)
  fs.writeFileSync(path.join(${JSON.stringify(started)}, String(process.pid)), '')
  const deadline = Date.now() + 10000
  while (fs.readdirSync(${JSON.stringify(started)}).length < parallel && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  console.log('dependency=' + fs.readFileSync('node_modules/dependency', 'utf8'))
  console.log('kept=' + require(path.join(process.cwd(), 'src/kept.ts')).kept)
}
`, { mode: 0o755 })
  const system = systemHostCiPorts()
  const launched = new Map<string, { cwd: string; done: Promise<unknown> }>()
  let parallel = 1
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
        launched.set(args.at(-1)!, { cwd,
          done: system.run('/bin/bash', [args.at(-1)!], { cwd, env: { ...env, FIXTURE_PARALLEL: String(parallel) } }) })
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
    const script = join(root, 'runner/runs', runId, 'run.sh')
    await vi.waitFor(() => expect(launched.has(script)).toBe(true), { timeout: 10_000 })
    await launched.get(script)!.done
    const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
    if (reply.operation !== 'read') throw new Error('Expected a read reply.')
    return { ...reply, checkout: launched.get(script)!.cwd }
  }
  const installs = async () => (await readFile(calls, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { cwd: string; args: string[]; installed: boolean })
  const inCheckout = (checkout: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: checkout, env: environment, encoding: 'utf8' }).trim()
  return { run, installs, git, origin, inCheckout, concurrently: async (count: number) => {
    parallel = count
    await rm(started, { recursive: true, force: true })
    await mkdir(started)
  } }
}

it('runs the next part in the same checkout and installs incrementally over its dependencies', async () => {
  const fixture = await computer()
  const first = await fixture.run()
  const second = await fixture.run()
  expect(first).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=installed') })
  expect(second).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=installed') })
  expect(second.checkout).toBe(first.checkout)
  const installs = await fixture.installs()
  expect(installs).toHaveLength(2)
  expect(installs[1]).toMatchObject({ cwd: first.checkout, installed: true })
  expect(installs[1]!.args).toEqual(expect.arrayContaining(['--offline', '--frozen-lockfile']))
})

it('resets a reused checkout to exactly the requested commit without leftover files', async () => {
  const fixture = await computer()
  const first = await fixture.run()
  expect(first.run.state).toBe('passed')
  await writeFile(join(first.checkout, 'src/kept.ts'), 'locally modified\n')
  await writeFile(join(first.checkout, 'untracked.ts'), 'leftover\n')
  await mkdir(join(first.checkout, 'dist'), { recursive: true })
  await writeFile(join(first.checkout, 'dist/removed.js'), 'stale build output\n')
  fixture.git('rm', '-q', 'src/removed.ts')
  fixture.git('commit', '-qm', 'remove a source')
  const second = await fixture.run()
  expect(second.run.state).toBe('passed')
  expect(second.checkout).toBe(first.checkout)
  expect(fixture.inCheckout(second.checkout, 'rev-parse', 'HEAD')).toBe(fixture.git('rev-parse', 'HEAD'))
  expect(second.text).toContain('kept=1')
  expect(existsSync(join(second.checkout, 'src/removed.ts'))).toBe(false)
  expect(fixture.inCheckout(second.checkout, 'status', '--porcelain', '--ignored', '--untracked-files=all'))
    .toBe('!! node_modules/dependency')
})

it('gives concurrent parts different checkouts', async () => {
  const fixture = await computer()
  await fixture.run()
  await fixture.concurrently(2)
  const results = await Promise.all([fixture.run(), fixture.run()])
  for (const result of results) {
    expect(result).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=installed') })
  }
  expect(results[0].checkout).not.toBe(results[1].checkout)
})
