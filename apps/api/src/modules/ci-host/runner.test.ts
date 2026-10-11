import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

const roots: string[] = []
const children = new Set<ReturnType<typeof spawn>>()
async function stopUnit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  process.kill(-child.pid!, 'SIGKILL')
  await closed
}
afterEach(async () => {
  await Promise.all([...children].map(stopUnit))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A computer with a real git origin standing in for GitHub, gh and corepack shims, and a systemd-run that runs the
 * unit's script as a child process the way the user manager would. */
async function computer(options: { github?: boolean; suiteExit?: number; pause?: boolean
  measured?: Record<string, number> } = {}) {
  const root = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT ?? '/tmp', 'host-ci-'))
  roots.push(root)
  const environment = gitFixtureEnvironment()
  const origin = join(root, 'origin')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  await mkdir(join(origin, 'apps/api/test'), { recursive: true })
  await writeFile(join(origin, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {
    typecheck: 'tsc', lint: 'eslint', build: 'tsc -b', test: 'vitest', 'test:integration': 'node scripts/test-integration.mjs', 'db:up': 'node db.mjs' } }))
  for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(origin, `apps/api/test/${name}.integration.test.ts`), '')
  await mkdir(join(origin, 'scripts'))
  await writeFile(join(origin, 'scripts/integration-durations.json'), JSON.stringify({
    'apps/api/test/a.integration.test.ts': 400, 'apps/api/test/b.integration.test.ts': 300,
    'apps/api/test/c.integration.test.ts': 200, 'apps/api/test/d.integration.test.ts': 100 }))
  await mkdir(join(origin, 'apps/web/src'), { recursive: true })
  await writeFile(join(origin, 'apps/web/heavy-tests.json'), JSON.stringify({ files: [] }))
  await writeFile(join(origin, 'scripts/ci-unit-files.mjs'),
    await readFile(new URL('../../../../../scripts/ci-unit-files.mjs', import.meta.url), 'utf8'))
  for (const file of ['ci-affected-run.mjs', 'ci-files.mjs']) {
    await writeFile(join(origin, 'scripts', file), await readFile(new URL(`../../../../../scripts/${file}`, import.meta.url), 'utf8'))
  }
  await writeFile(join(origin, 'scripts/test-command.mjs'),
    "import { spawnSync } from 'node:child_process'; const [, command, ...args] = process.argv.slice(2);"
      + " const result = spawnSync(command, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);\n")
  const unitFiles = ['apps/api/test/first.test.ts', 'apps/api/test/second.test.ts',
    'apps/web/src/first.test.tsx', 'apps/web/src/second.test.tsx']
  for (const file of unitFiles) await writeFile(join(origin, file), '')
  await writeFile(join(origin, 'scripts/unit-durations.json'), JSON.stringify(Object.fromEntries(
    unitFiles.map((file, index) => [file, 100 + index * 10]))))
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'fixture')
  const commit = git('rev-parse', 'HEAD')
  const bin = join(root, 'bin')
  await mkdir(bin)
  // corepack records its arguments; the suite command exits with the requested status. With `measured`, the
  // integration suite prints the durations it was given and reports the ones it measured, like the repository's runner.
  const integration = options.measured ? `if [ "$2" = test:integration ]; then echo "expected $(cat "$FOREMAN_CODE_INTEGRATION_DURATIONS")"; `
    + `printf '%s' '${JSON.stringify(options.measured)}' > "$FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT"; fi\n` : ''
  const unitReport = `${process.execPath} -e 'const fs = require("node:fs"); const path = require("node:path");
    const args = process.argv.slice(1); const output = args.find(arg => arg.startsWith("--outputFile.json="));
    if (output) fs.writeFileSync(output.slice("--outputFile.json=".length), JSON.stringify({ testResults:
      args.filter(arg => /\\.test\\.tsx?$/.test(arg)).map(file => ({ name: path.resolve(file), status: "passed", startTime: 1, endTime: 6 })) }));' "$@"\n`
  await writeFile(join(bin, 'corepack'), `#!/bin/bash\necho "corepack $*"\n${integration}${unitReport}`
    + 'if [ "$*" = "pnpm --filter @foreman-code/contracts build" ]; then exit 0; fi\n'
    + 'if [ "$2" != install ] && [ "$2" != db:up ]; then '
    + `${options.pause ? 'read -r pauseInput; ' : ''}exit ${options.suiteExit ?? 0}; fi\n`)
  await chmod(join(bin, 'corepack'), 0o755)
  let notifyUnitStarted!: () => void
  const unitStarted = new Promise<void>(resolve => { notifyUnitStarted = resolve })
  const units = new Map<string, ReturnType<typeof spawn>>()
  const system = systemHostCiPorts()
  const ports: HostCiPorts = { ...system, cpus: 8, memoryBytes: 16 * 2 ** 30,
    run: async (file, args, runOptions = {}) => {
      if (file === 'gh') return { code: options.github === false ? 1 : 0, stdout: '', stderr: '' }
      if (file === 'git' && args.includes('clone')) {
        return system.run('git', args.map(value => value.startsWith('https://github.com/') ? origin : value), runOptions)
      }
      if (file === 'systemd-run') {
        const name = args.find(value => value.startsWith('--unit='))!.slice('--unit='.length)
        const env = Object.fromEntries(args.filter(value => value.startsWith('--setenv='))
          .map(value => value.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
        const cwd = args.find(value => value.startsWith('--working-directory='))!.slice('--working-directory='.length)
        const child = spawn('/bin/bash', [args.at(-1)!], { cwd, detached: true, env: { ...env, PATH: `${bin}:${process.env.PATH}` } })
        units.set(name, child)
        children.add(child)
        child.once('close', () => children.delete(child))
        child.on('exit', () => units.delete(name))
        notifyUnitStarted()
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl' && args.includes('is-active')) {
        return { code: 0, stdout: units.has(args.at(-1)!.replace('.service', '')) ? 'active\n' : 'inactive\n', stderr: '' }
      }
      if (file === 'systemctl' && args.includes('stop')) {
        const child = units.get(args.at(-1)!.replace('.service', ''))
        if (child) await stopUnit(child)
        return { code: 0, stdout: '', stderr: '' }
      }
      return system.run(file, args, { ...runOptions, env: { ...environment, ...runOptions.env } })
    } }
  const runner = new HostCiRunner(join(root, 'ci'), ports, { ...environment, PATH: `${bin}:${process.env.PATH}` })
  const settle = (runId: string) => vi.waitFor(async () => {
    const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
    if (reply.operation !== 'read' || ['starting', 'running'].includes(reply.run.state)) {
      throw new Error('The run did not settle.')
    }
    return reply
  }, { interval: 5, timeout: 10_000 })
  return { root, runner, commit, settle, units, unitStarted }
}

describe('host CI runner', () => {
  it.each([
    ['lint-api', 'lint', '--filter @foreman-code/api lint'],
    ['lint-other', 'lint', '-r --no-bail --filter !@foreman-code/api --if-present lint'],
    ['typecheck-api', 'typecheck', '--filter @foreman-code/api typecheck'],
    ['typecheck-other', 'typecheck', '-r --filter !@foreman-code/api --if-present typecheck'],
    ['build-api', 'build', '--filter @foreman-code/api build'],
    ['build-other', 'build', '-r --filter !@foreman-code/api --if-present build'],
  ])('executes %s with the package commands used by the cloud suite', async (part, suite, command) => {
    const f = await computer()
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite, part })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', step: part })
    expect(done.text).toContain(`corepack pnpm ${command}`)
  })

  it.each(['unit-api', 'unit-web'])('executes every file once across %s shards and reports timings', async part => {
    const f = await computer()
    const measured: string[] = []
    for (const index of [0, 1]) {
      const runId = randomUUID()
      await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
        suite: 'unit', part, partition: { index, count: 2 } })
      expect((await f.settle(runId)).run).toMatchObject({ state: 'passed', step: part })
      const result = await f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true })
      expect(result.operation).toBe('read')
      if (result.operation === 'read') measured.push(...Object.keys(result.durations!))
    }
    const project = part === 'unit-api' ? 'apps/api/test' : 'apps/web/src'
    const extension = part === 'unit-api' ? 'ts' : 'tsx'
    expect(measured.sort()).toEqual([`${project}/first.test.${extension}`, `${project}/second.test.${extension}`])
  })

  it('preserves a failing unit part exit code after collecting its durations', async () => {
    const f = await computer({ suiteExit: 7 })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-web', partition: { index: 0, count: 2 } })
    expect((await f.settle(runId)).run).toMatchObject({ state: 'failed', exitCode: 7, step: 'unit-web' })
  })

  it('executes an affected unit part selection without slicing it again', async () => {
    const f = await computer()
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-api', partition: { index: 1, count: 2 }, scope: 'affected',
      files: ['apps/api/test/first.test.ts'] })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', step: 'unit-api' })
    expect(done.text).toContain('corepack pnpm --dir apps/api exec vitest run test/first.test.ts')
    expect(done.text).not.toContain('test/second.test.ts')
  })

  it('fetches the commit, installs and runs the suite in its own worktree, then frees the worktree', async () => {
    const f = await computer()
    const runId = randomUUID()
    const started = await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'unit' })
    expect(started).toMatchObject({ operation: 'start', run: { runId, state: expect.stringMatching(/starting|running/) } })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', exitCode: 0, step: 'unit' })
    expect(done.text).toContain('corepack pnpm install --frozen-lockfile')
    expect(done.text).toContain('corepack pnpm test')
    expect(existsSync(join(f.root, 'ci/runs', runId, 'src'))).toBe(false)
    // A retried start returns the same run instead of starting it again.
    expect(await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'unit' }))
      .toMatchObject({ run: { runId, state: 'passed' } })
  })

  it('reports a failing suite with its exit code and step', async () => {
    const f = await computer({ suiteExit: 3 })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'typecheck' })
    expect((await f.settle(runId)).run).toMatchObject({ state: 'failed', exitCode: 3, step: 'typecheck' })
  })

  it('runs a duration-balanced slice of the integration files after starting the database', async () => {
    const f = await computer()
    const slices: string[][] = []
    for (const index of [0, 1]) {
      const runId = randomUUID()
      await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration',
        partition: { index, count: 2 } })
      const done = await f.settle(runId)
      expect(done.run.state).toBe('passed')
      expect(done.text).toContain('corepack pnpm db:up')
      slices.push([...done.text.matchAll(/apps\/api\/test\/(\w)\.integration/g)].map(match => match[1]!))
    }
    expect(slices.flat().sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(slices.map(slice => slice.sort())).toEqual([['a', 'd'], ['b', 'c']])
  })

  it('splits and times integration files by Main\'s learned durations and reports the durations it measured', async () => {
    const measured = { 'apps/api/test/d.integration.test.ts': 870 }
    const f = await computer({ measured })
    // Learned: d became the slowest file and a the fastest; c keeps its committed duration.
    const durations = { 'apps/api/test/a.integration.test.ts': 50, 'apps/api/test/b.integration.test.ts': 300,
      'apps/api/test/d.integration.test.ts': 900 }
    const slices: string[][] = []
    for (const index of [0, 1]) {
      const runId = randomUUID()
      await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration',
        partition: { index, count: 2 }, durations })
      const done = await f.settle(runId)
      expect(done.run.state).toBe('passed')
      expect(done.durations).toBeUndefined()
      const command = done.text.split('\n').find(line => line.startsWith('corepack pnpm test:integration'))!
      slices.push([...command.matchAll(/apps\/api\/test\/(\w)\.integration/g)].map(match => match[1]!).sort())
      const expected = JSON.parse(done.text.split('\n').find(line => line.startsWith('expected '))!.slice('expected '.length))
      expect(expected).toEqual({ ...durations, 'apps/api/test/c.integration.test.ts': 200 })
      expect(await f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true }))
        .toMatchObject({ operation: 'read', durations: measured })
    }
    expect(slices).toEqual([['d'], ['a', 'b', 'c']])
  })

  it('runs one suite at a time and stops a run on cancel', async () => {
    const f = await computer({ pause: true })
    const first = randomUUID()
    await f.runner.handle({ operation: 'start', runId: first, repository: 'octo/site', commit: f.commit, suite: 'lint' })
    await f.unitStarted
    await expect(f.runner.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    const canceled = await f.runner.handle({ operation: 'cancel', runId: first })
    expect(canceled).toMatchObject({ run: { state: 'canceled' } })
    expect(f.units.size).toBe(0)
  })

  it('refuses to start without a GitHub login and says how to fix it', async () => {
    const f = await computer({ github: false })
    await expect(f.runner.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'COMPUTER_GITHUB_REQUIRED' })
    const status = await f.runner.handle({ operation: 'status' })
    expect(status).toMatchObject({ operation: 'status', ready: false, cpuCount: 8 })
    expect(status.operation === 'status' && status.reasons.join(' ')).toContain('gh auth login')
    expect(await readdir(join(f.root, 'ci')).catch(() => [])).not.toContain('runs')
  })

  it('marks a run lost when its unit ends without an exit status', async () => {
    const f = await computer({ pause: true })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'build' })
    await f.unitStarted
    await Promise.all([...f.units.values()].map(stopUnit))
    expect((await f.settle(runId)).run).toMatchObject({ state: 'lost', exitCode: null })
    expect(await readFile(join(f.root, 'ci/runs', runId, 'meta.json'), 'utf8')).toContain('"cleaned":true')
  })
})
