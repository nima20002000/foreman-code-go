import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { ManagementPrincipalSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture, type RunWorktree } from '@foreman-code/contracts/wave25'
import { readCurrentRunDetails } from '../src/modules/runs/currentRead.js'
import { readAcceptedRepeatRunLocked, readRecordedRepeatRunSnapshot } from '../src/modules/runs/repeatStartRead.js'
import { readRepeatExecutionLocked } from '../src/modules/runs/repeatPostgres.js'
import { RUN_ACTIVITIES_BOUNDS_SQL, RUN_ACTIVITIES_PAGE_SQL } from '../src/modules/runs/activitiesSql.js'
import { RUN_NATIVE_ACTIVITY_FACTS_SQL } from '../src/modules/runs/nativeActivitySnapshot.js'

// The immutable publication readers are ports here; live grants, transaction
// ownership, bounded queries and public redaction run their real implementations.
vi.mock('../src/modules/runs/repeatStartRead.js', () => ({ readAcceptedRepeatRunLocked: vi.fn(), readRecordedRepeatRunSnapshot: vi.fn() }))
vi.mock('../src/modules/runs/repeatPostgres.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/modules/runs/repeatPostgres.js')>(), readRepeatExecutionLocked: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

function fixture() {
  const f = makeCurrentWorkflowFixture('history', 'single')
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: 'private-authority',
    executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded', output: { text: 'saved-result' } },
    finishedAt: f.createdAt, executionLocation: { runnerId: 'runner', rootPath: '/private/project', locationRevision: 1,
      identityHash: `sha256:${'1'.repeat(64)}` } })
  const { executionId, ...identity } = f.identities[0]!
  const execution = { ...identity, id: executionId, runId: run.id,
    input: {}, state: 'completed' as const, result: run.result, createdAt: f.createdAt, finishedAt: f.createdAt,
    workingDirectory: '/private/project', runtimeDirectory: '/private/runtime' }
  const worktree: RunWorktree = { workingDirectory: '/private/worktree', branch: 'run-branch',
    baseCommit: 'a'.repeat(40), state: 'retained' }
  const principal = ManagementPrincipalSchema.parse({ id: 'history-reader', name: 'History reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['runs:read'], scope: { workspaceIds: [run.workspaceId], workflowIds: [run.workflowId], runIds: [run.id] } }] })
  let liveGrants: ManagementGrant[] = structuredClone(principal.grants)
  let revoked = false
  vi.mocked(readRecordedRepeatRunSnapshot).mockResolvedValue({ run, version: f.version,
    configurations: f.configurations, stopRequested: false, cleanupPending: false } as Awaited<ReturnType<typeof readAcceptedRepeatRunLocked>>)
  vi.mocked(readRepeatExecutionLocked).mockResolvedValue({ execution, ref: { nodeId: execution.workflowNodeId, occurrence: null },
    slotId: 'history-slot', input: { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] },
    inputDigest: `sha256:${'1'.repeat(64)}`, accepted: true })
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (/^(begin|commit|rollback)/.test(sql)) return { rows: [] }
    if (sql.startsWith('select workspace_id,workflow_id from runs')) {
      expect(values).toEqual([run.id, run.workspaceId])
      return { rows: [{ workspace_id: run.workspaceId, workflow_id: run.workflowId }] }
    }
    if (sql.includes('from management_principals')) return { rows: [{ id: principal.id, name: principal.name,
      audience: 'operator', grants: liveGrants, expires_at: new Date(principal.expiresAt),
      revoked_at: revoked ? new Date() : null, delegated_from: null }] }
    if (sql.startsWith('select activity_record_revision::text as revision,stop_requested_at')) {
      expect(values).toEqual([run.id, run.workspaceId, run.workflowId, run.workflowVersionId])
      return { rows: [{ revision: '1', stopped: false, outcome: run.outcome, started_at: null, execution_state: run.executionState }] }
    }
    if (sql === RUN_NATIVE_ACTIVITY_FACTS_SQL) { expect(values).toEqual([run.id]); return { rows: [] } }
    if (sql === RUN_ACTIVITIES_PAGE_SQL.replace('__COMPARATOR__', '<=').replace('__ORDER__', 'desc')) {
      expect(values).toEqual([run.id, '0', '0', '0', 101]); return { rows: [] }
    }
    if (sql.startsWith('select e.id,e.attempt,e.activity_record_revision')) {
      expect(values).toEqual([run.id, run.workspaceId])
      return { rows: [{ id: execution.id, attempt: 1, revision: '1', state: execution.state, outcome: execution.result?.outcome,
        created_at: f.createdAt, started_at: null, native_session_id: null, harness: null, native_revision: '0' }] }
    }
    if (sql.includes('from workflow_job_executions')) { expect(values).toEqual([run.id, run.workspaceId, run.workflowId, run.workflowVersionId]); return { rows: [] } }
    if (sql.includes('from ci_runs')) return { rows: [] }
    if (sql.includes('from durable_interactions')) { expect(values).toEqual([run.id, run.workspaceId, run.workflowId]); return { rows: [] } }
    if (sql === RUN_ACTIVITIES_BOUNDS_SQL) { expect(values).toEqual([run.id]); return { rows: [{ high_water: '0', retained_from: '0', observed: 0 }] } }
    if (sql.includes('from harness_executions')) return { rows: [{ id: execution.id }] }
    if (sql.includes('from run_activity')) return { rows: [] }
    if (sql.includes('from run_cleanup_intents')) return { rows: [{ pending: false }] }
    if (sql.includes('from run_worktrees')) return { rows: [{ record: worktree }] }
    if (sql.includes('from source_execution_materializations')) return { rows: [] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const release = vi.fn()
  const pool = { connect: async () => ({ query, release, on() {}, removeListener() {} }) } as unknown as pg.Pool
  return { ...f, run, execution, worktree, principal, query, release,
    read: () => readCurrentRunDetails(pool, principal, run.workspaceId, run.id),
    grants: (value: ManagementGrant[]) => { liveGrants = value }, revoke: () => { revoked = true } }
}

describe('saved current Run read', () => {
  it('returns the exact V3 Run and accepted execution without exposing private location or authority', async () => {
    const f = fixture()
    const value = await f.read()
    expect(value.run).toMatchObject({ executionSemanticsVersion: 3, workflowVersionId: f.version.id,
      agentConfigurationVersionIds: f.version.agentConfigurationVersionIds, result: { output: { text: 'saved-result' } } })
    expect(value.executions[0]).toMatchObject({ id: f.execution.id, agentConfigurationVersionId: f.configurations[0]!.id })
    expect(value.activitySnapshot).toMatchObject({ scope: { runId: f.run.id, workflowVersionId: f.version.id }, active: [], queued: [] })
    expect(JSON.stringify(value)).not.toMatch(/private-authority|private\/project|private\/runtime|private\/worktree/)
    expect(value).not.toHaveProperty('worktrees')
    expect(readRepeatExecutionLocked).toHaveBeenCalledWith(expect.objectContaining({ transaction: true }),
      expect.objectContaining({ run: f.run }), f.execution.id)
    expect(f.query).toHaveBeenCalledWith('commit')
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('uses live location grants instead of the stale transport principal', async () => {
    const f = fixture()
    f.grants([...f.principal.grants, { actions: ['workspace_locations:read'], scope: { workspaceIds: [f.run.workspaceId] } }])
    const value = await f.read()
    expect(value.run.executionLocation).toEqual(f.run.executionLocation)
    expect(value.executions[0]?.workingDirectory).toBe('/private/project')
    expect(value.worktrees).toEqual([f.worktree])
    expect(value.run).not.toHaveProperty('authorizationPrincipalId')
  })

  it.each(['wrong-run', 'revoked'])('rejects %s authority before reading saved facts', async (kind) => {
    const f = fixture()
    if (kind === 'revoked') f.revoke()
    else f.grants([{ actions: ['runs:read'], scope: { runIds: ['foreign-run'] } }])
    await expect(f.read()).rejects.toMatchObject({ status: 403 })
    expect(readRecordedRepeatRunSnapshot).not.toHaveBeenCalled()
    expect(readRepeatExecutionLocked).not.toHaveBeenCalled()
    expect(f.query).toHaveBeenCalledWith('rollback')
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('propagates an immutable execution pin conflict without returning partial history', async () => {
    const f = fixture()
    vi.mocked(readRepeatExecutionLocked).mockRejectedValue(new Error('execution pin changed'))
    await expect(f.read()).rejects.toThrow('execution pin changed')
    expect(f.query).not.toHaveBeenCalledWith('commit')
    expect(f.query).toHaveBeenCalledWith('rollback')
  })
})
