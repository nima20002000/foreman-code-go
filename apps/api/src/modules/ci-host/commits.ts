import { ensureClone, ensureCommit, fetchRepositoryBranch, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { importAgentSnapshot } from '../sources/agentSnapshot.js'
import { publishCommit } from '../sources/githubPublisher.js'
import type { CiCommits } from './service.js'

/** Main's clone of the workspace repository: the requested commit, an Agent's files as a commit on its base, or the
 * default branch head; whatever GitHub lacks is pushed so build computers can fetch it. */
export class GitCiCommits implements CiCommits {
  constructor(private readonly git: GitWorktreePorts = systemGitWorktreePorts()) {}

  async resolve(repository: string, defaultBranch: string, commit: string | undefined,
    snapshot: { baseCommit: string; commit: string; bundle: Buffer } | null): Promise<string> {
    const signal = AbortSignal.timeout(180_000)
    let resolved = commit
    if (!resolved && snapshot) {
      const clone = await ensureCommit(this.git, repository, snapshot.baseCommit, signal)
      await importAgentSnapshot(this.git, clone, snapshot, signal)
      resolved = snapshot.commit
    }
    if (!resolved) {
      const clone = await ensureClone(this.git, repository, signal)
      resolved = await fetchRepositoryBranch(this.git, clone, repository, defaultBranch, signal)
    }
    await publishCommit(this.git, repository, resolved, signal)
    return resolved
  }
}
