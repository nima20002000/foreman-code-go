import { expect, it, vi } from 'vitest'
import { GitCiCommits } from './commits.js'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'

function fixture() {
  let head = 'a'.repeat(40)
  const git = vi.fn<GitWorktreePorts['git']>(async args => {
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      return { code: 0, stdout: head, stderr: '' }
    }
    if (args[0] === 'for-each-ref') {
      return { code: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  const commits = new GitCiCommits({ git, cloneDirectory: () => '/repository' })
  return { commits, git, advance: () => { head = 'b'.repeat(40) } }
}

it('shares publication of a known commit across concurrent resolution and later requests', async () => {
  const f = fixture()
  const commit = 'a'.repeat(40)
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const run = f.git.getMockImplementation()!
  f.git.mockImplementation(async (args, options) => {
    if (args[0] === 'fetch') await blocked
    return run(args, options)
  })
  const requests = Array.from({ length: 4 }, () => f.commits.resolve('octo/site', 'main', commit, null))
  release()
  expect(await Promise.all(requests)).toEqual(Array(4).fill(commit))
  expect(await f.commits.resolve('octo/site', 'main', commit, null)).toBe(commit)
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
  await f.commits.resolve('octo/other', 'main', commit, null)
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(2)
})

it('retries publication after a failed resolution instead of caching the failure', async () => {
  const f = fixture()
  const run = f.git.getMockImplementation()!
  let fail = true
  f.git.mockImplementation(async (args, options) => {
    if (args[0] === 'fetch' && fail) {
      fail = false
      return { code: 1, stdout: '', stderr: 'remote unavailable' }
    }
    return run(args, options)
  })
  const resolve = () => f.commits.resolve('octo/site', 'main', 'a'.repeat(40), null)
  await expect(resolve()).rejects.toMatchObject({ code: 'SOURCE_GITHUB_PUSH_REQUIRED' })
  expect(await resolve()).toBe('a'.repeat(40))
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(2)
})

it('refreshes a moving default branch while reusing publication of its resolved commit', async () => {
  const f = fixture()
  expect(await f.commits.resolve('octo/site', 'main', undefined, null)).toBe('a'.repeat(40))
  f.advance()
  expect(await f.commits.resolve('octo/site', 'main', undefined, null)).toBe('b'.repeat(40))
  expect(await f.commits.resolve('octo/site', 'main', 'a'.repeat(40), null)).toBe('a'.repeat(40))
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'fetch' && args.includes('--prune'))).toHaveLength(2)
})
