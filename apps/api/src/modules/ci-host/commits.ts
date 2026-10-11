import { ensureClone, ensureCommit, fetchRepositoryBranch, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { importAgentSnapshot } from '../sources/agentSnapshot.js'
import { publishCommit } from '../sources/githubPublisher.js'
import type { CiCommits } from './service.js'
import { CiDurationsSchema } from '@foreman-code/contracts'

/** Main's clone of the workspace repository: the requested commit, an Agent's files as a commit on its base, or the
 * default branch head; whatever GitHub lacks is pushed so build computers can fetch it. */
export class GitCiCommits implements CiCommits {
  constructor(private readonly git: GitWorktreePorts = systemGitWorktreePorts()) {}

  async unitInventory(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    const read = (args: string[]) => this.git.git(args, { cwd: clone, signal })
    const [tree, timings, heavy] = await Promise.all([
      read(['ls-tree', '-r', '--name-only', commit]),
      read(['show', `${commit}:scripts/unit-durations.json`]),
      read(['show', `${commit}:apps/web/heavy-tests.json`]),
    ])
    if (tree.code !== 0) throw new Error('Could not read the CI commit inventory.')
    const files = tree.stdout.trim().split('\n').filter(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
      && !/(?:^|\/)(?:node_modules|dist|\.git)\//.test(file)
      && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file))
      && (!file.startsWith('apps/web/') || /^apps\/web\/src\/.*\.(?:test|spec)\.tsx?$/.test(file)))
    return { files, durations: timings.code === 0 ? CiDurationsSchema.parse(JSON.parse(timings.stdout)) : {},
      heavy: heavy.code === 0 ? (JSON.parse(heavy.stdout) as { files: string[] }).files : [] }
  }

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
