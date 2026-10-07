import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { addGitWorktree, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: gitFixtureEnvironment() }).trim()

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-worktree-')); roots.push(root)
  const origin = join(root, 'origin'); await mkdir(origin)
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'README.md'), 'approved\n')
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'approved')
  const commit = git(origin, 'rev-parse', 'HEAD')
  const system = systemGitWorktreePorts(gitFixtureEnvironment())
  // The clone reads from a local origin instead of github.com; everything else is the real git flow.
  const ports: GitWorktreePorts = { cloneDirectory: repository => join(root, 'clones', ...repository.split('/')),
    git: (args, options) => system.git(args[0] === 'clone' ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options) }
  return { root, origin, commit, ports }
}

it('gives each agent its own branch at the approved commit and keeps an earlier attempt\'s commits', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const first = await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-abc' }, f.commit, join(f.root, 'a'), signal)
  expect(first).toEqual({ branch: 'foreman/review/coder-abc', commit: f.commit })
  expect(await readFile(join(f.root, 'a', 'README.md'), 'utf8')).toBe('approved\n')
  await writeFile(join(f.root, 'a', 'work.txt'), 'agent work\n')
  git(join(f.root, 'a'), 'add', '.'); git(join(f.root, 'a'), 'commit', '-qm', 'agent work')
  const second = await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-abc' }, f.commit, join(f.root, 'b'), signal)
  expect(second.branch).toBe('foreman/review/coder-abc-2')
  expect(git(join(f.root, 'b'), 'rev-parse', 'HEAD')).toBe(f.commit)
  expect(git(join(f.root, 'a'), 'log', '-1', '--format=%s')).toBe('agent work')
})

it('forgets worktrees whose Run directory was removed while keeping their branches', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-old' }, f.commit, join(f.root, 'old'), signal)
  await rm(join(f.root, 'old'), { recursive: true, force: true })
  await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-new' }, f.commit, join(f.root, 'new'), signal)
  const clone = join(f.root, 'clones', 'octo', 'site')
  expect(git(clone, 'worktree', 'list')).not.toContain(join(f.root, 'old'))
  expect(git(clone, 'branch', '--list', 'foreman/review/coder-old')).toContain('foreman/review/coder-old')
})

it('refuses unsafe repository and branch names before running git', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(10_000)
  await expect(addGitWorktree(f.ports, { repository: '../evil', branch: 'foreman/x' }, f.commit, join(f.root, 'x'), signal))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_INVALID' })
  await expect(addGitWorktree(f.ports, { repository: 'octo/site', branch: '--upload-pack=x' }, f.commit, join(f.root, 'x'), signal))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_INVALID' })
  await expect(addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/a..b' }, f.commit, join(f.root, 'x'), signal))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_INVALID' })
})

it('keeps fixture repositories independent of inherited CI Git routing and identity', async () => {
  vi.stubEnv('GIT_DIR', '/uncreated-ci-repository')
  vi.stubEnv('GIT_WORK_TREE', '/uncreated-ci-worktree')
  vi.stubEnv('GIT_AUTHOR_NAME', '')
  vi.stubEnv('GIT_COMMITTER_NAME', '')
  try {
    const f = await fixture()
    const path = join(f.root, 'agent')
    await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-ci' },
      f.commit, path, AbortSignal.timeout(30_000))
    expect(git(path, 'rev-parse', 'HEAD')).toBe(f.commit)
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('approved\n')
  } finally { vi.unstubAllEnvs() }
})
