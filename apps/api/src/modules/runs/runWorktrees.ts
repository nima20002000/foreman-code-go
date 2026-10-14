import { latestDefaultCommit, runWorkspaceGit } from '../sources/defaultBranch.js'
import { withClientTransaction } from '../../infrastructure/transaction.js'
import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger } from '../diagnostics/logger.js'
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

  private async exclusive<T>(runId: string, signal: AbortSignal,
    work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    const key = `run-worktree:${runId}`
    let discard = false
    try {
      for (;;) {
        signal.throwIfAborted()
        const result = await client.query<{ locked: boolean }>(
          'select pg_try_advisory_lock(hashtext($1)) as locked', [key])
        if (result.rows[0]?.locked) break
        await delay(25, undefined, { signal })
      }
      signal.throwIfAborted()
      return await work(client)
    } catch (error) {
      discard = true
      throw error
    } finally {
      if (!discard) {
        try { await client.query('select pg_advisory_unlock(hashtext($1))', [key]) }
        catch (error) {
          discard = true
          componentLogger('db').warn({ err: error }, 'Run worktree session lock could not be released.')
        }
      }
      client.release(discard)
    }
  }

  private async requireActiveRun(sql: Sql, runId: string): Promise<void> {
    const terminal = (await sql.query<{ execution_state: string }>(
      'select execution_state from runs where id=$1 for share', [runId])).rows[0]
    if (!terminal || ['completed', 'interrupted'].includes(terminal.execution_state)) {
      throw new DomainError('RUN_WORKTREE_CLOSED', 'A terminal Run cannot allocate a worktree.', 409)
    }
  }

  private async inspectAllocation(sql: Sql, run: AcceptedWorkflowRunV3) {
    const previous = await this.read(sql, run.id)
    if (previous) {
      if (previous.record.state !== 'active') {
        throw new DomainError('RUN_WORKTREE_CLOSED', 'The Run worktree is already closed.', 409)
      }
      return { kind: 'existing' as const, tree: previous }
    }
    const started = (await sql.query<{ directory: string }>(
      `select record->>'workingDirectory' as directory from harness_executions
        where run_id=$1 and record->>'workingDirectory' is not null limit 1`, [run.id])).rows[0]
    if (started) {
      if (started.directory !== run.executionLocation.rootPath) {
        throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The accepted execution directory has no worktree record.', 409)
      }
      return { kind: 'skip' as const }
    }
    await this.requireActiveRun(sql, run.id)
    return { kind: 'allocate' as const }
  }

  private async reserveAllocation(sql: pg.PoolClient, run: AcceptedWorkflowRunV3, signal: AbortSignal) {
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
    const record = RunWorktreeSchema.parse({ workingDirectory, branch, baseCommit, state: 'active' })
    return withClientTransaction(sql, async () => {
      await this.requireActiveRun(sql, run.id)
      // Persist cleanup ownership before allocating files or losing a Git acknowledgment.
      await sql.query('insert into run_worktrees(run_id,repository_root,record) values($1,$2,$3::jsonb)',
        [run.id, repositoryRoot, JSON.stringify(record)])
      return { root: repositoryRoot, record }
    })
  }

  async prepare(run: AcceptedWorkflowRunV3, signal = AbortSignal.timeout(60_000)): Promise<RunWorktree | undefined> {
    return this.exclusive(run.id, signal, async sql => {
      const state = await withClientTransaction(sql, () => this.inspectAllocation(sql, run))
      if (state.kind === 'skip') return undefined
      const tree = state.kind === 'existing' ? state.tree : await this.reserveAllocation(sql, run, signal)
      if (!tree) return undefined
      const { workingDirectory, branch, baseCommit } = tree.record
      const listed = await runWorkspaceGit(this.ports, ['worktree', 'list', '--porcelain'], tree.root, signal)
      if (!listed.split('\n').includes(`worktree ${workingDirectory}`)) {
        await withClientTransaction(sql, () => this.requireActiveRun(sql, run.id))
        await mkdir(join(workingDirectory, '..'), { recursive: true, mode: 0o700 })
        const existing = await this.ports.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
          { cwd: tree.root, signal })
        const args = existing.code === 0 ? ['worktree', 'add', workingDirectory, branch]
          : ['worktree', 'add', '-b', branch, workingDirectory, baseCommit]
        await runWorkspaceGit(this.ports, args, tree.root, signal)
        await withClientTransaction(sql, () => this.requireActiveRun(sql, run.id))
      }
      await this.verify(tree.record, signal)
      return tree.record
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
    const signal = AbortSignal.timeout(30_000)
    return this.exclusive(runId, signal, async sql => {
      const tree = await withClientTransaction(sql, async () => {
        const eligible = await sql.query(`select 1 from runs r where r.id=$1
          and r.execution_state in ('completed','interrupted')
          and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
          and not exists(select 1 from execution_native_sessions n join harness_executions e on e.id=n.execution_id
            where e.run_id=r.id and n.workflow_finalized_at is null) for share`, [runId])
        return eligible.rowCount === 1 ? this.read(sql, runId) : undefined
      })
      if (tree?.record.state !== 'active') return
      const record = await removeCommittedWorktree(this.ports, tree.root, tree.record, signal)
      await withClientTransaction(sql, async () => {
        await sql.query('update run_worktrees set record=$2::jsonb where run_id=$1', [runId, JSON.stringify(record)])
      })
    })
  }
}
