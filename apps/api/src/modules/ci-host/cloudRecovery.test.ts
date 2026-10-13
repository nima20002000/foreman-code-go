import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { integrationPartition } from '@foreman-code/contracts'
import { repositoryFileList, integrationFileList, selectByIndexes } from '../../../../../scripts/ci-files.mjs'
import { executionSelection } from '../../../../../scripts/ci-selection.mjs'
import { fixture } from './cloud.testSupport.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

const readRequest = (runId: string) => ({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
const parameter = (args: string[], name: string) => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)

it.each([{ phase: 'ended' }, { current_outcome: 'not_run' }])(
  'settles CircleCI pipeline errors when the provider reports %j', async terminal => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.phantoms = 1
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.circle.runView = { ...terminal, errors: [{ type: 'system', message: 'Pipeline could not be processed' }], workflows: [] }
    expect(await f.cloud.handle(readRequest(runId)))
      .toMatchObject({ run: { state: 'failed', message: expect.stringContaining('Pipeline could not be processed') },
        text: expect.stringContaining('system: Pipeline could not be processed') })
    f.advance(225_000)
    expect(await f.reopen().handle(readRequest(runId))).toMatchObject({ run: { state: 'failed' } })
    expect(f.circle.triggered).toHaveLength(1)
  })

it('retains CircleCI config errors across restart and stops redispatching the failing commit', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.phantoms = 1
  const runId = randomUUID()
  const start = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' }
  await f.cloud.handle(start)
  const message = 'Pipeline parameter expected_duration_ms has an incompatible type'
  f.circle.runView = { phase: 'ended', current_outcome: 'not_run', errors: [{ type: 'config', message }], workflows: [] }
  expect(await f.reopen().handle(readRequest(runId)))
    .toMatchObject({ run: { state: 'failed', message: expect.stringContaining(message) }, text: expect.stringContaining(message) })
  f.circle.lookupError = 'provider is temporarily unavailable'
  f.advance(225_000)
  const reopened = f.reopen()
  expect(await reopened.handle(start)).toMatchObject({ run: { state: 'failed' } })
  expect(await reopened.handle(readRequest(runId)))
    .toMatchObject({ run: { state: 'failed', message: expect.stringContaining(message) }, text: expect.stringContaining(message) })
  const anotherId = randomUUID()
  expect(await reopened.handle({ ...start, runId: anotherId, partition: { index: 1, count: 2 } }))
    .toMatchObject({ run: { state: 'failed', message: expect.stringContaining(message) } })
  expect(await reopened.handle(readRequest(anotherId))).toMatchObject({ text: expect.stringContaining(message) })
  expect(f.circle.triggered).toHaveLength(1)

  await f.write('README.md', 'Updated pipeline configuration\n')
  f.run('add', 'README.md')
  f.run('commit', '-qm', 'update source snapshot')
  const commit = f.run('rev-parse', 'HEAD')
  f.push('main')
  f.circle.lookupError = ''
  f.circle.runView = null
  expect(await f.reopen().handle({ ...start, runId: randomUUID(), commit })).toMatchObject({ run: { state: 'running' } })
  expect(f.circle.triggered).toHaveLength(2)
})

it.each(['github', 'circleci'] as const)('decodes explicit files from the published %s tree with injected workflows', async provider => {
  const files = ['apps/api/test/alpha.test.ts', 'apps/api/test/beta.test.ts', 'apps/api/test/gamma.test.ts']
  const f = await fixture(Object.fromEntries(files.map(file => [file, 'export {}'])), { provider, sourceWorkflows: false })
  const selected = files.slice(0, 2)
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
    suite: 'unit', scope: 'affected', files: selected })
  const command = (provider === 'github' ? f.dispatched : f.circle.triggered)[0]!
  const checkout = await f.checkoutMirror(f.mirrorGit('rev-parse', 'main'))
  expect(selectByIndexes(repositoryFileList(checkout), parameter(command, 'files')!)).toEqual(selected)
})

