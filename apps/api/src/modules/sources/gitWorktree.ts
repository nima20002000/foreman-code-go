import { execFile } from 'node:child_process'
import { mkdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SourceError } from './manifest.js'

export interface WorktreeRequest { repository: string; branch: string }
export interface GitWorktreePorts {
  /** One clone per repository on this computer, outside every approved root. */
  cloneDirectory(repository: string): string
  git(args: string[], options: { cwd?: string; signal: AbortSignal; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }>
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u
/** Git ref rules plus a fixed product prefix, so a branch can never name another ref or an option. */
export function assertWorktreeRequest(request: WorktreeRequest) {
  const [, name] = request.repository.split('/')
  if (!REPOSITORY.test(request.repository) || name === '.' || name === '..') {
    throw new SourceError('SOURCE_WORKTREE_INVALID', 'The workspace repository must be owner/name.')
  }
  if (!/^foreman\/[A-Za-z0-9._/-]{1,200}$/u.test(request.branch) || request.branch.includes('..') || request.branch.includes('//')
    || request.branch.endsWith('/') || request.branch.endsWith('.lock') || request.branch.endsWith('.')) {
    throw new SourceError('SOURCE_WORKTREE_INVALID', 'The agent branch name is invalid.')
  }
}

/** Fetches the approved commit into this computer's clone and adds a worktree on the agent's branch. */
export async function addGitWorktree(ports: GitWorktreePorts, request: WorktreeRequest, commit: string, path: string,
  signal: AbortSignal, options?: { checkout: 'deferred' }): Promise<{ branch: string; commit: string }> {
  assertWorktreeRequest(request)
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) throw new SourceError('SOURCE_WORKTREE_INVALID', 'The approved commit is invalid.')
  const clone = await ensureCommit(ports, request.repository, commit, signal)
  const run = async (args: string[], cwd?: string) => {
    const result = await ports.git(args, { ...(cwd ? { cwd } : {}), signal })
    if (result.code !== 0) throw new SourceError('SOURCE_WORKTREE_FAILED',
      `git ${args[0]} failed: ${result.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? 'unknown error'}`)
    return result.stdout
  }
  // Worktrees whose Run directory was retired leave stale entries; their branches and commits stay in the clone.
  await run(['worktree', 'prune'], clone)
  // Occurrences keep their branches; random suffixes also avoid allocation races.
  for (;;) {
    const suffix = `-${randomUUID()}`
    const branchLimit = 'foreman/'.length + 200
    const branch = `${request.branch.slice(0, branchLimit - suffix.length)}${suffix}`
    const existing = await ports.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: clone, signal })
    if (existing.code === 0) continue
    await run(['worktree', 'add', ...(options?.checkout === 'deferred' ? ['--no-checkout'] : []),
      '-b', branch, path, commit], clone)
    if (options?.checkout === 'deferred') await run(['read-tree', commit], path)
    const head = (await run(['rev-parse', 'HEAD'], path)).trim()
    if (head !== commit) throw new SourceError('SOURCE_WORKTREE_CONFLICT', 'The worktree is not at the approved commit.')
    return { branch, commit }
  }
}

/** This computer's clone of the repository, holding the commit (fetched from GitHub when missing). */
export async function ensureCommit(ports: GitWorktreePorts, repository: string, commit: string, signal: AbortSignal): Promise<string> {
  const clone = await ensureClone(ports, repository, signal)
  if ((await ports.git(['cat-file', '-e', `${commit}^{commit}`], { cwd: clone, signal })).code !== 0) {
    await runGit(ports, ['fetch', '--no-tags', 'origin', commit], clone, signal)
  }
  await fetchMissingSourceObjects(ports, clone, commit, signal)
  return clone
}

async function fetchMissingSourceObjects(ports: GitWorktreePorts, clone: string, commit: string, signal: AbortSignal) {
  const objects = await runGit(ports, ['rev-list', '--objects', '--no-object-names', '--missing=print',
    `${commit}^{tree}`], clone, signal)
  const missing = objects.split('\n').filter(line => /^\?(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(line))
    .map(line => line.slice(1))
  // The authenticated fetch fills partial clones before credential-free capture reads their objects.
  for (let offset = 0; offset < missing.length; offset += 128) {
    await runGit(ports, ['fetch', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--no-filter',
      'origin', ...missing.slice(offset, offset + 128)], clone, signal)
  }
  if (missing.length) {
    await runGit(ports, ['rev-list', '--objects', '--no-object-names', '--missing=error', `${commit}^{tree}`],
      clone, signal)
  }
}

export async function ensureClone(ports: GitWorktreePorts, repository: string, signal: AbortSignal): Promise<string> {
  assertWorktreeRequest({ repository, branch: 'foreman/source' })
  const clone = ports.cloneDirectory(repository)
  const exists = await ports.git(['rev-parse', '--git-dir'], { cwd: clone, signal }).then(result => result.code === 0, () => false)
  if (exists) return clone
  await mkdir(join(clone, '..'), { recursive: true, mode: 0o700 })
  const staging = `${clone}-${randomUUID()}`
  try {
    await runGit(ports, ['clone', '--no-checkout', `https://github.com/${repository}.git`, staging], undefined, signal)
    try {
      await rename(staging, clone)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await runGit(ports, ['rev-parse', '--git-dir'], clone, signal)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return clone
}
async function runGit(ports: GitWorktreePorts, args: string[], cwd: string | undefined, signal: AbortSignal) {
  const result = await ports.git(args, { ...(cwd ? { cwd } : {}), signal })
  if (result.code !== 0) throw new SourceError('SOURCE_WORKTREE_FAILED',
    `git ${args[0]} failed: ${result.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? 'unknown error'}`)
  return result.stdout
}

export function systemGitWorktreePorts(environment: NodeJS.ProcessEnv = process.env): GitWorktreePorts {
  const home = environment.HOME ?? homedir()
  return {
    cloneDirectory: repository => join(home, '.local', 'share', 'foreman-code', 'git', ...repository.split('/')),
    // GitHub CLI credentials (gh auth setup-git) supply authentication; no prompt can block a Run.
    git: (args, options) => new Promise(resolve => {
      // Worktree files stay private to this user, like every other app-managed source directory.
      execFile('/bin/sh', ['-c', 'umask 077 && exec git "$@"', 'git', ...args], { ...(options.cwd ? { cwd: options.cwd } : {}), signal: options.signal, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8', env: { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...options.env } }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
        resolve({ code, stdout, stderr })
      })
    }),
  }
}
