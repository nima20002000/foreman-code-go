import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'
import { CloudCi } from './cloud.js'
import { CircleCiProvider, GitHubActionsProvider } from './cloudProviders.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'
import { selectByIndexes } from '../../../../../scripts/ci-files.mjs'
import { affectedSnapshot } from '../../../../../scripts/ci-affected.mjs'
import { executionSelection } from '../../../../../scripts/ci-selection.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** A private repository and its public mirror as local bare repositories standing in for GitHub, with a gh that
 * records dispatches and replays the run states a test sets. */
async function fixture(files: Record<string, string> = {}, options: { mirror?: boolean; provider?: 'github' | 'circleci'
  mirrorWorkflows?: boolean; sourceWorkflows?: boolean } = {}) {
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
  const workflows = { '.github/workflows/ci.yml': 'name: CI\non: workflow_dispatch\n',
    '.circleci/config.yml': 'version: 2.1\n' }
  for (const [path, text] of Object.entries(workflows)) {
    if (options.mirrorWorkflows === false) continue
    await mkdir(join(mirrorWork, path, '..'), { recursive: true })
    await writeFile(join(mirrorWork, path), text)
  }
  run(mirrorWork, 'add', '.'); run(mirrorWork, 'commit', '-qm', 'Initial import'); run(mirrorWork, 'push', '-q', mirror, 'main')
  run(work, 'init', '-q', '-b', 'main')
  await writeFile(join(work, 'secret-history.txt'), 'old\n'); run(work, 'add', '.'); run(work, 'commit', '-qm', 'private history')
  await rm(join(work, 'secret-history.txt'))
  await mkdir(join(work, 'apps/api/test'), { recursive: true }); await mkdir(join(work, 'scripts'))
  for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(work, `apps/api/test/${name}.integration.test.ts`), '')
  await writeFile(join(work, 'scripts/integration-durations.json'), JSON.stringify({ 'apps/api/test/a.integration.test.ts': 400,
    'apps/api/test/b.integration.test.ts': 300, 'apps/api/test/c.integration.test.ts': 200, 'apps/api/test/d.integration.test.ts': 100 }))
  for (const [path, text] of Object.entries(workflows)) {
    if (options.sourceWorkflows === false) continue
    await mkdir(join(work, path, '..'), { recursive: true })
    await writeFile(join(work, path), text)
  }
  for (const [path, text] of Object.entries(files)) await writeFile(join(work, path), text)
  run(work, 'add', '-A'); run(work, 'commit', '-qm', 'change'); run(work, 'push', '-q', origin, 'main')
  const commit = run(work, 'rev-parse', 'HEAD')
  const local = (value: string) => value === 'https://github.com/octo/site.git' ? origin
    : value === 'https://github.com/octo/site-ci.git' ? mirror : value
  const git: GitWorktreePorts = {
    cloneDirectory: repository => join(root, 'clones', ...repository.split('/')),
    // Asynchronous like Main's git, so concurrent starts really overlap.
    git: (args, options) => new Promise(resolve => {
      execFile('git', args.map(local), { cwd: options.cwd, env: { ...environment, ...options.env }, encoding: 'utf8' },
        (error, stdout, stderr) => {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
        })
    }),
  }
  const dispatched: string[][] = []
  const github = { listed: [] as { databaseId: number; displayTitle: string }[], status: 'in_progress', conclusion: '',
    durations: null as Record<string, number> | null, testResults: null as unknown, canceled: [] as string[],
    steps: [] as { number: number; name: string; status: string; conclusion: string | null }[],
    rateLimited: false, jobReads: [] as ('full' | 'unchanged')[] }
  const circle = { triggered: [] as string[][], outcome: '' as string, durations: null as Record<string, number> | null,
    testResults: null as unknown,
    phantoms: 0, lookupError: '', canceled: [] as string[],
    steps: [] as { num: number; name: string; phase: string; outcome?: string }[], output: '',
    downloaded: [] as string[], downloadGate: Promise.resolve() as Promise<void> }
  let now = Date.now()
  const system = systemHostCiPorts()
  const ports: HostCiPorts = { ...system, now: () => new Date(now), run: async (file, args) => {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (file === 'tailscale') return ok(JSON.stringify({ MagicDNSSuffix: 'tail0000.ts.net',
      Self: { HostName: 'owner-desktop', TailscaleIPs: ['100.90.1.2', 'fd7a::1'] },
      Peer: { a: { HostName: 'builder-Laptop', TailscaleIPs: ['100.90.1.3'] } }, User: { 1: { LoginName: 'owner@example.org' } } }))
    if (file === 'circleci') {
      if (args[0] === 'auth') return ok()
      if (args[0] === 'run' && args[1] === 'trigger') {
        circle.triggered.push([...args])
        return ok(JSON.stringify({ id: `run-${circle.triggered.length}` }))
      }
      if (args[0] === 'run' && args[1] === 'get') {
        if (circle.lookupError) return { code: 1, stdout: '', stderr: circle.lookupError }
        const phantom = Number(args[2]!.slice('run-'.length)) <= circle.phantoms
        return ok(JSON.stringify(phantom ? { phase: 'ended', outcome: 'succeeded', workflows: [] }
          : { workflows: [{ jobs: [{ id: 'job-1' }] }] }))
      }
      if (args[0] === 'run' && args[1] === 'cancel') {
        circle.canceled.push(args[2]!)
        return ok()
      }
      if (args[0] === 'job' && args[1] === 'get') return ok(JSON.stringify({ executions: [{ steps: circle.steps }], ...circle.outcome
        ? { phase: 'ended', outcome: circle.outcome, stopped_at: '2026-10-11T02:00:00Z' } : { phase: 'started' } }))
      if (args[0] === 'job' && args[1] === 'output' && args[2] === 'get') return ok(circle.output)
      // The CLI's default view keeps only each step's last lines.
      if (args[0] === 'job' && args[1] === 'output') {
        return ok(args[args.indexOf('--tail') + 1] === '0' ? 'Suite\nall green\n' : '_… 1 earlier lines hidden_\nall green\n')
      }
      if (args[0] === 'job' && args[1] === 'artifact' && args.includes('--json') && circle.durations) {
        const listed = ['durations/durations.json', ...circle.testResults ? ['durations/test-results.json'] : [],
          'integration-logs/run/slot-1/a.integration.test.ts.log']
        return ok(JSON.stringify(listed.map(path => ({ path, url: `https://artifacts.example/${path}`, execution: 0 }))))
      }
      return { code: 1, stdout: '', stderr: `unexpected circleci ${args.join(' ')}` }
    }
    if (file === 'curl') {
      const url = args.at(-1)!
      circle.downloaded.push(url)
      await circle.downloadGate
      const body = url.endsWith('/durations.json') ? circle.durations : url.endsWith('/test-results.json') ? circle.testResults : 'log'
      await writeFile(args[args.indexOf('-o') + 1]!, JSON.stringify(body))
      return ok()
    }
    if (file !== 'gh') return system.run(file, args)
    if (args[0] === 'auth') return ok()
    if (args[0] === 'workflow') { dispatched.push([...args]); return ok() }
    if (args[0] === 'api') {
      if (github.rateLimited) return { code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\n\r\n{}',
        stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }
      const body = JSON.stringify({ jobs: [{ id: 1, status: github.status === 'completed' ? 'completed' : 'in_progress',
        steps: github.steps }] })
      const etag = `"${createHash('sha1').update(body).digest('hex')}"`
      if (args.some(value => value.startsWith('If-None-Match:') && value.endsWith(etag))) {
        github.jobReads.push('unchanged')
        return { code: 1, stdout: `HTTP/2.0 304 Not Modified\r\nEtag: ${etag}\r\n\r\n`, stderr: 'gh: HTTP 304' }
      }
      github.jobReads.push('full')
      return ok(`HTTP/2.0 200 OK\r\nEtag: W/${etag}\r\n\r\n${body}`)
    }
    if (args[1] === 'list') return ok(JSON.stringify(github.listed))
    if (args[1] === 'cancel') { github.canceled.push(args[2]!); return ok() }
    if (args[1] === 'view' && args.includes('--log')) return ok('ci\tSuite\tall green\n')
    if (args[1] === 'view') return ok(JSON.stringify({ status: github.status, conclusion: github.conclusion, updatedAt: new Date().toISOString() }))
    if (args[1] === 'download') {
      if (!github.durations) return { code: 1, stdout: '', stderr: 'no artifact' }
      const directory = args[args.indexOf('-D') + 1]!
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'durations.json'), JSON.stringify(github.durations))
      if (github.testResults) await writeFile(join(directory, 'test-results.json'), JSON.stringify(github.testResults))
      return ok()
    }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
  } }
  const provider = options.provider === 'circleci' ? new CircleCiProvider(ports) : new GitHubActionsProvider(ports)
  const reopen = () => new CloudCi('main-1', provider, async repository => options.mirror === false ? null
    : repository === 'octo/site' ? 'octo/site-ci' : null, join(root, 'ci-cloud'), ports, git,
    { home: '/home/owner', user: 'owner', host: 'owner-desktop' })
  const cloud = reopen()
  const mirrorGit = (...args: string[]) => run(mirror, ...args)
  return { cloud, reopen, commit, dispatched, github, circle, mirrorGit, run: (...args: string[]) => run(work, ...args),
    advance: (milliseconds: number) => { now += milliseconds },
    write: (path: string, text: string) => writeFile(join(work, path), text),
    push: (...refs: string[]) => run(work, 'push', '-q', origin, ...refs),
    async checkoutMirror(ref: string) {
      const directory = join(root, 'checkout')
      await mkdir(directory)
      run(root, 'clone', '-q', '--no-checkout', mirror, directory)
      run(directory, 'checkout', '-q', '--detach', run(mirror, 'rev-parse', ref))
      return directory
    } }
}

