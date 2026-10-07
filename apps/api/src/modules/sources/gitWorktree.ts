import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SourceError } from './manifest.js'

export interface WorktreeRequest { repository: string; branch: string }
export interface GitWorktreePorts {
  /** One clone per repository on this computer, outside every approved root. */
  cloneDirectory(repository: string): string
  git(args: string[], options: { cwd?: string; signal: AbortSignal }): Promise<{ code: number; stdout: string; stderr: string }>
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
  signal: AbortSignal): Promise<{ branch: string; commit: string }> {
  assertWorktreeRequest(request)
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) throw new SourceError('SOURCE_WORKTREE_INVALID', 'The approved commit is invalid.')
  const clone = ports.cloneDirectory(request.repository)
  const run = async (args: string[], cwd?: string) => {
    const result = await ports.git(args, { ...(cwd ? { cwd } : {}), signal })
    if (result.code !== 0) throw new SourceError('SOURCE_WORKTREE_FAILED',
      `git ${args[0]} failed: ${result.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? 'unknown error'}`)
    return result.stdout
  }
  const exists = await ports.git(['rev-parse', '--git-dir'], { cwd: clone, signal }).then(result => result.code === 0, () => false)
  if (!exists) {
    await mkdir(join(clone, '..'), { recursive: true, mode: 0o700 })
    await run(['clone', '--no-checkout', '--filter=blob:none', `https://github.com/${request.repository}.git`, clone])
  }
  const present = (await ports.git(['cat-file', '-e', `${commit}^{commit}`], { cwd: clone, signal })).code === 0
  if (!present) await run(['fetch', '--no-tags', 'origin', commit], clone)
  // A branch already used by an earlier attempt keeps that attempt's commits; this attempt gets the next free name.
  for (let index = 1; index <= 20; index++) {
    const branch = index === 1 ? request.branch : `${request.branch}-${index}`
    const existing = await ports.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: clone, signal })
    if (existing.code === 0) continue
    await run(['worktree', 'add', '-b', branch, path, commit], clone)
    const head = (await run(['rev-parse', 'HEAD'], path)).trim()
    if (head !== commit) throw new SourceError('SOURCE_WORKTREE_CONFLICT', 'The worktree is not at the approved commit.')
    return { branch, commit }
  }
  throw new SourceError('SOURCE_WORKTREE_CONFLICT', 'Too many branches already exist for this agent.')
}

export function systemGitWorktreePorts(environment: NodeJS.ProcessEnv = process.env): GitWorktreePorts {
  const home = environment.HOME ?? homedir()
  return {
    cloneDirectory: repository => join(home, '.local', 'share', 'foreman-code', 'git', ...repository.split('/')),
    // GitHub CLI credentials (gh auth setup-git) supply authentication; no prompt can block a Run.
    git: (args, options) => new Promise(resolve => {
      // Worktree files stay private to this user, like every other app-managed source directory.
      execFile('/bin/sh', ['-c', 'umask 077 && exec git "$@"', 'git', ...args], { ...(options.cwd ? { cwd: options.cwd } : {}), signal: options.signal, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8', env: { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
        resolve({ code, stdout, stderr })
      })
    }),
  }
}
