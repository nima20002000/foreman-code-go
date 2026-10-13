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

async function computer() {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
    ?? join(homedir(), '.cache/foreman-code/tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'warm-host-'))
  roots.push(root)
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  await mkdir(origin)
  await mkdir(bin)
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
  await writeFile(join(origin, 'pnpm-lock.yaml'), 'fixture-lock-one')
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
if (args[1] === 'install') {
  const storeIndex = args.indexOf('--store-dir')
  const store = storeIndex < 0 ? '.fixture-store' : args[storeIndex + 1]
  const seed = path.join(store, require('node:crypto').createHash('sha256').update(fs.readFileSync('pnpm-lock.yaml')).digest('hex'))
  if (args.includes('--offline') && !fs.existsSync(seed)) process.exit(7)
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(seed, 'pristine')
  fs.mkdirSync('node_modules', { recursive: true })
  if (!fs.existsSync('node_modules/dependency')) fs.writeFileSync('node_modules/dependency', 'pristine')
} else {
  console.log('dependency=' + fs.readFileSync('node_modules/dependency', 'utf8'))
  fs.writeFileSync('node_modules/dependency', 'modified by suite')
}
`, { mode: 0o755 })
  const system = systemHostCiPorts()
  let launched = Promise.resolve()
  const ports: HostCiPorts = { ...system, cpus: 16, memoryBytes: 16 * 2 ** 30,
    availableMemoryBytes: () => 16 * 2 ** 30,
    run: async (file, args, options) => {
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
      if (file === 'git' && args.includes('clone')) {
        return system.run(file, args.map(arg => arg.startsWith('https://') ? origin : arg), options)
      }
      if (file === 'systemd-run') {
        const cwd = args.find(arg => arg.startsWith('--working-directory='))!.slice('--working-directory='.length)
        const env = Object.fromEntries(args.filter(arg => arg.startsWith('--setenv='))
          .map(arg => arg.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
        launched = system.run('/bin/bash', [args.at(-1)!], { cwd, env }).then(result => {
          if (result.code !== 0) throw new Error(`Fixture failed: ${result.stderr}`)
        })
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
    await launched
    return runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
  }
  const commands = async () => (await readFile(calls, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as string[])
  return { run, commands, origin, git }
}

it('warms once, installs offline on later jobs, and preserves private mutable dependencies', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=pristine') })
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
