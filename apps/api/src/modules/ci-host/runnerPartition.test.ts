import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

it('selects one heavy integration file per weighted build-computer partition', async () => {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
  if (!base) throw new Error('A disposable test root is required')
  const root = await mkdtemp(join(base, 'partition-host-'))
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  const heavy = [
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts',
    'apps/api/test/local-human-native.integration.test.ts',
    'apps/api/test/native-stream-lifecycle.integration.test.ts',
  ]
  const ordinary = ['first', 'second', 'third', 'fourth'].map(name => `apps/api/test/${name}.integration.test.ts`)
  const files = [...ordinary, ...heavy]
  const durations = Object.fromEntries(files.map((file, index) => [file, 1000 - index * 100]))
  const system = systemHostCiPorts()
  let launched = Promise.resolve()
  try {
    await mkdir(join(origin, 'apps/api/test'), { recursive: true })
    await mkdir(join(origin, 'scripts'))
    await mkdir(bin)
    for (const file of files) await writeFile(join(origin, file), '')
    await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { 'test:integration': 'fixture' } }))
    await writeFile(join(origin, 'pnpm-lock.yaml'), '')
    await writeFile(join(origin, 'scripts/integration-durations.json'), JSON.stringify(durations))
    await writeFile(join(origin, 'scripts/ci-suite.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(origin, 'scripts/ci-files.mjs'),
      await readFile(new URL('../../../../../scripts/ci-files.mjs', import.meta.url), 'utf8'))
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
        const cwd = args.find(value => value.startsWith('--working-directory='))!.slice('--working-directory='.length)
        launched = system.run('/bin/bash', [args.at(-1)!], { cwd, env: environment }).then(result => {
          expect(result.code).toBe(0)
        })
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl') return { code: 0, stdout: 'active', stderr: '' }
      return system.run(file, args, options)
    } }
    const runner = new HostCiRunner(join(root, 'runner'), ports, environment)
    for (const index of [0, 1, 2, 3]) {
      const runId = randomUUID()
      await runner.handle({ operation: 'start', runId, repository: 'example/project', commit, suite: 'integration',
        partition: { index, count: 4, weights: [8, 1, 1, 1] } })
      await expect.poll(async () => {
        const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
        return reply.operation === 'read' ? reply.run.state : 'unexpected'
      }).not.toBe('starting')
      await launched
      expect(await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
        .toMatchObject({ run: { state: 'passed' } })
    }
    const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const slices = commands.filter(command => command[1] === 'test:integration')
      .map(command => command.slice(command.indexOf('--files') + 1))
    expect(slices).toHaveLength(4)
    expect(slices.flat().sort()).toEqual([...files].sort())
    expect(slices.map(slice => slice.filter(file => heavy.includes(file)).length)).toEqual([1, 1, 1, 1])
    expect(slices[0]).toContain(heavy[0])
    expect(slices[1]).toContain(heavy[1])
  } finally {
    try { await launched } finally { await rm(root, { recursive: true, force: true }) }
  }
})