it.each(['github', 'circleci'] as const)('publishes a later pinned commit from the cached source clone on %s', async provider => {
  const f = await fixture({}, { provider })
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' })
  await f.write('README.md', 'Later source snapshot\n')
  f.run('add', 'README.md')
  f.run('commit', '-qm', 'update source snapshot')
  const later = f.run('rev-parse', 'HEAD')
  f.push('main')
  const started = await f.reopen().handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
    commit: later, suite: 'integration', scope: 'full' })
  expect(started).toMatchObject({ run: { provenance: { sourceCommit: later } } })
  if (started.operation !== 'start' || !started.run.provenance) throw new Error('Missing snapshot provenance')
  const { workflowCommit, workflowRef } = started.run.provenance
  const command = (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1)!
  const refFlag = provider === 'github' ? '--ref' : '--branch'
  expect(command[command.indexOf(refFlag) + 1]).toBe(workflowRef)
  expect(f.mirrorGit('rev-parse', workflowRef)).toBe(workflowCommit)
  expect(f.mirrorGit('rev-parse', `${workflowCommit}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
  expect(f.mirrorGit('show', `${workflowCommit}:README.md`)).toBe('Later source snapshot')
})

it('keeps the source and workflow pairing across another publication, retry and restart', async () => {
  const f = await fixture()
  const runId = randomUUID()
  const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' })
  const first = f.dispatched[0]!
  const ref = first[first.indexOf('--ref') + 1]!
  const workflowCommit = f.mirrorGit('rev-parse', ref)
  await f.write('.github/workflows/ci.yml', 'name: Different workflow\non: workflow_dispatch\n')
  f.run('add', '.')
  f.run('commit', '-qm', 'different workflow')
  const later = f.run('rev-parse', 'HEAD')
  f.push('main')
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: later,
    suite: 'integration', scope: 'full' })
  expect(f.mirrorGit('rev-parse', ref)).toBe(workflowCommit)
  expect(started).toMatchObject({ run: { provenance: { sourceCommit: f.commit, workflowCommit, workflowRef: ref } } })
  f.advance(75_000)
  await f.reopen().handle(readRequest(runId))
  expect(f.dispatched.at(-1)).toEqual(first)
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}`, headSha: 'f'.repeat(40) }]
  await expect(f.reopen().handle(readRequest(runId))).rejects.toMatchObject({ code: 'CI_CLOUD_PROVENANCE_MISMATCH' })
  expect(f.github.canceled).toContain('8')
})

it.each(['github', 'circleci'] as const)('retains oversized timing inputs for affected selection on %s', async provider => {
  const f = await fixture({}, { provider })
  const files = ['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)
  const learned = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`apps/api/test/unused-${index}.integration.test.ts`, 900]))
  Object.assign(learned, { [files[0]!]: 1, [files[1]!]: 1000 })
  expect(JSON.stringify(learned).length).toBeGreaterThan(500)
  const expectedDurations = { [files[0]!]: 400, [files[1]!]: 300, [files[2]!]: 200, [files[3]!]: 100, ...learned }
  const selected: string[][] = []
  for (const index of [0, 1]) {
    const partition = { index, count: 2, weights: [2, 1] }
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration', partition, durations: learned })
    const command = (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1)!
    const checkout = await f.checkoutMirror(f.mirrorGit('rev-parse', 'main'))
    const result = executionSelection({ commit: 'HEAD', executionSuite: 'integration', cwd: checkout,
      defaultRef: `origin/${parameter(command, 'default_branch')}`, partition,
      learned: JSON.parse(parameter(command, 'durations') ?? '{}') })
    expect(result.files).toEqual(integrationPartition(files, expectedDurations, partition))
    selected.push(result.files)
  }
  expect(selected.flat().sort()).toEqual(files)
})