describe('GitHub Actions CI on a public mirror', () => {
  it.each(['github', 'circleci'] as const)('selects changes since an explicit base on the %s runner without publishing private history', async provider => {
    const source = 'apps/api/test/value.ts'
    const test = 'apps/api/test/value.integration.test.ts'
    const f = await fixture({ [source]: 'export const value = 1', [test]: "import './value.js'" }, { provider })
    const baseCommit = f.commit
    await f.write(source, 'export const value = 2')
    f.run('add', '.')
    f.run('commit', '-qm', 'change since release')
    const commit = f.run('rev-parse', 'HEAD')
    f.push('main')
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit,
      baseCommit, suite: 'integration', scope: 'affected', defaultBranch: 'unavailable-branch' })
    const command = (provider === 'github' ? f.dispatched : f.circle.triggered)[0]!
    expect(command).toContain('scope=affected')
    expect(command).toContain('slice=')
    expect(command.some(value => value.startsWith('default_branch='))).toBe(false)
    const runnerBaseCommit = command.find(value => value.startsWith('base_commit='))!.slice('base_commit='.length)
    expect(runnerBaseCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(runnerBaseCommit).not.toBe(baseCommit)
    const checkout = await f.checkoutMirror(`refs/heads/ci/${commit}-${baseCommit}`)
    expect(executionSelection({ commit: 'HEAD', baseCommit: runnerBaseCommit, executionSuite: 'integration',
      defaultRef: 'origin/unavailable-branch', cwd: checkout })).toMatchObject({ scope: 'affected', files: [test] })
    expect(f.mirrorGit('log', '--all', '--format=%s')).not.toContain('private history')
    for (const original of [commit, baseCommit]) expect(() => f.mirrorGit('cat-file', '-e', original)).toThrow()
  })

  it.each(['github', 'circleci'] as const)('dispatches a full suite with a persisted reason for invalid bases on %s', async provider => {
    const f = await fixture({}, { provider })
    f.run('commit', '--allow-empty', '-qm', 'later commit')
    const laterCommit = f.run('rev-parse', 'HEAD')
    f.push('main')
    for (const baseCommit of ['f'.repeat(40), laterCommit]) {
      const runId = randomUUID()
      const started = await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
        baseCommit, suite: 'integration', scope: 'affected' })
      expect(started.operation === 'start' && started.run.message)
        .toBe('Running full suite: baseCommit is unavailable or is not an ancestor of the resolved commit.')
      const command = (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1)!
      expect(command).toContain('scope=full')
      expect(command.some(value => value.startsWith('base_commit='))).toBe(false)
      const read = await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 })
      expect(read.operation === 'read' && read.run.message)
        .toBe('Running full suite: baseCommit is unavailable or is not an ancestor of the resolved commit.')
    }
  })

  it('selects no changes on a cloud runner when the explicit base equals the resolved commit', async () => {
    const f = await fixture()
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      baseCommit: f.commit, suite: 'integration', scope: 'affected' })
    const command = f.dispatched[0]!
    expect(command).toContain('scope=affected')
    const baseCommit = command.find(value => value.startsWith('base_commit='))!.slice('base_commit='.length)
    const checkout = await f.checkoutMirror(`refs/heads/ci/${f.commit}-${f.commit}`)
    expect(executionSelection({ commit: 'HEAD', baseCommit, executionSuite: 'integration', cwd: checkout }))
      .toMatchObject({ scope: 'affected', files: [] })
  })

  it('retries a CircleCI pipeline with no workflow and follows only the replacement workflow', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.phantoms = 1
    const runId = randomUUID()
    const start = { operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition: { index: 0, count: 2 } }
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }
    expect(await f.cloud.handle(start)).toMatchObject({ run: { state: 'starting', step: 'dispatch' } })
    f.advance(74_999)
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'starting' } })
    expect(f.circle.triggered).toHaveLength(1)
    f.advance(1)
    await Promise.all([f.cloud.handle(read), f.cloud.handle(read), f.cloud.handle(start)])
    expect(f.circle.triggered).toHaveLength(2)
    expect(f.circle.triggered[1]).toEqual(f.circle.triggered[0])
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running', step: 'integration' },
      text: expect.stringContaining('Retrying dispatch (2/3)') })
    f.circle.outcome = 'succeeded'
    f.advance(4_000)
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'passed', exitCode: 0 } })
    expect(f.circle.triggered).toHaveLength(2)
  })

  it.each(['github', 'circleci'] as const)('requeues %s after three dispatches create no workflow', async provider => {
    const f = await fixture({}, { provider })
    f.circle.phantoms = Number.POSITIVE_INFINITY
    const runId = randomUUID()
    const start = { operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' }
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }
    await f.cloud.handle(start)
    let cloud = f.cloud
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(75_000)
      cloud = f.reopen()
      await cloud.handle(read)
    }
    expect(await cloud.handle(read)).toMatchObject({ run: { state: 'queued', step: null, exitCode: null,
      finishedAt: null, message: expect.stringContaining('queued for another computer') },
      text: expect.stringContaining('Dispatch retries exhausted') })
    await cloud.handle(start)
    expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(3)
  })

  it('adopts one GitHub run after retrying and cancels duplicate provider runs', async () => {
    const f = await fixture()
    const runId = randomUUID()
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.advance(75_000)
    await f.cloud.handle(read)
    expect(f.dispatched).toHaveLength(2)
    f.github.listed = [{ databaseId: 9, displayTitle: `ci ${runId}` }, { databaseId: 8, displayTitle: `ci ${runId}` }]
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running' } })
    expect(f.github.canceled).toEqual(['9'])
    f.advance(75_000)
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running' } })
    expect(f.dispatched).toHaveLength(2)
  })

  it('adopts a GitHub run that appears at the timeout without dispatching again', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.advance(75_000)
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'running' } })
    expect(f.dispatched).toHaveLength(1)
  })

  it.each(['github', 'circleci'] as const)('cancels an unstarted %s dispatch without triggering a retry', async provider => {
    const f = await fixture({}, { provider })
    f.circle.phantoms = Number.POSITIVE_INFINITY
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.advance(75_000)
    expect(await f.cloud.handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'canceled' } })
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'canceled' } })
    expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(1)
  })

  it.each(['github', 'circleci'] as const)('leaves omitted files for the %s runner and mirrors the default-branch merge-base without private history', async provider => {
    const source = 'apps/api/test/value.ts'
    const test = 'apps/api/test/value.integration.test.ts'
    const f = await fixture({ [source]: 'export const value = 1', [test]: "import './value.js'" }, { provider })
    f.run('branch', 'release/stable')
    f.push('release/stable')
    f.run('checkout', '-qb', 'feature')
    await f.write(source, 'export const value = 2')
    f.run('add', '.')
    f.run('commit', '-qm', 'feature change')
    const commit = f.run('rev-parse', 'HEAD')
    f.push('feature')
    const partition = { index: 1, count: 2, weights: [2, 1] }
    const durations = { [test]: 500 }
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit,
      suite: 'integration', defaultBranch: 'release/stable', partition, durations })
    const command = (provider === 'github' ? f.dispatched : f.circle.triggered)[0]!
    expect(command).toContain('scope=affected')
    expect(command).toContain('slice=')
    expect(command).toContain(`default_branch=ci-default/${commit}`)
    expect(command).toContain(`partition=${JSON.stringify(partition)}`)
    expect(command).toContain(`durations=${JSON.stringify(durations)}`)
    expect(command.some(value => value.startsWith('files='))).toBe(false)
    const branch = `refs/heads/ci/${commit}`
    const defaultBranch = `refs/heads/ci-default/${commit}`
    const base = f.mirrorGit('merge-base', branch, defaultBranch)
    expect(f.mirrorGit('diff', '--name-only', base, branch)).toBe(source)
    expect(f.mirrorGit('log', '--all', '--format=%s')).not.toContain('private history')
    expect(() => f.mirrorGit('cat-file', '-e', commit)).toThrow()
    const checkout = await f.checkoutMirror(branch)
    expect(affectedSnapshot('HEAD', 'integration', checkout, `origin/ci-default/${commit}`))
      .toMatchObject({ scope: 'affected', files: [test] })
  })

  it('mirrors the default branch head as the same comparison commit so the cloud selector reports a full run', async () => {
    const f = await fixture()
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration' })
    const branch = `refs/heads/ci/${f.commit}`
    expect(f.mirrorGit('rev-parse', branch)).toBe(f.mirrorGit('rev-parse', `refs/heads/ci-default/${f.commit}`))
    const checkout = await f.checkoutMirror(branch)
    expect(affectedSnapshot('HEAD', 'integration', checkout, `origin/ci-default/${f.commit}`))
      .toMatchObject({ scope: 'full', reason: 'The commit is the workspace default branch head.' })
  })

  it.each(['github', 'circleci'] as const)('declines %s when its mirror lacks workflow files without publishing', async provider => {
    const f = await fixture({}, { provider, mirrorWorkflows: false })
    const head = f.mirrorGit('rev-parse', 'main')
    await expect(f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
    expect(f.mirrorGit('rev-parse', 'main')).toBe(head)
  })

  it.each(['github', 'circleci'] as const)('preserves both mirror workflows for a repository without them on %s', async provider => {
    const manifest = JSON.stringify({ scripts: { build: 'node build.mjs', lint: 'node lint.mjs', unit: 'node unit.mjs' } })
    const f = await fixture({ 'package.json': manifest }, { provider, sourceWorkflows: false })
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: provider === 'github' ? 'build' : 'integration' })
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(`suite=${provider === 'github' ? 'build' : 'integration'}`)
    expect(commands[0]).toContain('slice=')
    expect(f.mirrorGit('show', 'main:package.json')).toBe(manifest)
    expect(f.mirrorGit('show', 'main:.github/workflows/ci.yml')).toBe('name: CI\non: workflow_dispatch')
    expect(f.mirrorGit('show', 'main:.circleci/config.yml')).toBe('version: 2.1')
    expect(() => f.mirrorGit('cat-file', '-e', f.commit)).toThrow()
  })

  it.each(['github', 'circleci'] as const)('refuses a host partition on %s before publishing or dispatching', async provider => {
    const f = await fixture({}, { provider })
    const head = f.mirrorGit('rev-parse', 'main')
    await expect(f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 0, count: 2, hostIndexes: [0] } })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
    expect(f.mirrorGit('rev-parse', 'main')).toBe(head)
  })

  it.each(['github', 'circleci'] as const)('excludes installed Worker and systemd files from %s cloud slices', async provider => {
    const installed = [
      'apps/api/test/workflow-systemd-restart.integration.test.ts',
      'apps/api/test/native-service-restart.integration.test.ts',
      'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    ]
    const f = await fixture(Object.fromEntries(installed.map(file => [file, ''])), { provider })
    const ordinary = ['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)
    const inventory = [...ordinary, ...installed].sort()
    await f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition: { index: 1, count: 2, hostIndexes: [0] } })
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    expect(commands).toHaveLength(1)
    const slice = selectByIndexes(inventory, commands[0]!.find(value => value.startsWith('slice='))!.slice('slice='.length))
    expect(slice.length).toBeGreaterThan(0)
    expect(slice.every(file => ordinary.includes(file))).toBe(true)
  })

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
        suite: 'integration', scope: 'full', durations, partition: { index, count: 4, weights: [8, 1, 1, 1] } })
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
      suite: 'unit', scope: 'full', part: 'unit-web', partition: { index: 1, count: 3 } })
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
    expect(command).toContain('files=s:6')
  })

  it.each(['github'] as const)('reads measured unit durations from %s artifacts', async provider => {
    const f = await fixture({}, { provider })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', scope: 'full', part: 'unit-api', partition: { index: 0, count: 5 } })
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
  it.each(['github', 'circleci'] as const)('reads integration test results from %s artifacts', async provider => {
    const f = await fixture({}, { provider })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    const durations = { 'apps/api/test/a.integration.test.ts': 250 }
    const testResults = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false, files: [
      { file: 'apps/api/test/a.integration.test.ts', status: 'failed', durationMs: 250,
        tests: [{ name: 'a saves', status: 'failed', durationMs: 20, message: 'expected 1 to be 2' }] }] }
    f.github.listed = [{ databaseId: 9, displayTitle: `ci ${runId}` }]
    f.github.status = 'completed'
    f.github.conclusion = 'failure'
    f.circle.outcome = 'failed'
    for (const service of [f.github, f.circle]) Object.assign(service, { durations, testResults })
    const read = await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true,
      testResults: true })
    expect(read).toMatchObject({ run: { state: 'failed' }, durations, testResults })
    // A restarted Main still answers from the kept result; a read that does not ask for test results stays lean.
    const plain = await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true })
    expect(plain.operation === 'read' && 'testResults' in plain).toBe(false)
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, testResults: true }))
      .toMatchObject({ testResults })
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
    expect(command).toContain('files=s:6')
  })
  it('keeps a newly accepted CircleCI pipeline starting until its run becomes visible', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'run.not_found'
    const runId = randomUUID()
    expect(await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })).toMatchObject({ run: { state: 'starting' } })
    f.advance(74_999)
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'starting' } })
    expect(f.circle.triggered).toHaveLength(1)
    f.circle.lookupError = ''
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'running' } })
  })

  it.each(['expired', 'started', 'other error'] as const)(
    'does not suppress CircleCI lookup failures for %s pipelines', async kind => {
      const f = await fixture({}, { provider: 'circleci' })
      f.circle.lookupError = kind === 'other error' ? 'permission denied' : kind === 'expired' ? 'run.not_found' : ''
      const runId = randomUUID()
      await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
        suite: 'integration', scope: 'full' })
      if (kind === 'expired') f.advance(75_000)
      if (kind === 'started') f.circle.lookupError = 'run.not_found'
      await expect(f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
        .rejects.toMatchObject({ code: kind === 'other error' ? 'CI_CLOUD_FAILED' : 'CI_CLOUD_RUN_NOT_FOUND' })
    })

  it('publishes only the commit files, then dispatches one run with its partition slice', async () => {
    const f = await fixture()
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition: { index: 0, count: 2 } })
    expect(started).toMatchObject({ operation: 'start', run: { runId, state: 'starting' } })
    const branch = `refs/heads/ci/${f.commit}`
    // Same files, one new commit on the mirror's import; the private history never leaves.
    expect(f.mirrorGit('rev-parse', `${branch}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
    expect(f.mirrorGit('rev-list', '--count', branch)).toBe('2')
    expect(() => f.mirrorGit('cat-file', '-e', f.commit)).toThrow()
    expect(f.mirrorGit('rev-parse', 'refs/heads/main')).toBe(f.mirrorGit('rev-parse', branch))
    expect(f.dispatched).toEqual([['workflow', 'run', 'ci.yml', '-R', 'octo/site-ci', '--ref', 'main', '-f', `ref=ci/${f.commit}`,
      '-f', `run_id=${runId}`, '-f', 'suite=integration',
      '-f', 'slice=s:0,3', '-f', 'scope=full']])
    // A retried start returns the same run without dispatching again.
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 0, count: 2 } })
    expect(f.dispatched).toHaveLength(1)
  })

  it('publishes concurrent runs of different commits from two services to one mirror without losing a push', async () => {
    const f = await fixture()
    const commits: string[] = []
    for (const name of ['one', 'two', 'three', 'four', 'five', 'six']) {
      await f.write(`${name}.txt`, `${name}\n`); f.run('add', '.'); f.run('commit', '-qm', name)
      commits.push(f.run('rev-parse', 'HEAD')); f.push(`HEAD:refs/heads/${name}`)
    }
    const other = f.reopen()
    const started = await Promise.allSettled(commits.map((commit, index) => (index % 2 ? other : f.cloud).handle({
      operation: 'start', runId: randomUUID(), repository: 'octo/site', commit, suite: 'unit' })))
    expect(started.map(result => result.status === 'rejected' ? String(result.reason) : 'started'))
      .toEqual(commits.map(() => 'started'))
    for (const commit of commits) {
      expect(f.mirrorGit('rev-parse', `refs/heads/ci/${commit}^{tree}`)).toBe(f.run('rev-parse', `${commit}^{tree}`))
    }
    expect(commits.map(commit => f.mirrorGit('rev-parse', `refs/heads/ci/${commit}`)))
      .toContain(f.mirrorGit('rev-parse', 'refs/heads/main'))
  })

  it("reports git's reason when the mirror cannot be read", async () => {
    const f = await fixture()
    f.mirrorGit('update-ref', '-d', 'refs/heads/main')
    await expect(f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_CLOUD_FAILED',
      message: expect.stringMatching(/^git fetch failed for the CI mirror\. .*main/) })
    expect(f.dispatched).toEqual([])
  })

  it('follows the GitHub run to its result, log and measured durations', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 1, count: 2 } })
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
    expect(await read()).toMatchObject({ run: { state: 'starting' } })
    f.github.listed = [{ databaseId: 7, displayTitle: 'ci another' }, { databaseId: 8, displayTitle: `ci ${runId}` }]
    expect(await read()).toMatchObject({ run: { state: 'running', step: 'integration' } })
    f.github.status = 'completed'; f.github.conclusion = 'success'
    f.github.durations = { 'apps/api/test/b.integration.test.ts': 250 }
    f.advance(4_000)
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

  it('leaves the podman Worker unit tests on CircleCI to the other computers', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    await expect(f.cloud.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-other' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.circle.triggered).toEqual([])
  })

  it('runs the same published files on CircleCI and reads its result, log and durations back', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    expect(await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 1, count: 2 } })).toMatchObject({ run: { runId, state: 'running' } })
    expect(f.mirrorGit('rev-parse', `refs/heads/ci/${f.commit}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
    expect(f.circle.triggered).toEqual([['run', 'trigger', '--project', 'gh/octo/site-ci', '--branch', `ci/${f.commit}`,
      '--parameter', `run_id=${runId}`, '--parameter', 'suite=integration',
      '--parameter', 'slice=s:1-2', '--parameter', 'scope=full', '--json']])
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
    expect(await read()).toMatchObject({ run: { state: 'running' } })
    f.circle.outcome = 'failed'; f.circle.durations = { 'apps/api/test/c.integration.test.ts': 180 }
    f.advance(4_000)
    expect(await read()).toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: '2026-10-11T02:00:00Z' },
      text: 'Suite\nall green\n', durations: { 'apps/api/test/c.integration.test.ts': 180 } })
  })

  it('downloads only the durations artifacts of a finished CircleCI job', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    const testResults = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false, files: [
      { file: 'apps/api/test/a.integration.test.ts', status: 'failed', durationMs: 90,
        tests: [{ name: 'a saves', status: 'failed', durationMs: 20, message: 'expected 1 to be 2' }] }] }
    Object.assign(f.circle, { outcome: 'failed', durations: { 'apps/api/test/a.integration.test.ts': 90 }, testResults })
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true, testResults: true }))
      .toMatchObject({ run: { state: 'failed' }, durations: { 'apps/api/test/a.integration.test.ts': 90 }, testResults })
    expect(f.circle.downloaded).toEqual(['https://artifacts.example/durations/durations.json',
      'https://artifacts.example/durations/test-results.json'])
  })

  it('answers a read from the kept log while another read is still collecting the finished run', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    let release!: () => void
    f.circle.downloadGate = new Promise(resolve => { release = resolve })
    Object.assign(f.circle, { outcome: 'failed', durations: { 'apps/api/test/a.integration.test.ts': 90 } })
    const collecting = f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
    await expect.poll(() => f.circle.downloaded.length).toBe(1)
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
      .toMatchObject({ run: { state: 'running' }, text: 'Suite\nall green\n' })
    release()
    expect(await collecting).toMatchObject({ run: { state: 'failed' }, text: 'Suite\nall green\n',
      durations: { 'apps/api/test/a.integration.test.ts': 90 } })
  })

  it('shows the running GitHub step live and asks GitHub again only when its jobs changed', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
    f.github.steps = [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'Cache', status: 'completed', conclusion: 'skipped' },
      { number: 3, name: 'Suite', status: 'in_progress', conclusion: null }]
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
    expect(await read()).toMatchObject({ run: { state: 'running', step: 'Suite' }, text: '==> Set up job\n==> Suite\n' })
    // Reads within the poll interval answer from the kept state without asking GitHub.
    expect(await read()).toMatchObject({ run: { step: 'Suite' } })
    expect(f.github.jobReads).toEqual(['full'])
    f.advance(4_000)
    expect(await read()).toMatchObject({ run: { step: 'Suite' }, text: '==> Set up job\n==> Suite\n' })
    expect(f.github.jobReads).toEqual(['full', 'unchanged'])
    f.github.steps[2] = { number: 3, name: 'Suite', status: 'completed', conclusion: 'failure' }
    f.github.status = 'completed'; f.github.conclusion = 'failure'
    f.advance(4_000)
    const done = await read()
    expect(done).toMatchObject({ run: { state: 'failed', step: 'integration' } })
    expect(done.operation === 'read' && done.text).toBe(
      '==> Set up job\n==> Suite\n==> Suite failed\n--- GitHub Actions log ---\nci\tSuite\tall green\n')
  })

  it('streams the running CircleCI step output into the log as it grows', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    f.circle.steps = [{ num: 101, name: 'Checkout code', phase: 'ended', outcome: 'succeeded' },
      { num: 108, name: 'Suite', phase: 'started' }]
    f.circle.output = 'a.test passed\n'
    const read = (afterOffset = 0) => f.cloud.handle({ operation: 'read', runId, afterOffset, maxBytes: 65_536 })
    const first = await read()
    expect(first).toMatchObject({ run: { state: 'running', step: 'Suite' }, text: '==> Checkout code\n==> Suite\na.test passed\n' })
    f.circle.output += 'b.test passed\n'
    f.advance(4_000)
    expect(await read(first.operation === 'read' ? first.nextOffset : 0)).toMatchObject({ text: 'b.test passed\n' })
  })

  it('pauses polling while the service rate limit is spent and resumes after the backoff', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
    expect(await read()).toMatchObject({ run: { state: 'running' } })
    f.github.rateLimited = true
    f.advance(4_000)
    expect(await read()).toMatchObject({ run: { state: 'running' } })
    f.github.rateLimited = false
    f.github.status = 'completed'; f.github.conclusion = 'success'
    const reads = f.github.jobReads.length
    f.advance(29_000)
    expect(await read()).toMatchObject({ run: { state: 'running' } })
    expect(f.github.jobReads).toHaveLength(reads)
    f.advance(1_000)
    expect(await read()).toMatchObject({ run: { state: 'passed' } })
  })
})
