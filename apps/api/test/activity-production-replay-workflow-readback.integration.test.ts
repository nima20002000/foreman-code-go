import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, completedRun } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: workflow-readback', { timeout: 120000 }, () => {
  it('Workflow: real Run snapshot/cursor and denied caller preserve original execution and delivery evidence', async () => {
    const f = await setup(), detail = await completedRun(f)
    expect(detail.activitySnapshot!.scope).toEqual({ kind: 'workflow_run', workspaceId: detail.run.workspaceId,
      workflowId: detail.run.workflowId, runId: detail.run.id, workflowVersionId: detail.run.workflowVersionId })
    expect(detail.activitySnapshot!.active).toEqual([])
    const readback = await f.call('run_get', { workspaceId: detail.run.workspaceId, runId: detail.run.id, detail: 'full' })
    expect(readback.isError).not.toBe(true)
    expect(SavedRunDetailsSchema.parse(decodeMcpToolResult(readback)).activitySnapshot).toEqual(detail.activitySnapshot)
    const activity = await f.call('run_activities_get_v1', { workspaceId: detail.run.workspaceId, runId: detail.run.id, limit: 10 })
    expect(activity.isError).not.toBe(true)
    expect(decodeMcpToolResult(activity)).toMatchObject({ scope: { workspaceId: detail.run.workspaceId,
      workflowId: detail.run.workflowId, runId: detail.run.id, workflowVersionId: detail.run.workflowVersionId } })
    expect(decodeMcpToolResult(activity)).not.toHaveProperty('activitySnapshot')
    const denied = await f.call('run_get', { workspaceId: detail.run.workspaceId, runId: detail.run.id }, f.denied.token)
    expect(denied.isError).toBe(true)
    await f.access.revoke(f.writer.principal.id)
    const revoked = await f.http('GET', `/api/management/workspaces/${detail.run.workspaceId}/runs/${detail.run.id}`)
    expect(revoked.statusCode).toBe(401)
    expect(f.replay.responses).toHaveLength(0)
    expect((await f.db.pool.query('select count(*)::int as count from harness_executions where run_id=$1', [detail.run.id])).rows[0]!.count)
      .toBe(detail.executions.length)
  })
})
