import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { selectByIndexes } from '../../../../../scripts/ci-files.mjs'
import { affectedSnapshot } from '../../../../../scripts/ci-affected.mjs'
import { executionSelection } from '../../../../../scripts/ci-selection.mjs'
import { cloudService } from './cloudService.testSupport.js'

import { fixture } from './cloud.testSupport.js'
import { CircleCiProvider, type CloudDispatchInput } from './cloudProviders.js'
import { systemHostCiPorts } from './runner.js'

it.each([undefined, 221366])('sends declared CircleCI pipeline parameters with compatible types: %s', async duration => {
  const config = parse(await readFile(new URL('../../../../../.circleci/config.yml', import.meta.url), 'utf8')) as {
    parameters: Record<string, { type: string; enum?: unknown[] }>
  }
  const commands: string[][] = []
  const provider = new CircleCiProvider({ ...systemHostCiPorts(), run: async (_file, args) => {
    commands.push([...args])
    return { code: 0, stdout: JSON.stringify({ id: 'pipeline' }), stderr: '' }
  } })
  const input: CloudDispatchInput = {
    mirror: 'octo/site-ci', branch: 'main', runId: 'ticket', suite: 'integration', slice: 's:1-2',
    ...(duration === undefined ? {} : { expectedDurationMs: duration }),
    scope: 'affected', files: 's:3-4', defaultBranch: 'main', baseCommit: 'a'.repeat(40),
    partition: JSON.stringify({ index: 0, count: 2 }), durations: JSON.stringify({ 'sample.test.ts': 100 }),
  }
  await provider.dispatch(input)
  const parameters = Object.fromEntries(commands[0]!.flatMap((argument, index, args) => {
    if (argument !== '--parameter') return []
    const parameter = args[index + 1]!
    const separator = parameter.indexOf('=')
    const name = parameter.slice(0, separator)
    const text = parameter.slice(separator + 1)
    // The CLI converts integer arguments to JSON numbers before triggering the pipeline.
    const value = /^-?\d+$/.test(text) ? Number(text) : text
    return [[name, value]]
  }))
  expect(Object.keys(parameters).sort()).toEqual(Object.keys(config.parameters).sort())
  for (const [name, value] of Object.entries(parameters)) {
    const declaration = config.parameters[name]!
    const type = typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value
    expect(type, `CircleCI parameter ${name}`).toBe(declaration.type === 'enum' ? 'string' : declaration.type)
    if (declaration.enum) expect(declaration.enum).toContain(value)
  }
  expect(parameters.expected_duration_ms).toBe(duration ?? 0)
})

it.each([false, true])('fails an ended CircleCI pipeline with errors on the next read, workflow started: %s', async started => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.phantoms = started ? 0 : 1
  const runId = randomUUID()
  const start = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' }
  const reply = await f.cloud.handle(start)
  if (reply.operation !== 'start') throw new Error('Expected a start reply')
  const message = 'Type error for argument expected_duration_ms: expected type: string, actual value: "221366" (type integer)'
  f.circle.runView = { phase: 'ended', current_outcome: 'not_run', errors: [{ type: 'config', message }], workflows: [] }
  const main = cloudService(f.cloud, reply.run, f.commit)
  await main.service.dispatch()
  expect(await main.read()).toMatchObject({ run: { state: 'failed', exitCode: 1, message: expect.stringContaining(message) } })
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
    .toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: expect.any(String) },
      text: expect.stringContaining(`config: ${message}`) })
  expect(f.circle.triggered).toHaveLength(1)
})

function expectMirrorDispatch(provider: 'github' | 'circleci', command: string[] | undefined) {
  const option = provider === 'github' ? '-R' : '--project'
  const target = provider === 'github' ? 'octo/site-ci' : 'gh/octo/site-ci'
  const optionIndex = command?.indexOf(option) ?? -1
  expect(optionIndex).toBeGreaterThanOrEqual(0)
  expect(command?.[optionIndex + 1]).toBe(target)
}

