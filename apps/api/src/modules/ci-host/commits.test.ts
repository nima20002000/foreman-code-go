import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { GitCiCommits } from './commits.js'
import { systemGitWorktreePorts } from '../sources/gitWorktree.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('tests the unchanged Agent commit without importing files or selecting a newer default head', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci-unchanged-agent-'))
  directories.push(directory)
  const origin = join(directory, 'origin')
  await mkdir(origin)
  const environment = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, env: environment, encoding: 'utf8',
  }).trim()
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'source.txt'), 'Run-start source')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'Run start')
  const baseCommit = git(origin, 'rev-parse', 'HEAD')
  const clone = join(directory, 'clone')
  git(directory, 'clone', '-q', '--no-checkout', origin, clone)
  await writeFile(join(origin, 'source.txt'), 'Newer default source')
  git(origin, 'commit', '-qam', 'Advance main')
  const system = systemGitWorktreePorts(environment)
  const run = vi.fn(system.git)
  const commits = new GitCiCommits({ ...system, git: run, cloneDirectory: () => clone })
  expect(await commits.resolve('octo/site', 'main', undefined,
    { commit: baseCommit, baseCommit, bundle: null })).toBe(baseCommit)
  expect(git(clone, 'show', `${baseCommit}:source.txt`)).toBe('Run-start source')
  expect(run.mock.calls.some(([args]) => args[0] === 'bundle' || args[0] === 'push')).toBe(false)
})

it('classifies Git changes including deletions, mixed commits and renames into CI paths', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'ci-commit-priority-'))
  directories.push(directory)
  const origin = join(directory, 'origin')
  await mkdir(join(origin, 'scripts'), { recursive: true })
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  await writeFile(join(origin, 'scripts/ci-example.mjs'), 'export const value = 1')
  git('add', '.')
  git('commit', '-qm', 'CI setup')
  const commits = new GitCiCommits({ ...systemGitWorktreePorts(environment), cloneDirectory: () => origin })
  const classify = () => commits.infrastructureOnly('octo/site', git('rev-parse', 'HEAD'))
  expect(await classify()).toBe(true)
  git('commit', '--allow-empty', '-qm', 'Empty change')
  expect(await classify()).toBe(false)
  await writeFile(join(origin, 'product.txt'), 'Product')
  await writeFile(join(origin, 'scripts/ci-example.mjs'), 'export const value = 2')
  git('add', '.')
  git('commit', '-qm', 'Mixed change')
  expect(await classify()).toBe(false)
  git('mv', 'product.txt', 'scripts/ci-product.mjs')
  git('commit', '-qm', 'Move product')
  expect(await classify()).toBe(false)
  git('rm', 'scripts/ci-example.mjs')
  git('commit', '-qm', 'Remove CI example')
  expect(await classify()).toBe(true)
})
