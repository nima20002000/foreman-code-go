import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'
import { CloudCi } from './cloud.js'
import { CircleCiProvider, GitHubActionsProvider } from './cloudProviders.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'
import { selectByIndexes } from '../../../../../scripts/ci-files.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** A private repository and its public mirror as local bare repositories standing in for GitHub, with a gh that
 * records dispatches and replays the run states a test sets. */
async function fixture(files: Record<string, string> = {}, options: { mirror?: boolean; provider?: 'github' | 'circleci' } = {}) {
  const root = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT ?? '/tmp', 'cloud-ci-'))
  roots.push(root)
  const environment = gitFixtureEnvironment()
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: environment, encoding: 'utf8' }).trim()
  const work = join(root, 'work'), mirrorWork = join(root, 'mirror-work')
  const origin = join(root, 'origin.git'), mirror = join(root, 'mirror.git')
  for (const path of [work, mirrorWork]) await mkdir(path)
  run(root, 'init', '-q', '--bare', origin); run(root, 'init', '-q', '--bare', mirror)
  // The mirror starts from one import commit without the private history.
  run(mirrorWork, 'init', '-q', '-b', 'main'); await writeFile(join(mirrorWork, 'README.md'), 'import\n')
  run(mirrorWork, 'add', '.'); run(mirrorWork, 'commit', '-qm', 'Initial import'); run(mirrorWork, 'push', '-q', mirror, 'main')
  run(work, 'init', '-q', '-b', 'main')
  await writeFile(join(work, 'secret-history.txt'), 'old\n'); run(work, 'add', '.'); run(work, 'commit', '-qm', 'private history')
  await rm(join(work, 'secret-history.txt'))
  await mkdir(join(work, 'apps/api/test'), { recursive: true }); await mkdir(join(work, 'scripts'))
  for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(work, `apps/api/test/${name}.integration.test.ts`), '')
  await writeFile(join(work, 'scripts/integration-durations.json'), JSON.stringify({ 'apps/api/test/a.integration.test.ts': 400,
    'apps/api/test/b.integration.test.ts': 300, 'apps/api/test/c.integration.test.ts': 200, 'apps/api/test/d.integration.test.ts': 100 }))
  for (const [path, text] of Object.entries(files)) await writeFile(join(work, path), text)
  run(work, 'add', '-A'); run(work, 'commit', '-qm', 'change'); run(work, 'push', '-q', origin, 'main')
  const commit = run(work, 'rev-parse', 'HEAD')
  const local = (value: string) => value === 'https://github.com/octo/site.git' ? origin
    : value === 'https://github.com/octo/site-ci.git' ? mirror : value
  const git: GitWorktreePorts = {
    cloneDirectory: repository => join(root, 'clones', ...repository.split('/')),
    git: (args, options) => {
      try {
        const stdout = execFileSync('git', args.map(local), { cwd: options.cwd, env: { ...environment, ...options.env }, encoding: 'utf8' })
        return Promise.resolve({ code: 0, stdout, stderr: '' })
      } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string }
        return Promise.resolve({ code: failed.status ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' })
      }
    },
  }
  const dispatched: string[][] = []
  const github = { listed: [] as { databaseId: number; displayTitle: string }[], status: 'in_progress', conclusion: '',
    durations: null as Record<string, number> | null }
  const circle = { triggered: [] as string[][], outcome: '' as string, durations: null as Record<string, number> | null }
  const system = systemHostCiPorts()
  const ports: HostCiPorts = { ...system, run: async (file, args) => {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (file === 'tailscale') return ok(JSON.stringify({ MagicDNSSuffix: 'tail0000.ts.net',
      Self: { HostName: 'owner-desktop', TailscaleIPs: ['100.90.1.2', 'fd7a::1'] },
      Peer: { a: { HostName: 'builder-Laptop', TailscaleIPs: ['100.90.1.3'] } }, User: { 1: { LoginName: 'owner@example.org' } } }))
    if (file === 'circleci') {
      if (args[0] === 'auth') return ok()
      if (args[0] === 'run' && args[1] === 'trigger') { circle.triggered.push([...args]); return ok(JSON.stringify({ id: 'run-1' })) }
      if (args[0] === 'run' && args[1] === 'get') return ok(JSON.stringify({ workflows: [{ jobs: [{ id: 'job-1' }] }] }))
      if (args[0] === 'job' && args[1] === 'get') return ok(JSON.stringify(circle.outcome
        ? { phase: 'ended', outcome: circle.outcome, stopped_at: '2026-10-11T02:00:00Z' } : { phase: 'started' }))
      if (args[0] === 'job' && args[1] === 'output') return ok('Suite\nall green\n')
      if (args[0] === 'job' && args[1] === 'artifact' && circle.durations) {
        const directory = join(args[args.indexOf('--output') + 1]!, 'durations')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'durations.json'), JSON.stringify(circle.durations))
        return ok()
      }
      return { code: 1, stdout: '', stderr: `unexpected circleci ${args.join(' ')}` }
    }
    if (file !== 'gh') return system.run(file, args)
    if (args[0] === 'auth') return ok()
    if (args[0] === 'workflow') { dispatched.push([...args]); return ok() }
    if (args[1] === 'list') return ok(JSON.stringify(github.listed))
    if (args[1] === 'view' && args.includes('--log')) return ok('ci\tSuite\tall green\n')
    if (args[1] === 'view') return ok(JSON.stringify({ status: github.status, conclusion: github.conclusion, updatedAt: new Date().toISOString() }))
    if (args[1] === 'download') {
      if (!github.durations) return { code: 1, stdout: '', stderr: 'no artifact' }
      const directory = args[args.indexOf('-D') + 1]!
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'durations.json'), JSON.stringify(github.durations))
      return ok()
    }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
  } }
  const provider = options.provider === 'circleci' ? new CircleCiProvider(ports) : new GitHubActionsProvider(ports)
  const cloud = new CloudCi('main-1', provider, async repository => options.mirror === false ? null
    : repository === 'octo/site' ? 'octo/site-ci' : null, join(root, 'ci-cloud'), ports, git,
    { home: '/home/owner', user: 'owner', host: 'owner-desktop' })
  const mirrorGit = (...args: string[]) => run(mirror, ...args)
  return { cloud, commit, dispatched, github, circle, mirrorGit, run: (...args: string[]) => run(work, ...args) }
}

