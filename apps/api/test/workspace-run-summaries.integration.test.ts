import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { SavedWorkflowRunSchema } from '@graphql/contracts/wave25'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

describe('workspace Run summaries', () => {
  it('opens with retained unsupported Runs and keeps accepted Runs readable', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const historicalIds: string[] = []
      for (const semantics of [1, 2, undefined, '3']) {
        const historical = { ...f.f.run, id: `historical-${randomUUID()}`, executionSemanticsVersion: semantics }
        historicalIds.push(historical.id)
        await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
          values($1,$2,$3,$4,'queued',$5::jsonb)`, [historical.id, historical.workspaceId,
          historical.workflowId, historical.workflowVersionId, JSON.stringify(historical)])
      }

      const details = await repository.getDetails(f.f.run.workspaceId, f.writer.principal)
      expect(details?.runs.map((run) => run.id)).toEqual([f.f.run.id])
      expect(details?.runs[0]).toMatchObject({ executionState: 'queued', outcome: 'pending', cleanupPending: false })
      const accepted = await f.services.runs.get(f.writer.principal, f.f.run.workspaceId, f.f.run.id)
      expect(accepted.run.id).toBe(f.f.run.id)
      expect(accepted.run.workflowVersionId).toBe(f.f.run.workflowVersionId)
      for (const runId of historicalIds) {
        expect(await f.services.runs.history.snapshot(f.writer.principal, {
          workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId, runId,
        })).toEqual({ snapshot: { workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId,
          runId, kind: 'unavailable', reason: 'legacy_run' } })
      }
      expect((await f.db.pool.query('select id from runs where id=any($1::text[])', [historicalIds])).rowCount).toBe(4)
    } finally {
      await f.close()
    }
  }, 60000)

  it('uses the same query count for one and twenty completed Runs', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      await f.services.runs.stopScheduleDispatcher()
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const finishedAt = new Date().toISOString()
      const stopCause = { kind: 'review_failure', interactionId: 'review-interaction',
        error: { code: 'REVIEW_FAILED', message: 'Review failed' }, recordedAt: finishedAt } as const
      const completed = SavedWorkflowRunSchema.parse({ ...f.f.run, executionState: 'completed',
        outcome: 'succeeded', result: { outcome: 'succeeded', output: {} }, finishedAt, stopCause })
      await f.db.pool.query("update runs set execution_state='completed',record=$2::jsonb where id=$1",
        [completed.id, JSON.stringify(completed)])
      const query = vi.spyOn(pg.Client.prototype, 'query')
      try {
        const short = await repository.getDetails(completed.workspaceId, f.writer.principal)
        expect(short?.runs).toHaveLength(1)
        const shortQueryCount = query.mock.calls.length
        query.mockRestore()
        for (let index = 1; index < 20; index++) {
          const historical = { ...completed, id: `completed-${randomUUID()}`,
            createdAt: new Date(Date.parse(completed.createdAt) - index * 1000).toISOString() }
          await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,
            record,created_at,runner_id,working_directory,location_revision)
            values($1,$2,$3,$4,'completed',$5::jsonb,$6::timestamptz,$7,$8,$9)`,
          [historical.id, historical.workspaceId, historical.workflowId, historical.workflowVersionId,
            JSON.stringify(historical), historical.createdAt, historical.executionLocation!.runnerId,
            historical.executionLocation!.rootPath, historical.executionLocation!.locationRevision])
        }
        const longQuery = vi.spyOn(pg.Client.prototype, 'query')
        try {
          const long = await repository.getDetails(completed.workspaceId, f.writer.principal)
          expect(long?.runs).toHaveLength(20)
          expect(long?.runs[0]).toMatchObject({ id: completed.id, executionState: 'completed',
            outcome: 'succeeded', finishedAt, stopCause, cleanupPending: false })
          expect(longQuery.mock.calls.length).toBe(shortQueryCount)
        } finally {
          longQuery.mockRestore()
        }
      } finally {
        query.mockRestore()
      }
    } finally {
      await f.close()
    }
  }, 60000)

  it('retains unfinished and cleanup-pending Runs beyond the recent history window', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const completedIds: string[] = []
      for (let index = 0; index < 21; index++) {
        const createdAt = new Date(Date.parse(f.f.run.createdAt) + (index + 1) * 1000).toISOString()
        const historical = SavedWorkflowRunSchema.parse({ ...f.f.run, id: `completed-${randomUUID()}`,
          createdAt, executionState: 'completed', outcome: 'succeeded', startedAt: createdAt,
          finishedAt: createdAt, result: { outcome: 'succeeded', output: {} } })
        completedIds.push(historical.id)
        await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,
          record,created_at) values($1,$2,$3,$4,'completed',$5::jsonb,$6::timestamptz)`,
        [historical.id, historical.workspaceId, historical.workflowId, historical.workflowVersionId,
          JSON.stringify(historical), createdAt])
      }
      await f.db.pool.query('insert into run_cleanup_intents(run_id) values($1)', [completedIds[0]])
      const details = await repository.getDetails(f.f.run.workspaceId, f.writer.principal)
      expect(details?.runs).toHaveLength(22)
      expect(details?.runs.find((run) => run.id === completedIds[0])).toMatchObject({ cleanupPending: true })
      expect(details?.runs.find((run) => run.id === completedIds[20])).toMatchObject({
        startedAt: expect.any(String), finishedAt: expect.any(String), cleanupPending: false,
      })
      expect(details?.runs.find((run) => run.id === f.f.run.id)).toMatchObject({ executionState: 'queued' })
    } finally {
      await f.close()
    }
  }, 60000)

  it('revalidates live read grants and refuses cached authority after narrowing or revocation', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const workspaceId = f.f.run.workspaceId
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const reader = await f.access.issue({ name: 'Workspace reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{
          actions: ['workspaces:read', 'workflows:read', 'agents:read', 'runs:read'],
          scope: { workspaceIds: [workspaceId] },
        }] })
      expect((await repository.getDetails(workspaceId, reader.principal))?.runs).toHaveLength(1)
      await expect(repository.getDetails('another-workspace', reader.principal)).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      })
      const records = (await f.db.pool.query('select record from runs where workspace_id=$1', [workspaceId])).rows
      await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [reader.principal.id,
        JSON.stringify([{ actions: ['workspaces:read', 'workflows:read', 'agents:read'],
          scope: { workspaceIds: [workspaceId] } }, { actions: ['runs:read'],
          scope: { workspaceIds: [workspaceId], runIds: [f.f.run.id] } }])])
      await expect(repository.getDetails(workspaceId, reader.principal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [reader.principal.id])
      await expect(repository.getDetails(workspaceId, reader.principal)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      expect((await f.db.pool.query('select record from runs where workspace_id=$1', [workspaceId])).rows).toEqual(records)
    } finally {
      await f.close()
    }
  }, 60000)

  it('rejects an oversized active set without truncating or changing persisted Runs', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const prefix = `queued-${randomUUID()}`
      await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
        select $1::text || '-' || n,$2,$3,$4,'queued',
          $5::jsonb || jsonb_build_object('id',$1::text || '-' || n)
        from generate_series(1,2000) as n`,
      [prefix, f.f.run.workspaceId, f.f.run.workflowId, f.f.run.workflowVersionId, JSON.stringify(f.f.run)])
      await expect(repository.getDetails(f.f.run.workspaceId, f.writer.principal)).rejects.toMatchObject({
        code: 'WORKSPACE_RUN_READ_TOO_LARGE', status: 409,
      })
      expect((await f.db.pool.query('select count(*)::int as count from runs where workspace_id=$1',
        [f.f.run.workspaceId])).rows[0]?.count).toBe(2001)
    } finally {
      await f.close()
    }
  }, 60000)
})
