import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { integrationPartition } from '@foreman-code/contracts'
import { repositoryFileList, selectByIndexes } from '../../../../../scripts/ci-files.mjs'
import { fixture } from './cloud.testSupport.js'
import { cloudSuiteRunner } from './cloudRunner.testSupport.js'

const parameter = (args: string[], name: string) => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)

it.each(['github', 'circleci'] as const)('runs an oversized partition on %s with its complete file list', async provider => {
  const files = Array.from({ length: 40 }, (_, index) => `apps/api/test/selected-${index.toString().padStart(3, '0')}.integration.test.ts`)
  const f = await fixture(Object.fromEntries(files.map(file => [file, ''])), { provider })
  const partition = { index: 0, count: 2, tier: 'slow' as const, slowFiles: files, weights: [2, 1] }
  expect(JSON.stringify(partition).length).toBeGreaterThan(500)
  const runId = randomUUID()
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
  const reply = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'integration', partition })
  expect(reply).toMatchObject({ run: { state: provider === 'github' ? 'starting' : 'running' } })
  const command = (provider === 'circleci' ? f.circle.triggered : f.dispatched)[0]!
  if (provider === 'circleci') {
    for (const value of command.filter(value => value.includes('='))) {
      expect(value.slice(value.indexOf('=') + 1).length).toBeLessThanOrEqual(500)
    }
  }
  const ref = command[command.indexOf(provider === 'circleci' ? '--branch' : '--ref') + 1]!
  const checkout = await f.checkoutMirror(ref)
  const suite = await cloudSuiteRunner(checkout, command, provider)
  const result = suite.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = (await readFile(suite.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual([['pnpm', 'test:integration', '--files', ...integrationPartition(files, {}, partition)]])
  if (provider === 'circleci') {
    expect(f.mirrorGit('rev-parse', ref)).toBe(reply.operation === 'start' ? reply.run.provenance?.workflowCommit : '')
    expect(f.mirrorGit('ls-tree', '--name-only', 'main')).not.toContain('ci-dispatch-inputs.json')
    const manifest = join(checkout, 'ci-dispatch-inputs.json')
    const data = await readFile(manifest)
    expect(parameter(command, 'partition')).toBe(`sha256:${createHash('sha256').update(data).digest('hex')}`)
    await writeFile(suite.calls, '')
    await writeFile(manifest, `${data.toString()} `)
    const corrupted = suite.run()
    expect(corrupted.status).not.toBe(0)
    expect(corrupted.stderr).toContain('CI dispatch inputs hash mismatch')
    expect(await readFile(suite.calls, 'utf8')).toBe('')
    await unlink(manifest)
    expect(suite.run().status).not.toBe(0)
    expect(await readFile(suite.calls, 'utf8')).toBe('')
  }
})

it('runs a CircleCI affected file selection that exceeds the compact index parameter limit', async () => {
  const inventory = Array.from({ length: 1200 }, (_, index) => `apps/api/test/selected-${index.toString().padStart(4, '0')}.integration.test.ts`)
  const files = inventory.filter((_file, index) => index % 2 === 0)
  const f = await fixture(Object.fromEntries(inventory.map(file => [file, ''])), { provider: 'circleci' })
  const reply = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'affected', files })
  expect(reply).toMatchObject({ run: { state: 'running' } })
  const command = f.circle.triggered[0]!
  expect(parameter(command, 'partition')).toMatch(/^sha256:[a-f0-9]{64}$/)
  const checkout = await f.checkoutMirror(command[command.indexOf('--branch') + 1]!)
  const suite = await cloudSuiteRunner(checkout, command, 'circleci')
  const result = suite.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = (await readFile(suite.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual([['pnpm', 'test:integration', '--files', ...files]])
})

it('preserves repository file indexes for oversized CircleCI rerun selections', async () => {
  const inventory = Array.from({ length: 1200 }, (_, index) => `scripts/selected-${index.toString().padStart(4, '0')}.test.mjs`)
  const files = inventory.filter((_file, index) => index % 2 === 0)
  const f = await fixture(Object.fromEntries(inventory.map(file => [file, ''])), { provider: 'circleci' })
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'unit', scope: 'affected', files })
  const command = f.circle.triggered[0]!
  const checkout = await f.checkoutMirror(command[command.indexOf('--branch') + 1]!)
  const data = await readFile(join(checkout, 'ci-dispatch-inputs.json'))
  expect(parameter(command, 'partition')).toBe(`sha256:${createHash('sha256').update(data).digest('hex')}`)
  const inputs = JSON.parse(data.toString()) as { files: string }
  expect(selectByIndexes(repositoryFileList(checkout), inputs.files)).toEqual(files)
})

it('selects affected files against an explicit base from a shallow CircleCI execution checkout', async () => {
  const files = Array.from({ length: 40 }, (_, index) => `apps/api/test/selected-${index.toString().padStart(3, '0')}.integration.test.ts`)
  const f = await fixture(Object.fromEntries(files.map(file => [file, ''])), { provider: 'circleci' })
  const changed = files.slice(0, 12)
  for (const file of changed) await f.write(file, 'export {}\n')
  f.run('commit', '-qam', 'change selected tests')
  f.push('main')
  const partition = { index: 1, count: 2, tier: 'slow' as const, slowFiles: files }
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.run('rev-parse', 'HEAD'), baseCommit: f.commit,
    suite: 'integration', partition })
  const command = f.circle.triggered[0]!
  const ref = command[command.indexOf('--branch') + 1]!
  const checkout = join(f.root, 'shallow')
  const clone = spawnSync('git', ['clone', '--quiet', '--depth=1', '--branch', ref,
    pathToFileURL(join(f.root, 'mirror.git')).href, checkout], { encoding: 'utf8' })
  expect(clone.status, clone.stderr).toBe(0)
  const suite = await cloudSuiteRunner(checkout, command, 'circleci')
  const result = suite.run()
  expect(result.status, result.stderr).toBe(0)
  const calls = (await readFile(suite.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual([['pnpm', 'test:integration', '--files', ...integrationPartition(changed, {}, partition)]])
})

it('rejects private fleet identifiers in dispatch metadata before publishing an execution ref', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const run = f.ports.run
  f.ports.run = async (file, args, options) => {
    if (file === 'tailscale') return { code: 0, stderr: '', stdout: JSON.stringify({
      Self: { HostName: 'fixture-private-host', TailscaleIPs: ['192.0.2.10'] }, Peer: {}, User: {},
    }) }
    return run(file, args, options)
  }
  const slowFiles = Array.from({ length: 40 }, (_, index) => `apps/api/test/selected-${index}.integration.test.ts`)
  slowFiles.push('apps/api/test/fixture-private-host.integration.test.ts')
  const runId = randomUUID()
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'integration',
    partition: { index: 0, count: 2, tier: 'slow', slowFiles } }))
    .rejects.toMatchObject({ code: 'CI_MIRROR_PRIVATE_DATA' })
  expect(f.circle.triggered).toEqual([])
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', `refs/heads/ci/${f.commit}-${runId}`)).toBe('')
})