describe('GitHub Actions CI on a public mirror', () => {
  it.each(['github', 'circleci'] as const)('spreads heavy integration files across every %s slice', async provider => {
    const heavy = [
      'apps/api/test/remote-review-production-main-crash.integration.test.ts',
      'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts',
      'apps/api/test/local-human-native.integration.test.ts',
      'apps/api/test/native-stream-lifecycle.integration.test.ts',
    ]
    const f = await fixture(Object.fromEntries(heavy.map(file => [file, ''])), { provider })
    const inventory = [...['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`), ...heavy].sort()
    const durations = Object.fromEntries(heavy.map((file, index) => [file, 80 - index * 20]))
    for (const index of [0, 1, 2, 3]) {
      await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
        suite: 'integration', durations, partition: { index, count: 4, weights: [8, 1, 1, 1] } })
    }
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    const slices = commands.map(command => selectByIndexes(inventory,
      command.find(value => value.startsWith('slice='))!.slice('slice='.length)))
    expect(slices.flat().sort()).toEqual(inventory)
    expect(slices.map(slice => slice.filter(file => heavy.includes(file)).length)).toEqual([1, 1, 1, 1])
    expect(slices[0]).toContain(heavy[0])
    expect(slices[1]).toContain(heavy[1])
  })

  it.each(['github'] as const)('dispatches unit part names and one-based shards through %s', async provider => {
    const f = await fixture({}, { provider })
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-web', partition: { index: 1, count: 3 } })
    const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
    expect(command).toContain('suite=unit-web')
    expect(command).toContain('slice=2/3')
  })

  it.each(['github'] as const)('passes already sharded affected files to the unit part through %s', async provider => {
    const f = await fixture({ 'apps/api/test/feature.test.ts': 'export {}' }, { provider })
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-api', scope: 'affected', files: ['apps/api/test/feature.test.ts'],
      partition: { index: 1, count: 2 } })
    const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
    expect(command).toContain('suite=unit-api')
    expect(command).toContain('slice=')
    expect(command).toContain('scope=affected')
    expect(command).toContain('files=s:4')
  })

  it.each(['github'] as const)('reads measured unit durations from %s artifacts', async provider => {
    const f = await fixture({}, { provider })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-api', partition: { index: 0, count: 5 } })
    const durations = { 'apps/api/test/feature.test.ts': 250 }
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
    f.github.status = 'completed'
    f.github.conclusion = 'success'
    f.github.durations = durations
    f.circle.outcome = 'succeeded'
    f.circle.durations = durations
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true }))
      .toMatchObject({ run: { state: 'passed', step: 'unit-api' }, durations })
  })
  it('encodes affected integration files against the complete commit inventory before partitioning', async () => {
    const f = await fixture()
    const files = ['apps/api/test/b.integration.test.ts', 'apps/api/test/d.integration.test.ts']
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'affected', files, partition: { index: 0, count: 2 } })
    expect(f.dispatched[0]).toContain('slice=s:1')
    expect(f.dispatched[0]).toContain('scope=affected')
  })

  it.each(['github'] as const)('passes affected unit scope and compact file indexes through %s', async provider => {
    const f = await fixture({ 'apps/api/test/feature.test.ts': 'export {}' }, { provider })
    const files = ['apps/api/test/feature.test.ts']
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', scope: 'affected', files })
    const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
    expect(command).toContain('scope=affected')
    expect(command).toContain('files=s:4')
  })
  it('publishes only the commit files, then dispatches one run with its partition slice', async () => {
    const f = await fixture()
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', partition: { index: 0, count: 2 } })
    expect(started).toMatchObject({ operation: 'start', run: { runId, state: 'starting' } })
    const branch = `refs/heads/ci/${f.commit}`
    // Same files, one new commit on the mirror's import; the private history never leaves.
    expect(f.mirrorGit('rev-parse', `${branch}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
    expect(f.mirrorGit('rev-list', '--count', branch)).toBe('2')
    expect(() => f.mirrorGit('cat-file', '-e', f.commit)).toThrow()
    expect(f.mirrorGit('rev-parse', 'refs/heads/main')).toBe(f.mirrorGit('rev-parse', branch))
    expect(f.dispatched).toEqual([['workflow', 'run', 'ci.yml', '-R', 'octo/site-ci', '--ref', 'main', '-f', `ref=ci/${f.commit}`,
      '-f', `run_id=${runId}`, '-f', 'suite=integration',
      '-f', 'slice=s:0,3']])
    // A retried start returns the same run without dispatching again.
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration',
      partition: { index: 0, count: 2 } })
    expect(f.dispatched).toHaveLength(1)
  })

  it('follows the GitHub run to its result, log and measured durations', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration',
      partition: { index: 1, count: 2 } })
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
    expect(await read()).toMatchObject({ run: { state: 'starting' } })
    f.github.listed = [{ databaseId: 7, displayTitle: 'ci another' }, { databaseId: 8, displayTitle: `ci ${runId}` }]
    expect(await read()).toMatchObject({ run: { state: 'running', step: 'integration' } })
    f.github.status = 'completed'; f.github.conclusion = 'success'
    f.github.durations = { 'apps/api/test/b.integration.test.ts': 250 }
    expect(await read()).toMatchObject({ run: { state: 'passed', exitCode: 0 }, text: 'ci\tSuite\tall green\n',
      durations: { 'apps/api/test/b.integration.test.ts': 250 } })
  })

  it.each([
    ['the home path', { 'notes.md': 'see /home/owner/projects\n' }],
    ['a computer name', { 'docs.md': 'Run it on Builder first.\n' }],
    ['a Tailscale address', { 'hosts.txt': 'ssh 100.90.1.3\n' }],
    ['the tailnet domain', { 'hosts.txt': 'owner-desktop.tail0000.ts.net\n' }],
  ])('refuses to publish files naming %s', async (_kind, files) => {
    const f = await fixture(files)
    await expect(f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_MIRROR_PRIVATE_DATA', message: expect.stringContaining(Object.keys(files)[0]!) })
    expect(() => f.mirrorGit('rev-parse', '--verify', `refs/heads/ci/${f.commit}`)).toThrow()
    expect(f.dispatched).toEqual([])
  })

  it('leaves a run without a mirror to the build computers', async () => {
    const f = await fixture({}, { mirror: false })
    await expect(f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
  })

  it('leaves check and unit suites on CircleCI to the other computers', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    for (const suite of ['unit', 'lint', 'typecheck'] as const) {
      await expect(f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
        suite })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    }
    expect(f.dispatched).toEqual([])
  })

  it('runs the same published files on CircleCI and reads its result, log and durations back', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    expect(await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration',
      partition: { index: 1, count: 2 } })).toMatchObject({ run: { runId, state: 'running' } })
    expect(f.mirrorGit('rev-parse', `refs/heads/ci/${f.commit}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
    expect(f.circle.triggered).toEqual([['run', 'trigger', '--project', 'gh/octo/site-ci', '--branch', `ci/${f.commit}`,
      '--parameter', `run_id=${runId}`, '--parameter', 'suite=integration',
      '--parameter', 'slice=s:1-2', '--json']])
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
    expect(await read()).toMatchObject({ run: { state: 'running' } })
    f.circle.outcome = 'failed'; f.circle.durations = { 'apps/api/test/c.integration.test.ts': 180 }
    expect(await read()).toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: '2026-10-11T02:00:00Z' },
      text: 'Suite\nall green\n', durations: { 'apps/api/test/c.integration.test.ts': 180 } })
  })
})