describe('GitHub Actions CI on a public mirror', () => {
  it('shares one publication across concurrent starts of the same commit', async () => {
    const f = await fixture()
    const git = vi.spyOn(f.git, 'git')
    const services = [f.cloud, f.reopen()]
    const replies = await Promise.all(Array.from({ length: 8 }, (_, index) => services[index % services.length]!.handle({
      operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'lint', scope: 'full',
    })))
    expect(replies).toHaveLength(8)
    for (const reply of replies) expect(reply).toMatchObject({ operation: 'start', run: { state: 'starting' } })
    expect(f.dispatched).toHaveLength(8)
    const publications = git.mock.calls.filter(([args]) => args[0] === 'push' && args.includes('--force'))
    expect(publications).toHaveLength(1)
  })

  it('dispatches every concurrent start while stale-branch pruning is blocked', async () => {
    const f = await fixture()
    f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let pruning = false
    f.cloud.setActiveRunLookup(async () => {
      pruning = true
      await blocked
      return { ids: new Set<string>(), readAt: 0 }
    })
    let completed = 0
    const starts = Promise.all(Array.from({ length: 8 }, () => f.cloud.handle({
      operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'lint', scope: 'full',
    }).then(reply => {
      completed++
      return reply
    })))
    try {
      await expect.poll(() => pruning, { timeout: 5_000 }).toBe(true)
      await expect.poll(() => f.dispatched.length, { timeout: 5_000 }).toBe(8)
      await expect.poll(() => completed, { timeout: 5_000 }).toBe(8)
    } finally {
      release()
      await starts
    }
    await expect.poll(() => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'), { timeout: 5_000 })
      .not.toContain('refs/heads/ci/retired-run')
    expect(f.mirrorGit('rev-parse', `refs/heads/ci/${f.commit}`)).toMatch(/^[a-f0-9]{40}$/)
  })

  it('limits background pruning to once every five minutes per mirror', async () => {
    const f = await fixture()
    f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
    let sweeps = 0
    f.cloud.setActiveRunLookup(async () => {
      sweeps++
      return { ids: new Set<string>(), readAt: 0 }
    })
    const start = () => f.cloud.handle({
      operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'lint', scope: 'full',
    })
    await start()
    await expect.poll(() => sweeps, { timeout: 5_000 }).toBe(1)
    await expect.poll(() => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'), { timeout: 5_000 })
      .not.toContain('refs/heads/ci/retired-run')
    await Promise.all(Array.from({ length: 8 }, start))
    expect(sweeps).toBe(1)
    f.advance(5 * 60_000)
    await start()
    await expect.poll(() => sweeps, { timeout: 5_000 }).toBe(2)
  })

  it('uses the admitted mirror even when the workspace settings no longer provide one', async () => {
    const f = await fixture({}, { mirror: false })
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', ciMirror: 'octo/site-ci',
      runId: randomUUID(), repository: 'octo/site', commit: f.commit, suite: 'unit' })
    expect(f.dispatched[0]).toContain('octo/site-ci')
  })

  it('refuses cloud publication when admission explicitly recorded no mirror', async () => {
    const f = await fixture()
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', ciMirror: null,
      runId: randomUUID(), repository: 'octo/site', commit: f.commit, suite: 'unit' }))
      .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toEqual([])
  })

  it.each(['unit', 'integration'] as const)('declines oversized fragmented %s selections without retaining a start', async suite => {
    const candidates = Array.from({ length: 400 }, (_, index) =>
      `apps/api/test/fragment${String(index).padStart(3, '0')}.${suite === 'integration' ? 'integration.' : ''}test.ts`)
    const f = await fixture(Object.fromEntries(candidates.map(file => [file, ''])), { provider: 'circleci' })
    const runId = randomUUID()
    const files = candidates.filter((_, index) => index % 2 === 0)
    const request = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite, scope: 'affected', files }
    await expect(f.cloud.handle(request)).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.circle.triggered).toEqual([])
    // Reusing the id after a declined placement must still dispatch the caller's valid selection.
    expect(await f.reopen().handle({ ...request, files: files.slice(0, 1) }))
      .toMatchObject({ run: { state: 'running' } })
    expect(f.circle.triggered).toHaveLength(1)
    const input = f.circle.triggered[0]!.find(value => value.startsWith(suite === 'unit' ? 'files=' : 'slice='))!
    const inventory = f.run('ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()
      .filter(file => suite === 'unit' || file.endsWith('.integration.test.ts'))
    expect(selectByIndexes(inventory, input.slice(input.indexOf('=') + 1))).toEqual(files.slice(0, 1))
  })

  it.each([
    ['started', false], ['failed', false], ['started', true], ['failed', true],
  ] as const)('waits for the second CircleCI job when it is %s in a separate workflow: %s', async (phase, separate) => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.runView = { workflows: separate ? [{ jobs: [{ id: 'first' }] }, { jobs: [{ id: 'second' }] }]
      : [{ jobs: [{ id: 'first' }, { id: 'second' }] }] }
    f.circle.jobDetails.first = { phase: 'ended', outcome: 'succeeded' }
    f.circle.jobDetails.second = phase === 'started' ? { phase: 'started' } : { phase: 'ended', outcome: 'failed' }
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    if (started.operation !== 'start') throw new Error('Expected a start reply')
    const main = cloudService(f.cloud, started.run, f.commit)
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
    await main.service.dispatch()
    expect(await main.read()).toMatchObject({ run: { state: phase === 'started' ? 'running' : 'failed' } })
    if (phase === 'started') {
      f.circle.jobDetails.second = { phase: 'ended', outcome: 'failed' }
      f.advance(4_000)
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'failed', exitCode: 1 } })
    }
  })

  it('settles a terminal jobless CircleCI workflow instead of waiting forever', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.runView = { phase: 'ended', outcome: 'failed', workflows: [{ phase: 'ended', outcome: 'failed', jobs: [] }] }
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
      .toMatchObject({ run: { state: 'failed', exitCode: 1 } })
  })

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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit,
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
      const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
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
    const start = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
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
    const start = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.advance(75_000)
    expect(await f.cloud.handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'canceled' } })
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'canceled' } })
    expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(1)
  })

  it('waits for mirror cleanup and its queued cancellation sweep before disposing the fixture', async () => {
    const f = await fixture()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let sweeps = 0
    f.cloud.setActiveRunLookup(async () => {
      sweeps++
      await blocked
      return { ids: new Set<string>(), readAt: 0 }
    })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    await expect.poll(() => sweeps).toBe(1)
    f.advance(5 * 60_000)
    await f.cloud.handle({ operation: 'cancel', runId })
    const disposal = f.dispose()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const waiting = await Promise.race([
        disposal.then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), 1_000) }),
      ])
      expect(waiting).toBe(true)
    } finally {
      clearTimeout(timer)
      release()
      await disposal
    }
    expect(sweeps).toBe(2)
    expect(f.dispatched).toHaveLength(1)
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
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
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
    expect(f.mirrorGit('rev-parse', 'main')).toBe(head)
  })

  it.each(['github', 'circleci'] as const)('preserves both mirror workflows for a repository without them on %s', async provider => {
    const manifest = JSON.stringify({ scripts: { build: 'node build.mjs', lint: 'node lint.mjs', unit: 'node unit.mjs' } })
    const f = await fixture({ 'package.json': manifest }, { provider, sourceWorkflows: false })
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
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
    const f = await fixture({}, { provider, userSystemd: false })
    const head = f.mirrorGit('rev-parse', 'main')
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 0, count: 2, hostIndexes: [0] } })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
    expect(f.mirrorGit('rev-parse', 'main')).toBe(head)
  })

  it.each(['github', 'circleci'] as const)('runs installed Worker fixtures but excludes user-systemd files on %s', async provider => {
    const systemd = [
      'apps/api/test/workflow-systemd-restart-active.integration.test.ts',
      'apps/api/test/native-service-restart.integration.test.ts',
    ]
    const cloud = [
      'apps/api/test/workflow-systemd-restart.integration.test.ts',
      'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    ]
    const f = await fixture(Object.fromEntries([...systemd, ...cloud].map(file => [file, ''])), { provider })
    const ordinary = [...cloud, ...['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)]
    const inventory = [...ordinary, ...systemd].sort()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition: { index: 1, count: 2, hostIndexes: [0] } })
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    expect(commands).toHaveLength(1)
    const slice = selectByIndexes(inventory, commands[0]!.find(value => value.startsWith('slice='))!.slice('slice='.length))
    expect(slice.sort()).toEqual(ordinary.sort())
  })

  it.each(['github', 'circleci'] as const)('rejects user-systemd files without host metadata on %s', async provider => {
    const file = 'apps/api/test/native-service-restart.integration.test.ts'
    const f = await fixture({ [file]: '' }, { provider, userSystemd: false })
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'affected', files: [file] }))
      .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'affected', files: [file], partition: { index: 0, count: 2 } }))
      .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
  })

  it.each(['github', 'circleci'] as const)('dispatches systemd slices and single files when %s declares support', async provider => {
    const file = 'apps/api/test/native-service-restart.integration.test.ts'
    const f = await fixture({ [file]: '' }, { provider })
    expect(f.cloud.computers()[0]?.userSystemd).toEqual({ supported: true, reason: null })
    expect(await f.cloud.handle({ operation: 'status' }))
      .toMatchObject({ userSystemd: { supported: true, reason: null } })
    for (const partition of [undefined, { index: 0, count: 2, hostIndexes: [0] }]) {
      await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
        commit: f.commit, suite: 'integration', scope: 'affected', files: [file],
        ...(partition ? { partition } : {}) })
    }
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    expect(commands).toHaveLength(2)
    for (const command of commands) {
      const slice = command.find(value => value.startsWith('slice='))!.slice('slice='.length)
      const inventory = ['a', 'b', 'c', 'd', 'native-service-restart']
        .map(name => `apps/api/test/${name}.integration.test.ts`).sort()
      expect(selectByIndexes(inventory, slice)).toEqual([file])
    }
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
      await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', scope: 'full', part: 'unit-web', partition: { index: 1, count: 3 } })
    const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
    expect(command).toContain('suite=unit-web')
    expect(command).toContain('slice=2/3')
  })

  it.each(['github'] as const)('passes already sharded affected files to the unit part through %s', async provider => {
    const f = await fixture({ 'apps/api/test/feature.test.ts': 'export {}' }, { provider })
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'affected', files, partition: { index: 0, count: 2 } })
    expect(f.dispatched[0]).toContain('slice=s:1')
    expect(f.dispatched[0]).toContain('scope=affected')
  })

  it.each(['github'] as const)('passes affected unit scope and compact file indexes through %s', async provider => {
    const f = await fixture({ 'apps/api/test/feature.test.ts': 'export {}' }, { provider })
    const files = ['apps/api/test/feature.test.ts']
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', scope: 'affected', files })
    const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
    expect(command).toContain('scope=affected')
    expect(command).toContain('files=s:6')
  })
  it('keeps a newly accepted CircleCI pipeline starting until its run becomes visible', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'run.not_found'
    const runId = randomUUID()
    expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })).toMatchObject({ run: { state: 'starting' } })
    f.advance(74_999)
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'starting' } })
    expect(f.circle.triggered).toHaveLength(1)
    f.circle.lookupError = ''
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'running' } })
  })

  it('persists missing CircleCI recovery in Main until explicit cancellation resolves ownership', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'run.not_found'
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    if (started.operation !== 'start') throw new Error('Expected a start reply')
    const main = cloudService(f.cloud, started.run, f.commit)
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(75_000)
      await f.reopen().handle(read)
      await main.service.dispatch()
    }
    expect(await main.read()).toMatchObject({ run: { state: 'starting', computer: { label: 'CircleCI' },
      message: expect.stringContaining('Operator cancellation is required') } })
    expect(f.circle.triggered).toHaveLength(1)
    expect(f.circle.canceled).toEqual([])
    expect(await f.reopen().handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'canceled' } })
    await main.service.dispatch()
    expect(await main.read()).toMatchObject({ run: { state: 'canceled' } })
  })

  it('recovers a transiently missing CircleCI lookup before its reconciliation budget is spent', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'run.not_found'
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
    f.advance(75_000)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null,
      message: expect.stringContaining('could not be reconciled') } })
    f.circle.lookupError = ''
    f.circle.outcome = 'failed'
    f.advance(4_000)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'failed', exitCode: 1 } })
    expect(f.circle.triggered).toHaveLength(1)
    expect(f.circle.canceled).toEqual([])
  })

  it.each(['starting', 'running'] as const)(
    'cancels the known CircleCI pipeline from %s when discovery is unavailable and persists the cancellation',
    async state => {
      const f = await fixture({}, { provider: 'circleci' })
      if (state === 'starting') f.circle.phantoms = Number.POSITIVE_INFINITY
      const runId = randomUUID()
      expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
        repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' }))
        .toMatchObject({ run: { state } })
      f.circle.lookupError = 'run.not_found'
      f.advance(75_000)
      const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state, finishedAt: null } })
      expect(await f.reopen().handle({ operation: 'cancel', runId }))
        .toMatchObject({ operation: 'cancel', run: { state: 'canceled', message: 'Canceled.' } })
      expect(f.circle.canceled).toEqual(['run-1'])
      expect(await f.reopen().handle({ operation: 'cancel', runId }))
        .toMatchObject({ run: { state: 'canceled' } })
      f.advance(4_000)
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled' } })
      expect(f.circle.canceled).toEqual(['run-1'])
      expect(f.circle.triggered).toHaveLength(1)
    },
  )

  it('retains ownership and exposes bounded reconciliation when a started CircleCI pipeline disappears', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.circle.lookupError = 'run.not_found'
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(4_000)
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null,
        message: expect.stringContaining('could not be reconciled') } })
    }
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running',
      message: expect.stringContaining('Operator cancellation is required') } })
    expect(f.circle.triggered).toHaveLength(1)
    expect(f.circle.canceled).toEqual([])
    expect(await f.reopen().handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'canceled' } })
  })

  it('does not suppress CircleCI permission failures', async () => {
      const f = await fixture({}, { provider: 'circleci' })
      f.circle.lookupError = 'permission denied'
      const runId = randomUUID()
      await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
        suite: 'integration', scope: 'full' })
      await expect(f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
        .rejects.toMatchObject({ code: 'CI_CLOUD_FAILED' })
    })

  it('publishes only the commit files, then dispatches one run with its partition slice', async () => {
    const f = await fixture()
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition: { index: 0, count: 2 } })
    expect(started).toMatchObject({ operation: 'start', run: { runId, state: 'starting' } })
    const branch = `refs/heads/ci/${f.commit}`
    // Same files, one new commit on the mirror's import; the private history never leaves.
    expect(f.mirrorGit('rev-parse', `${branch}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
    expect(f.mirrorGit('rev-list', '--count', branch)).toBe('2')
    expect(() => f.mirrorGit('cat-file', '-e', f.commit)).toThrow()
    expect(f.mirrorGit('rev-parse', 'refs/heads/main')).toBe(f.mirrorGit('rev-parse', branch))
    const workflowRef = `ci-snapshot/${f.mirrorGit('rev-parse', branch)}`
    expect(f.dispatched).toEqual([['workflow', 'run', 'ci.yml', '-R', 'octo/site-ci', '--ref', workflowRef, '-f', `ref=${workflowRef}`,
      '-f', `run_id=${runId}`, '-f', 'suite=integration',
      '-f', 'slice=s:0,3', '-f', 'expected_duration_ms=0', '-f', 'scope=full']])
    // A retried start returns the same run without dispatching again.
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
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
      operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit, suite: 'unit' })))
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
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_CLOUD_FAILED',
      message: expect.stringMatching(/^git fetch failed for the CI mirror\. .*main/) })
    expect(f.dispatched).toEqual([])
  })

  it('follows the GitHub run to its result, log and measured durations', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
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
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_MIRROR_PRIVATE_DATA', message: expect.stringContaining(Object.keys(files)[0]!) })
    expect(() => f.mirrorGit('rev-parse', '--verify', `refs/heads/ci/${f.commit}`)).toThrow()
    expect(f.dispatched).toEqual([])
  })

  it('leaves a run without a mirror to the build computers', async () => {
    const f = await fixture({}, { mirror: false })
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
  })

  it('leaves the podman Worker unit tests on CircleCI to the other computers', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-other' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.circle.triggered).toEqual([])
  })

  it('runs the same published files on CircleCI and reads its result, log and durations back', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 1, count: 2 } })).toMatchObject({ run: { runId, state: 'running' } })
    const snapshot = f.mirrorGit('rev-parse', `refs/heads/ci/${f.commit}`)
    const workflowRef = `ci-snapshot/${snapshot}`
    expect(f.mirrorGit('rev-parse', `${workflowRef}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { provenance: { sourceCommit: f.commit, workflowCommit: snapshot, workflowRef } } })
    expect(f.circle.triggered).toEqual([['run', 'trigger', '--project', 'gh/octo/site-ci', '--branch', workflowRef,
      '--parameter', `run_id=${runId}`, '--parameter', 'suite=integration',
      '--parameter', 'slice=s:1-2', '--parameter', 'expected_duration_ms=0', '--parameter', 'scope=full', '--json']])
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    let release!: () => void
    f.circle.downloadGate = new Promise(resolve => { release = resolve })
    Object.assign(f.circle, { outcome: 'failed', durations: { 'apps/api/test/a.integration.test.ts': 90 } })
    const collecting = f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
    await expect.poll(() => f.circle.downloaded.length).toBe(1)
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
      .toMatchObject({ run: { state: 'failed', collection: 'pending' }, text: 'Suite\nall green\n' })
    release()
    expect(await collecting).toMatchObject({ run: { state: 'failed' }, text: 'Suite\nall green\n',
      durations: { 'apps/api/test/a.integration.test.ts': 90 } })
  })

  it('shows the running GitHub step live and asks GitHub again only when its jobs changed', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
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
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
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


it.each((['github', 'circleci'] as const).flatMap(provider => [
  { provider, reason: 'CI hang watchdog: no test progress for 60000 ms; running: loop.test.ts > planner never returns',
    expected: 'CI hang watchdog: no test progress for 60000 ms; running: loop.test.ts > planner never returns' },
  { provider, reason: 'CI hang watchdog:\0 café 🚀\ud800', expected: 'CI hang watchdog: café 🚀\ufffd' },
]))('keeps a valid watchdog reason and expected deadline on $provider: $expected', async ({ provider, reason, expected }) => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'unit', scope: 'full', expectedDurationMs: 210_000 })
  const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
  expect(command).toContain('expected_duration_ms=210000')
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  f.github.status = 'completed'
  f.github.conclusion = 'failure'
  f.github.log = `ci\tSuite\t[ci-watchdog] ${reason}\n`
  f.github.watchdogFailure = { message: reason }
  f.circle.outcome = 'failed'
  f.circle.output = `[ci-watchdog] ${reason}\n`
  f.circle.log = f.circle.output
  f.circle.watchdogFailure = { message: reason }
  const result = await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
  expect(result).toMatchObject({ run: { state: 'failed', message: expected }, text: expect.stringContaining(expected) })
  expect(result.operation === 'read' && result.text).not.toContain('\0')
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
    .toMatchObject({ run: { state: 'failed', message: expected }, text: expect.stringContaining(expected) })
})

