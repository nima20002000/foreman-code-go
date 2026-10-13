import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { SourceGitHubReferenceSchema } from '@foreman-code/contracts/source-operations'
import type { z } from 'zod'
import { ensureClone, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { SourceError } from './manifest.js'

/** Paired computers get code only from GitHub. Main makes sure GitHub serves an approved commit before a
 * computer needs it: an Agent's unpublished commit is pushed from Main's clone under refs/heads/foreman/ci/. */
export async function publishCommit(ports: GitWorktreePorts, repository: string, commit: string,
  signal: AbortSignal): Promise<void> {
  const clone = await ensureClone(ports, repository, signal)
  const local = await ports.git(['cat-file', '-e', `${commit}^{commit}`], { cwd: clone, signal })
  if (local.code !== 0) {
    // With no local object to satisfy negotiation, a successful fetch proves that origin serves the commit.
    const fetched = await ports.git(['fetch', '--quiet', '--no-tags', '--depth=1', '--no-write-fetch-head',
      'origin', commit], { cwd: clone, signal })
    if (fetched.code !== 0) throw githubReadFailure(repository)
    return
  }
  if (await remoteContainsCommit(ports, clone, repository, commit, signal)) return
  const pushed = await ports.git(['push', '--quiet', 'origin', `${commit}:refs/heads/foreman/ci/${commit}`], { cwd: clone, signal })
  if (pushed.code !== 0) {
    throw new SourceError('SOURCE_GITHUB_PUSH_REQUIRED', `Main could not publish commit ${commit.slice(0, 12)} to ${repository}. `
      + 'Connect GitHub with push access on Main (gh auth login), then retry.')
  }
}

async function remoteContainsCommit(ports: GitWorktreePorts, clone: string, repository: string,
  commit: string, signal: AbortSignal): Promise<boolean> {
  const read = (args: string[]) => ports.git(args, { cwd: clone, signal })
  const advertised = await read(['ls-remote', '--heads', 'origin'])
  if (advertised.code !== 0) throw githubReadFailure(repository)
  const tips = new Set(advertised.stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t')[0]!))
  if (tips.has(commit)) return true
  const missing: string[] = []
  for (const tip of tips) {
    const local = await read(['cat-file', '-e', `${tip}^{commit}`])
    if (local.code !== 0) {
      missing.push(tip)
      continue
    }
    if ((await read(['merge-base', '--is-ancestor', commit, tip])).code === 0) return true
  }
  if (missing.length === 0) return false
  // Fetch only unknown advertised tips; known ancestry needs no transfer or cache lock.
  const fetched = await read(['fetch', '--quiet', '--no-tags', '--depth=1', '--no-write-fetch-head',
    'origin', ...missing])
  if (fetched.code !== 0) throw githubReadFailure(repository)
  for (const tip of missing) {
    if ((await read(['merge-base', '--is-ancestor', commit, tip])).code === 0) return true
  }
  return false
}

function githubReadFailure(repository: string): SourceError {
  return new SourceError('SOURCE_GITHUB_PUSH_REQUIRED', `Main could not read ${repository} from GitHub. `
    + 'Connect GitHub with push access on Main (gh auth login), then retry.')
}

export class GitHubSourcePublisher {
  constructor(private readonly git: GitWorktreePorts = systemGitWorktreePorts()) {}

  async publish(manifest: SourceManifest, signal: AbortSignal): Promise<z.infer<typeof SourceGitHubReferenceSchema>> {
    const repository = manifest.git?.repository, commit = manifest.git?.commit
    if (!repository || !commit || manifest.capturePolicy !== 'git-tree-v1') {
      throw new SourceError('SOURCE_REPOSITORY_REQUIRED', 'Paired computers get source only from GitHub. '
        + 'Set the workspace GitHub repository (workspace_update), then retry.')
    }
    await publishCommit(this.git, repository, commit, signal)
    return { repository, commit, executablePolicy: manifest.executablePolicy }
  }
}
