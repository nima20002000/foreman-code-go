import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

it('resolves branch identity and ancestry from published Git commits while protecting main and ambiguous refs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci-commit-lineage-'))
  directories.push(directory)
  const origin = join(directory, 'origin')
  await mkdir(origin)
  const environment = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, env: environment, encoding: 'utf8',
  }).trim()
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'source.txt'), 'Base')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'Base')
  const main = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'checkout', '-qb', 'feature')
  await writeFile(join(origin, 'source.txt'), 'First')
  git(origin, 'commit', '-qam', 'First')
  const first = git(origin, 'rev-parse', 'HEAD')
  await writeFile(join(origin, 'source.txt'), 'Second')
  git(origin, 'commit', '-qam', 'Second')
  const second = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'branch', `foreman/ci/${second}`, second)
  git(origin, 'checkout', '-qb', 'other', main)
  await writeFile(join(origin, 'source.txt'), 'Unrelated')
  git(origin, 'commit', '-qam', 'Unrelated')
  const unrelated = git(origin, 'rev-parse', 'HEAD')
  const clone = join(directory, 'clone')
  git(directory, 'clone', '-q', '--no-checkout', origin, clone)
  const system = systemGitWorktreePorts(environment)
  const commits = new GitCiCommits({ ...system, cloneDirectory: () => clone })
  expect(await commits.branch('octo/site', 'main', first)).toBe('feature')
  expect(await commits.branch('octo/site', 'main', second)).toBe('feature')
  expect(await commits.branch('octo/site', 'main', main)).toBe('main')
  expect(await commits.branch('octo/site', 'main', unrelated)).toBe('other')
  expect(await commits.isAncestor('octo/site', first, second)).toBe(true)
  expect(await commits.isAncestor('octo/site', second, first)).toBe(false)
  expect(await commits.isAncestor('octo/site', first, unrelated)).toBe(false)
  git(clone, 'update-ref', 'refs/remotes/origin/ambiguous', second)
  expect(await commits.branch('octo/site', 'main', first)).toBeNull()
})