it.each(['github', 'circleci'] as const)('prunes stale mirror branches and keeps shared %s branches until every ticket finishes', async provider => {
  const f = await fixture({}, { provider })
  const stale = `ci/${'a'.repeat(40)}`
  f.mirrorGit('update-ref', `refs/heads/${stale}`, 'main')
  f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
  f.mirrorGit('update-ref', 'refs/heads/feature/keep', 'main')
  const first = randomUUID()
  const second = randomUUID()
  const request = { operation: 'start' as const, workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
    suite: 'lint' as const, scope: 'affected' as const, files: [] }
  const activeState = provider === 'circleci' ? 'running' : 'starting'
  expect(await f.cloud.handle({ ...request, runId: first }))
    .toMatchObject({ operation: 'start', run: { state: activeState } })
  expectMirrorDispatch(provider, (provider === 'github' ? f.dispatched : f.circle.triggered)[0])
  expect(await f.cloud.handle({ ...request, runId: second }))
    .toMatchObject({ operation: 'start', run: { state: activeState } })
  expectMirrorDispatch(provider, (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1))
  expect(await f.reopen().handle({ operation: 'read', runId: second, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ operation: 'read', run: { state: activeState } })
  expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(2)
  const refs = () => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/')
  await expect.poll(refs, { timeout: 5_000 }).not.toContain(`refs/heads/${stale}`)
  await expect.poll(refs, { timeout: 5_000 }).not.toContain('refs/heads/ci/retired-run')
  expect(refs()).toContain('refs/heads/feature/keep')
  await f.cloud.handle({ operation: 'cancel', runId: first })
  expect(refs()).toContain(`refs/heads/ci/${f.commit}`)
  f.advance(5 * 60_000)
  await f.reopen().handle({ operation: 'cancel', runId: second })
  await expect.poll(refs, { timeout: 5_000 }).not.toContain(`refs/heads/ci/${f.commit}`)
  await f.reopen().handle({ ...request, runId: randomUUID() })
  expectMirrorDispatch(provider, (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1))
  expect(refs()).toContain(`refs/heads/ci/${f.commit}`)
})

it.each(['success', 'failure'] as const)('removes mirror branches after a %s result without losing persisted results', async conclusion => {
  const f = await fixture()
  const runId = randomUUID()
  expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'lint', scope: 'affected', files: [] }))
    .toMatchObject({ operation: 'start', run: { state: 'starting' } })
  expect(f.dispatched[0]).toContain('octo/site-ci')
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
  f.github.status = 'completed'
  f.github.conclusion = conclusion
  const read = { operation: 'read' as const, runId, afterOffset: 0, maxBytes: 65_536 }
  const state = conclusion === 'success' ? 'passed' : 'failed'
  f.advance(5 * 60_000)
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state }, text: expect.stringContaining('all green') })
  await expect.poll(() => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'), { timeout: 5_000 }).toBe('')
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state }, text: expect.stringContaining('all green') })
})