it('uses the same learned timings when only a full-suite slice exceeds the provider budget', async () => {
  const files = Array.from({ length: 700 }, (_, index) => `apps/api/test/file-${String(index).padStart(4, '0')}.integration.test.ts`)
  const durations = Object.fromEntries([...files, ...['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)]
    .map(file => [file, 1]))
  const f = await fixture(Object.fromEntries(files.map(file => [file, ''])), { provider: 'circleci' })
  const selected: string[][] = []
  let fallbacks = 0
  for (const index of [0, 1]) {
    const partition = { index, count: 2, weights: [8, 1] }
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition, durations })
    const command = f.circle.triggered.at(-1)!
    const checkout = await f.checkoutMirror(f.mirrorGit('rev-parse', 'main'))
    const inventory = integrationFileList(checkout)
    const slice = parameter(command, 'slice')!
    if (!slice) fallbacks++
    const result = slice ? selectByIndexes(inventory, slice)
      : executionSelection({ commit: 'HEAD', executionSuite: 'integration', cwd: checkout, partition }).files
    const committed = Object.fromEntries(['a', 'b', 'c', 'd'].map((name, index) => [`apps/api/test/${name}.integration.test.ts`, 400 - index * 100]))
    expect(result).toEqual(integrationPartition(inventory, { ...committed, ...durations }, partition))
    selected.push(result)
  }
  expect(fallbacks).toBeGreaterThan(0)
  expect(selected.flat().sort()).toEqual([...files, ...['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)].sort())
})

it.each(['github', 'circleci'] as const)('retries terminal %s logs and artifacts after restart without dispatching again', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' })
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
  const state = provider === 'github' ? f.github : f.circle
  Object.assign(state, { artifactError: 'temporarily unavailable', logError: 'temporarily unavailable',
    durations: { 'apps/api/test/a.integration.test.ts': 90 },
    testResults: { summary: { passed: 1, failed: 0, skipped: 0 }, truncated: false, files: [] } })
  f.github.status = 'completed'
  f.github.conclusion = 'success'
  f.circle.outcome = 'succeeded'
  expect(await f.cloud.handle(readRequest(runId))).toMatchObject({ run: { state: 'passed', collection: 'pending' } })
  Object.assign(state, { artifactError: '', logError: '' })
  f.advance(4000)
  expect(await f.reopen().handle({ ...readRequest(runId), durations: true, testResults: true }))
    .toMatchObject({ run: { state: 'passed', collection: 'complete' }, text: expect.stringContaining('all green'),
      durations: state.durations, testResults: state.testResults })
  expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(1)
})

it('preserves readable provider ownership during an interrupted metadata replacement', async () => {
  const f = await fixture()
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' })
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
  await f.cloud.handle(readRequest(runId))
  f.advance(4000)
  f.github.steps = [{ number: 1, name: 'Tests', status: 'in_progress', conclusion: null }]
  const { writeFile: write } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let entered!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const interrupted = vi.mocked(fs.writeFile).mockImplementation(async (path, data, options) => {
    if (!String(path).includes('meta.json')) return write(path, data, options)
    await write(path, '{', options)
    entered()
    await gate
    throw new Error('Interrupted write')
  })
  const updating = f.cloud.handle(readRequest(runId))
  const failed = expect(updating).rejects.toThrow('Interrupted write')
  try {
    await paused
    expect(await f.cloud.handle(readRequest(runId))).toMatchObject({ run: { state: 'running' } })
    expect(await f.reopen().handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })).toMatchObject({ run: { state: 'running' } })
  } finally {
    release()
    await failed
    interrupted.mockImplementation(write)
  }
  await f.reopen().handle({ operation: 'cancel', runId })
  expect(f.github.canceled).toContain('8')
  expect(f.dispatched).toHaveLength(1)
})

it('reports corrupted ownership separately from a missing cloud run', async () => {
  const f = await fixture()
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' })
  await fs.writeFile(join(f.root, 'ci-cloud', 'runs', runId, 'meta.json'), '{')
  await expect(f.reopen().handle(readRequest(runId))).rejects.toMatchObject({ code: 'CI_RUN_CORRUPT' })
  await expect(f.reopen().handle(readRequest(randomUUID()))).rejects.toMatchObject({ code: 'CI_RUN_UNKNOWN' })
})

it.each(['canceled', 'queued'] as const)('cancels GitHub attempts that become visible after the ticket is %s', async outcome => {
  const f = await fixture()
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'integration', scope: 'full' })
  if (outcome === 'canceled') await f.cloud.handle({ operation: 'cancel', runId })
  else for (let attempt = 0; attempt < 3; attempt++) {
    f.advance(75_000)
    await f.cloud.handle(readRequest(runId))
  }
  expect(await f.cloud.handle(readRequest(runId))).toMatchObject({ run: { state: outcome } })
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }, { databaseId: 9, displayTitle: `ci ${runId}` }]
  f.advance(4000)
  const reopened = f.reopen()
  await reopened.handle({ operation: 'status' })
  expect(f.github.canceled).toEqual(expect.arrayContaining(['8', '9']))
  expect(await reopened.handle(readRequest(runId))).toMatchObject({ run: { state: outcome } })
})

it.each(['github', 'circleci'] as const)('starts %s with learned timings regardless of their key order', async provider => {
  const f = await fixture({}, { provider })
  const first = 'apps/api/test/a.integration.test.ts'
  const second = 'apps/api/test/b.integration.test.ts'
  const snapshots: string[] = []
  for (const durations of [{ [first]: 10, [second]: 20 }, { [second]: 20, [first]: 10 }]) {
    const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'full', durations })
    expect(started).toMatchObject({ operation: 'start', run: { state: expect.stringMatching(/starting|running/),
      provenance: { sourceCommit: f.commit } } })
    if (started.operation !== 'start' || !started.run.provenance) throw new Error('Missing snapshot provenance')
    const snapshot = started.run.provenance.workflowCommit
    snapshots.push(snapshot)
    expect(JSON.parse(f.mirrorGit('show', `${snapshot}:scripts/ci-learned-durations.json`)))
      .toEqual({ [first]: 10, [second]: 20 })
  }
  expect(snapshots[1]).toBe(snapshots[0])
  expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(2)
})
