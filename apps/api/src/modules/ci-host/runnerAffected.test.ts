import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'

it('runs only affected integration files and balances partitions within that selection', async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'affected-host-'))
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  const system = systemHostCiPorts()
  let launched = Promise.resolve()
  try {
    await mkdir(join(origin, 'apps/api/test'), { recursive: true })
    await mkdir(join(origin, 'scripts'))
    await mkdir(bin)
    await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { 'test:integration': 'fixture' } }))
    const files = ['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)
    for (const file of files) await writeFile(join(origin, file), '')
    await writeFile(join(origin, 'scripts/integration-durations.json'), JSON.stringify(Object.fromEntries(
      files.map((file, index) => [file, 400 - index * 100]))))
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: origin, env: gitFixtureEnvironment(), encoding: 'utf8',
    }).trim()
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-qm', 'fixture')
    const commit = git('rev-parse', 'HEAD')
    await writeFile(join(bin, 'corepack'), `#!${process.execPath}\n`
      + "require('node:fs').appendFileSync(process.env.CI_CALLS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n')\n")
    await chmod(join(bin, 'corepack'), 0o755)
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_CALLS_FILE: calls }
    const ports: HostCiPorts = { ...system, run: async (file, args, options) => {
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
      if (file === 'git' && args.includes('clone')) {
        return system.run(file, args.map(value => value.startsWith('https://') ? origin : value), options)
      }
      if (file === 'systemd-run') {
        const script = args.at(-1)!
        const cwd = args.find(value => value.startsWith('--working-directory='))!.split('=').slice(1).join('=')
        launched = system.run('/bin/bash', [script], { cwd, env: environment }).then(result => {
          expect(result.code).toBe(0)
        })
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl') return { code: 0, stdout: 'active', stderr: '' }
      return system.run(file, args, options)
    } }
    const runner = new HostCiRunner(join(root, 'runner'), ports, environment)
    const runId = randomUUID()
    await runner.handle({ operation: 'start', runId, repository: 'example/project', commit, suite: 'integration',
      scope: 'affected', files: [files[1]!, files[3]!], partition: { index: 0, count: 2 } })
    // Await the public running state before waiting for the launched shell.
    await expect.poll(async () => {
      const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
      return reply.operation === 'read' ? reply.run.state : 'unexpected'
    }).not.toBe('starting')
    await launched
    expect(await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })).toMatchObject({ run: { state: 'passed' } })
    const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(commands).toContainEqual(['pnpm', 'test:integration', '--files', files[1]!])
    expect(commands.filter(command => command[1] === 'test:integration')).toHaveLength(1)
  } finally {
    await launched
    await rm(root, { recursive: true, force: true })
  }
})
