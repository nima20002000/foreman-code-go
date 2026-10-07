import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { importAgentSnapshot, snapshotAgentWorktree } from './agentSnapshot.js'
import { systemGitWorktreePorts } from './gitWorktree.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()

it('sends an Agent\'s current files, including uncommitted ones, to another clone without moving its branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-snapshot-')); roots.push(root)
  const origin = join(root, 'origin'); await mkdir(origin)
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'app.ts'), 'base\n'); await writeFile(join(origin, '.gitignore'), 'node_modules/\n')
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'base')
  const base = git(origin, 'rev-parse', 'HEAD')
  const laptop = join(root, 'laptop'), main = join(root, 'main')
  git(root, 'clone', '-q', origin, laptop); git(root, 'clone', '-q', '--no-checkout', origin, main)
  git(laptop, 'checkout', '-qb', 'foreman/review/coder-1')
  await writeFile(join(laptop, 'app.ts'), 'committed change\n'); git(laptop, 'commit', '-qam', 'agent work')
  const branchHead = git(laptop, 'rev-parse', 'HEAD')
  await writeFile(join(laptop, 'app.ts'), 'uncommitted change\n')
  await writeFile(join(laptop, 'new.ts'), 'untracked file\n')
  await mkdir(join(laptop, 'node_modules')); await writeFile(join(laptop, 'node_modules/x.js'), 'ignored\n')
  const ports = systemGitWorktreePorts()
  const snapshot = await snapshotAgentWorktree(ports, { path: laptop, baseCommit: base }, AbortSignal.timeout(30_000))
  expect(git(laptop, 'rev-parse', 'HEAD')).toBe(branchHead)
  expect(git(laptop, 'status', '--porcelain')).toContain('new.ts')
  await importAgentSnapshot(ports, main, snapshot, AbortSignal.timeout(30_000))
  expect(git(main, 'show', `${snapshot.commit}:app.ts`)).toBe('uncommitted change')
  expect(git(main, 'show', `${snapshot.commit}:new.ts`)).toBe('untracked file')
  expect(git(main, 'ls-tree', '-r', '--name-only', snapshot.commit).split('\n').sort()).toEqual(['.gitignore', 'app.ts', 'new.ts'])
  await expect(snapshotAgentWorktree(ports, { path: laptop, baseCommit: 'f'.repeat(40) }, AbortSignal.timeout(30_000)))
    .rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_INVALID' })
})
