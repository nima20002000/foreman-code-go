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
  // A fetch by object id succeeds locally when Main already holds the commit, so ask GitHub's branches instead.
  const fetched = await ports.git(['fetch', '--quiet', '--no-tags', '--prune', 'origin'], { cwd: clone, signal })
  if (fetched.code !== 0) {
    throw new SourceError('SOURCE_GITHUB_PUSH_REQUIRED', `Main could not read ${repository} from GitHub. `
      + 'Connect GitHub with push access on Main (gh auth login), then retry.')
  }
  const published = await ports.git(['for-each-ref', '--contains', commit, '--count=1', '--format=%(refname)', 'refs/remotes/origin'],
    { cwd: clone, signal })
  if (published.code === 0 && published.stdout.trim()) return
  const pushed = await ports.git(['push', '--quiet', 'origin', `${commit}:refs/heads/foreman/ci/${commit}`], { cwd: clone, signal })
  if (pushed.code !== 0) {
    throw new SourceError('SOURCE_GITHUB_PUSH_REQUIRED', `Main could not publish commit ${commit.slice(0, 12)} to ${repository}. `
      + 'Connect GitHub with push access on Main (gh auth login), then retry.')
  }
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
