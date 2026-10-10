import { runWorkspaceGit } from './defaultBranch.js'
import type { MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import { systemGitWorktreePorts } from './gitWorktree.js'
import { sourceWorkingTreePath } from './sourceTreePaths.js'
import type { RunWorktree } from '@foreman-code/contracts/wave25'
import type { GitWorktreePorts } from './gitWorktree.js'
import { DomainError } from '../errors.js'

export async function removeCommittedWorktree(ports: GitWorktreePorts, root: string,
  tree: RunWorktree, signal: AbortSignal): Promise<RunWorktree> {
  const listed = await runWorkspaceGit(ports, ['worktree', 'list', '--porcelain'], root, signal)
  if (!listed.split('\n').includes(`worktree ${tree.workingDirectory}`)) return { ...tree, state: 'removed' }
  const current = await ports.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: tree.workingDirectory, signal })
  if (current.code !== 0) {
    return { ...tree, state: 'retained', message: 'The worktree has no branch; the directory was retained.' }
  }
  const branch = current.stdout.trim()
  if (branch !== tree.branch) {
    return { ...tree, state: 'retained', message: 'The worktree branch changed; the directory was retained.' }
  }
  const status = await runWorkspaceGit(ports, ['status', '--porcelain', '--untracked-files=all'], tree.workingDirectory, signal)
  if (status) return { ...tree, state: 'retained', message: 'Uncommitted changes remain in this worktree.' }
  // Git refuses to remove ignored/untracked files too; preserve them instead of forcing deletion.
  const removed = await ports.git(['worktree', 'remove', tree.workingDirectory], { cwd: root, signal })
  if (removed.code !== 0) return { ...tree, state: 'retained', message: 'Git retained files in this worktree.' }
  await runWorkspaceGit(ports, ['worktree', 'prune'], root, signal)
  return { ...tree, state: 'removed' }
}


export async function closeSourceWorktree(receipt: MaterializationReceipt,
  signal = AbortSignal.timeout(30_000), ports = systemGitWorktreePorts()) {
  if (!receipt.worktree) return undefined
  const result = await removeCommittedWorktree(ports, ports.cloneDirectory(receipt.worktree.repository), {
    workingDirectory: sourceWorkingTreePath(receipt), branch: receipt.worktree.branch,
    baseCommit: receipt.worktree.startCommit ?? receipt.worktree.commit, state: 'active',
  }, signal)
  if (result.state === 'active') throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'Worktree cleanup is incomplete.', 409)
  return { state: result.state, ...(result.message ? { message: result.message } : {}) }
}
