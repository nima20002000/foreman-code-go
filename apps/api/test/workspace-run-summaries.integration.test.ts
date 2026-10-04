import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

describe('workspace Run summaries', () => {
  it('opens with retained unsupported Runs and keeps accepted Runs readable', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const historicalIds: string[] = []
      for (const semantics of [1, 2, undefined]) {
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
      expect((await f.db.pool.query('select id from runs where id=any($1::text[])', [historicalIds])).rowCount).toBe(3)
    } finally {
      await f.close()
    }
  }, 60000)
})
