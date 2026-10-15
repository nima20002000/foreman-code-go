import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { faultWorkflowFixture } from './helpers/faultWorkflowFixture.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('workflow resilience to a failed loop check', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>
  beforeAll(async () => { fixture = await faultWorkflowFixture({ loop: true }) }, 10_000)
  afterAll(async () => { await fixture?.close() }, 10_000)

  it('records a failed check while sibling work completes and the loop remains active', async () => {
    await fixture.launch()
    const before = await fixture.active()
    const remote = before.executions.find(execution => execution.workflowNodeId === fixture.affected.id)!
    const checking = await readUntil(fixture.readExecutions, executions => executions.some(execution =>
      execution.workflowNodeId === fixture.entry.id && execution.state === 'running'
        && typeof execution.input === 'object' && execution.input !== null && 'tick' in execution.input
        && fixture.worker.replay.starts.some(turn => turn.correlationId === `execution:${execution.id}`)),
    { timeoutMs: 12_000, minimumReadIntervalMs: 250, description: 'the scheduled loop check beside graph work' })
    const check = checking.find(execution => typeof execution.input === 'object'
      && execution.input !== null && 'tick' in execution.input)!
    const turn = fixture.worker.replay.starts.find(item => item.correlationId === `execution:${check.id}`)!
    const thread = fixture.worker.replay.threads.get(turn.sessionId)!
    const native = thread.turns.find(item => item.id === turn.nativeTurnId)!
    native.status = 'failed'
    native.error = { message: 'LOOP_CHECK_FAILED', codexErrorInfo: 'internalServerError' }
    fixture.worker.replay.channels.get(turn.sessionId)!.notify('turn/completed', {
      threadId: turn.sessionId, turn: structuredClone(native),
    })
    await readUntil(fixture.readExecutions, executions =>
      executions.find(execution => execution.id === check.id)?.state === 'completed',
    { timeoutMs: 2_000, minimumReadIntervalMs: 250, description: 'the failed loop check being recorded' })
    const failed = await fixture.read()
    expect(failed.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
    expect(failed.cleanupPending).toBe(false)
    expect(failed.executions.find(execution => execution.id === remote.id)).toMatchObject({
      state: 'running', attempt: 1, nativeSessionId: remote.nativeSessionId,
    })
    fixture.release()
    await readUntil(fixture.readExecutions, executions =>
      [fixture.affected.id, fixture.sibling.id].every(nodeId => executions.some(execution =>
        execution.workflowNodeId === nodeId && execution.result?.outcome === 'succeeded')),
    { timeoutMs: 2_000, minimumReadIntervalMs: 250, description: 'successful sibling work after the failed check' })
    const details = await fixture.read()
    expect(details.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
    expect(details.executions.filter(execution => execution.result?.outcome === 'failed').map(execution => execution.id))
      .toEqual([check.id])
    expect(details.executions.filter(execution => execution.workflowNodeId === fixture.sibling.id)).toHaveLength(1)
    const nativeEvents = (await fixture.base.db.pool.query<{ record: HarnessNativeEvent }>(
      'select record from harness_native_events where execution_id=$1 order by sequence', [check.id])).rows
    expect(nativeEvents.some(({ record }) => record.type === 'turn.completed'
      && record.payload.status === 'failed')).toBe(true)
    expect(details.activitySnapshot.activities.some(activity => activity.kind === 'diagnostic'
      && activity.owner.kind === 'execution' && activity.owner.executionId === check.id
      && /failed/i.test(activity.message))).toBe(true)
    const response = await fixture.base.client.callTool({ name: 'run_get', arguments: {
      workspaceId: fixture.base.f.run.workspaceId, runId: fixture.base.f.run.id, detail: 'full',
    } })
    expect(response.isError).not.toBe(true)
    const persisted = SavedRunDetailsSchema.parse(decodeMcpToolResult(response))
    expect(persisted.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
    expect(persisted.executions.find(execution => execution.id === check.id)?.result?.outcome).toBe('failed')
    expect(persisted.activitySnapshot.activities.some(activity => activity.kind === 'diagnostic'
      && activity.owner.kind === 'execution' && activity.owner.executionId === check.id
      && /failed/i.test(activity.message))).toBe(true)
    const denied = await fixture.base.access.issue({ name: 'Other workspace reader', audience: 'operator',
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['workspace-outside-scope'] } }] })
    const deniedClient = await fixture.base.connect(denied.token)
    expect((await deniedClient.callTool({ name: 'run_get', arguments: {
      workspaceId: fixture.base.f.run.workspaceId, runId: fixture.base.f.run.id, detail: 'full',
    } })).isError).toBe(true)
    expect(await fixture.base.runs.get(fixture.base.f.run.id))
      .toMatchObject({ executionState: 'running', outcome: 'pending' })
  }, 19_000)
})
