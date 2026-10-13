import { latestDefaultCommit, runWorkspaceGit } from '../sources/defaultBranch.js'
import { withTransaction } from '../../infrastructure/transaction.js'
export { latestDefaultCommit } from '../sources/defaultBranch.js'
import { removeCommittedWorktree } from '../sources/worktreeCleanup.js'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { RunWorktreeSchema, type RunWorktree, type AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { ensureWorktreeGitIdentity, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { DomainError } from '../errors.js'

type Sql = Pick<pg.PoolClient, 'query'>

/** Ordinary Runs share a directory within the Run, while separate Runs never share a checkout. */
export class RunWorktrees {
  constructor(private readonly pool: pg.Pool, private readonly managedRoot: string,
    private readonly ports: GitWorktreePorts = systemGitWorktreePorts()) {}

  async prepare(run: AcceptedWorkflowRunV3, signal = AbortSignal.timeout(60_000)): Promise<RunWorktree | undefined> {
    return withTransaction(this.pool, async (sql) => {
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`run-worktree:${run.id}`])
      const previous = await this.read(sql, run.id)
      if (previous) {
        if (previous.record.state !== 'active') throw new DomainError('RUN_WORKTREE_CLOSED', 'The Run worktree is already closed.', 409)
        await this.verify(previous.record, signal)
        return previous.record
      }
      const started = (await sql.query<{ directory: string }>(
        `select record->>'workingDirectory' as directory from harness_executions
          where run_id=$1 and record->>'workingDirectory' is not null limit 1`, [run.id])).rows[0]
      if (started) {
        if (started.directory !== run.executionLocation.rootPath) {
          throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The accepted execution directory has no worktree record.', 409)
        }
        // Already entered executions retain their original accepted directory across upgrades.
        return undefined
      }
      const terminal = (await sql.query<{ execution_state: string }>('select execution_state from runs where id=$1', [run.id])).rows[0]
      if (!terminal || ['completed', 'interrupted'].includes(terminal.execution_state)) {
        throw new DomainError('RUN_WORKTREE_CLOSED', 'A terminal Run cannot allocate a worktree.', 409)
      }
      const root = run.executionLocation.rootPath
      const probe = await this.ports.git(['rev-parse', '--show-toplevel'], { cwd: root, signal })
      if (probe.code !== 0) {
        if (!probe.stderr.includes('not a git repository')) {
          throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The workspace Git repository could not be inspected.', 409)
        }
        return undefined
      }
      const repositoryRoot = probe.stdout.trim()
      const baseCommit = await latestDefaultCommit(this.ports, repositoryRoot, signal)
      const namespace = createHash('sha256').update(run.workspaceId).digest('hex')
      const branch = `foreman/run-${createHash('sha256').update(run.id).digest('hex')}`
      const workingDirectory = join(this.managedRoot, namespace, branch.slice('foreman/'.length))
      await mkdir(join(workingDirectory, '..'), { recursive: true, mode: 0o700 })
      const listed = await runWorkspaceGit(this.ports, ['worktree', 'list', '--porcelain'], repositoryRoot, signal)
      // A crash between allocation and SQL commit can leave the original checkout behind.
      if (!listed.split('\n').includes(`worktree ${workingDirectory}`)) {
        await runWorkspaceGit(this.ports, ['worktree', 'add', '-b', branch, workingDirectory, baseCommit], repositoryRoot, signal)
      }
      const actualBase = await runWorkspaceGit(this.ports, ['rev-parse', 'HEAD'], workingDirectory, signal)
      const record = RunWorktreeSchema.parse({ workingDirectory, branch, baseCommit: actualBase, state: 'active' })
      await this.verify(record, signal)
      await sql.query('insert into run_worktrees(run_id,repository_root,record) values($1,$2,$3::jsonb)',
        [run.id, repositoryRoot, JSON.stringify(record)])
      return record
    })
  }

  async verify(tree: RunWorktree, signal = AbortSignal.timeout(10_000)): Promise<void> {
    const branch = await runWorkspaceGit(this.ports, ['symbolic-ref', '--quiet', '--short', 'HEAD'], tree.workingDirectory, signal)
    if (branch !== tree.branch) throw new DomainError('RUN_WORKTREE_CHANGED', 'The Run worktree is on another branch.', 409)
    await ensureWorktreeGitIdentity(this.ports, tree.workingDirectory, signal)
  }

  private async read(sql: Sql, runId: string) {
    const row = (await sql.query<{ repository_root: string; record: unknown }>(
      'select repository_root,record from run_worktrees where run_id=$1', [runId])).rows[0]
    return row ? { root: row.repository_root, record: RunWorktreeSchema.parse(row.record) } : undefined
  }

  async cleanup(report: (error: unknown) => void): Promise<void> {
    const rows = await this.pool.query<{ run_id: string }>(`select w.run_id from run_worktrees w join runs r on r.id=w.run_id
      where w.record->>'state'='active' and r.execution_state in ('completed','interrupted')
      and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
      and not exists(select 1 from execution_native_sessions n join harness_executions e on e.id=n.execution_id
        where e.run_id=r.id and n.workflow_finalized_at is null)
      order by w.created_at limit 100`)
    for (const row of rows.rows) {
      try { await this.cleanupRun(row.run_id) } catch (error) { report(error) }
    }
  }

  private async cleanupRun(runId: string): Promise<void> {
    return withTransaction(this.pool, async (sql) => {
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`run-worktree:${runId}`])
      const tree = await this.read(sql, runId)
      if (tree?.record.state === 'active') {
        const record = await removeCommittedWorktree(this.ports, tree.root, tree.record, AbortSignal.timeout(30_000))
        await sql.query('update run_worktrees set record=$2::jsonb where run_id=$1', [runId, JSON.stringify(record)])
      }
    })
  }
}
