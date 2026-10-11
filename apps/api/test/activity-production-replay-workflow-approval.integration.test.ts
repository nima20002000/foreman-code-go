import { GetInteractionResponseSchema } from '@foreman-code/contracts'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, admittedRun, eventually } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: workflow-approval', { timeout: 120000 }, () => {
  it('Workflow approval: live callback is qualified; recorded choice and provider/worker acknowledgment remain distinct', async () => {
    const f = await setup(), started = await admittedRun(f, 'approval'), workspaceId = started.run.workspaceId
    const detail = await eventually(async () => SavedRunDetailsSchema.parse((await f.http('GET',
      `/api/management/workspaces/${workspaceId}/runs/${started.run.id}`)).json()),
    (value) => value.activitySnapshot!.pendingInteractions.length > 0)
    const interaction = detail.activitySnapshot!.pendingInteractions[0]!
    // Request publication precedes the checkpoint binding, which advances its public revision.
    const view = await eventually(async () => {
      const response = await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, '')
      expect(response.statusCode, response.body).toBe(200)
      return GetInteractionResponseSchema.parse(response.json())
    }, (value) => !!value.interaction.graphInterruptId)
    const current = view.interaction
    expect(current.revision).toBeGreaterThan(0)
    expect(view).toMatchObject({ canRespond: true, activity: { phase: 'needs_answer', answerRecorded: false,
      nativeDelivery: 'not_started', workerAcknowledgment: 'unknown', response: { available: true, path: 'live_callback' } } })
    const choice = current.responseOptions.find((option) => option.semantic === 'approve_once')!
    const stale = await f.http('POST', `/api/user/interactions/${interaction.id}/respond`, {
      interactionId: interaction.id, expectedRevision: current.revision - 1, optionId: choice.optionId,
    }, '')
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('REVISION_CONFLICT')
    expect(f.replay.responses).toHaveLength(0)
    const unchanged = GetInteractionResponseSchema.parse((await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, '')).json())
    expect(unchanged.interaction).toMatchObject({ revision: current.revision, status: 'pending',
      graphInterruptId: current.graphInterruptId, nativeSessionId: current.nativeSessionId, nativeRequestId: current.nativeRequestId })
    const authoritative = (await f.db.pool.query<{ revision: string; graph_interrupt_id: string }>(`
      select revision::text,record->>'graphInterruptId' as graph_interrupt_id from durable_interactions where id=$1`, [interaction.id])).rows[0]!
    expect(authoritative).toEqual({ revision: String(current.revision), graph_interrupt_id: current.graphInterruptId })
    const answer = await f.http('POST', `/api/user/interactions/${interaction.id}/respond`, {
      interactionId: interaction.id, expectedRevision: current.revision, optionId: choice.optionId,
    }, '')
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json().interaction.deliveryState).not.toBe('delivered')
    expect(f.replay.responses).toHaveLength(1)
    const recorded = await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, '')
    expect(recorded.json().activity.answerRecorded).toBe(true)
    expect(recorded.json().activity.workerAcknowledgment).toBe('unknown')
    expect(recorded.json().activity.response.available).toBe(false)
    const nativeSessionId = current.nativeSessionId
    const nativeTurnId = f.replay.starts.find((entry) => entry.sessionId === nativeSessionId)!.nativeTurnId
    f.replay.commandCompleted(nativeSessionId, nativeTurnId)
    f.replay.complete(nativeSessionId, nativeTurnId, 'recorded post-approval final')
    await f.reconcile()
    const persisted = (await f.db.pool.query('select record from durable_interactions where id=$1', [interaction.id])).rows[0]!.record
    expect(persisted.id).toBe(current.id)
    expect(persisted.nativeSessionId).toBe(nativeSessionId)
    expect(persisted.nativeRequestId).toBe(current.nativeRequestId)
    expect(f.replay.responses).toHaveLength(1)
  })
})