it.each(['configured', 'admitted'] as const)(
  'republishes a branch removed by maintenance after cleanup failed using its %s CircleCI mirror', async mirrorSource => {
  const f = await fixture({}, { provider: 'circleci', mirror: mirrorSource === 'configured' })
  const request = { operation: 'start' as const, workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
    ...(mirrorSource === 'admitted' ? { ciMirror: 'octo/site-ci' } : {}),
    suite: 'lint' as const, scope: 'affected' as const, files: [] }
  const runId = randomUUID()
  expect(await f.cloud.handle({ ...request, runId }))
    .toMatchObject({ operation: 'start', run: { state: 'running' } })
  expectMirrorDispatch('circleci', f.circle.triggered[0])
  f.cleanup.unavailable = true
  f.advance(5 * 60_000)
  f.circle.outcome = 'succeeded'
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
    .toMatchObject({ run: { state: 'passed' } })
  await expect.poll(() => f.cleanup.failures, { timeout: 5_000 }).toBeGreaterThan(0)
  const branch = `refs/heads/ci/${f.commit}`
  expect(f.mirrorGit('rev-parse', branch)).toMatch(/^[a-f0-9]{40}$/)
  // Maintenance in another process deletes the ref without touching the live publisher's memory.
  f.mirrorGit('update-ref', '-d', branch)
  f.cleanup.unavailable = false
  f.circle.outcome = ''
  const replacement = randomUUID()
  expect(await f.cloud.handle({ ...request, runId: replacement }))
    .toMatchObject({ operation: 'start', run: { state: 'running' } })
  expect(await f.reopen().handle({ operation: 'read', runId: replacement, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ operation: 'read', run: { state: 'running' } })
  expect(f.circle.triggered).toHaveLength(2)
  expectMirrorDispatch('circleci', f.circle.triggered.at(-1))
  expect(f.mirrorGit('rev-parse', branch)).toMatch(/^[a-f0-9]{40}$/)
})


it('releases stale provider records only when no active Main ticket still uses their branch', async () => {
  const f = await fixture()
  const first = randomUUID()
  const second = randomUUID()
  const start = { operation: 'start' as const, workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
    suite: 'lint' as const, scope: 'affected' as const, files: [] }
  expect(await f.cloud.handle({ ...start, runId: first }))
    .toMatchObject({ operation: 'start', run: { state: 'starting' } })
  expect(f.dispatched[0]).toContain('octo/site-ci')
  await f.cloud.handle({ ...start, runId: second })
  const branch = `refs/heads/ci/${f.commit}`
  await f.prune(new Set([second]))
  expect(f.mirrorGit('rev-parse', branch)).toMatch(/^[a-f0-9]{40}$/)
  await f.prune(new Set())
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
  // Sweeping refs does not rewrite the provider's saved observations.
  expect(await f.reopen().handle({ operation: 'read', runId: first, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { state: 'starting' } })
})


it.each(['github', 'circleci'] as const)('keeps publication scoped after cancellation and a %s provider restart', async provider => {
  const f = await fixture({}, { provider })
  const first = randomUUID()
  const second = randomUUID()
  const request = { operation: 'start' as const, workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
    suite: 'lint' as const, scope: 'affected' as const, files: [] }
  const activeState = provider === 'circleci' ? 'running' : 'starting'
  expect(await f.cloud.handle({ ...request, runId: first }))
    .toMatchObject({ operation: 'start', run: { state: activeState } })
  expect(await f.cloud.handle({ operation: 'cancel', runId: first }))
    .toMatchObject({ operation: 'cancel', run: { state: 'canceled' } })
  const reopened = f.reopen()
  expect(await reopened.handle({ ...request, runId: second }))
    .toMatchObject({ operation: 'start', run: { state: activeState, provenance: { sourceCommit: f.commit } } })
  expect(await reopened.handle({ operation: 'read', runId: first, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ operation: 'read', run: { state: 'canceled' } })
  const commands = provider === 'github' ? f.dispatched : f.circle.triggered
  expect(commands).toHaveLength(2)
  for (const command of commands) {
    expectMirrorDispatch(provider, command)
  }
  expect(await f.reopen().handle({ operation: 'read', runId: second, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ operation: 'read', run: { state: activeState, provenance: { sourceCommit: f.commit } } })
  expect(commands).toHaveLength(2)
})
