import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentChatStateSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'

it('forks and recovers historical chat on its accepted Worker instead of the Agent default host', async () => {
  const fixture = await remoteReviewProduction({ workflow: 'single' })
  try {
    const started = await fixture.start()
    const before = await waitForRemoteReview(async () => {
      await fixture.reconcile()
      return fixture.details(started.run.id)
    }, value => value.run.executionState === 'completed', 'completed source Run')
    const execution = before.executions[0]!
    expect(execution.nativeSessionId).toBeTruthy()
    const workspaceId = fixture.version.workspaceId
    const selection = { workflowId: fixture.version.workflowId, runId: started.run.id,
      workflowNodeId: execution.workflowNodeId, executionId: execution.id }
    const read = async () => {
      const result = ReadSelectedRunChatResponseSchema.parse(await fixture.value('agent_chat_read', { workspaceId, selection }))
      if (result.kind !== 'selected') throw new Error('Expected the selected execution chat')
      return result.state
    }
    expect((await read()).conversation).toBeNull()
    const reader = await fixture.access.issue({ name: 'Historical chat reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    const message = { requestId: randomUUID(), content: 'Continue the saved task.', expectedConversationId: null }
    const denied = await fixture.call('agent_chat_send', { workspaceId, selection, message }, reader.token)
    expect(denied.isError).toBe(true)
    expect((await read()).conversation).toBeNull()
    const accepted = SendAgentChatMessageResponseSchema.parse(await fixture.value('agent_chat_send', {
      workspaceId, selection, message,
    }))
    const completed = await waitForRemoteReview(read, state => state.turns.some(turn =>
      turn.requestId === message.requestId && turn.delivery === 'completed'), 'Worker chat fork completion')
    expect(completed.conversation?.nativeSession?.nativeSessionId).not.toBe(execution.nativeSessionId)
    expect(completed.conversation?.origin).toEqual({ kind: 'run_execution', runId: started.run.id,
      executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId })
    const id = accepted.state.conversation!.id
    const saved = (await fixture.db.pool.query<{ worker_conversation_binding: unknown }>(
      'select worker_conversation_binding from operator_conversations where id=$1', [id])).rows[0]!
    const binding = WorkerConversationBindingSchema.parse(saved.worker_conversation_binding)
    expect(binding.profile.target.hostRef).toEqual(fixture.hostRef)
    expect(binding.profile.instanceId).toBe(fixture.profiles[0]!.instanceId)
    expect(binding.sourceExecution?.executionId).toBe(execution.id)
    const followUp = { requestId: randomUUID(), content: 'Continue after recovery.', expectedConversationId: id }
    await fixture.provider.blockModels()
    try {
      await fixture.restartMain({ mode: 'graceful' })
      const recovered = AgentChatStateSchema.parse(await read())
      expect(recovered.conversation?.nativeSession).toEqual(completed.conversation?.nativeSession)
      expect(recovered.messages.some(entry => entry.content === message.content)).toBe(true)
      expect(recovered.availability.canSend).toBe(false)
      const pending = await fixture.call('agent_chat_send', { workspaceId, selection, message: followUp })
      expect(pending.isError).toBe(true)
      expect((await read()).turns.some(turn => turn.requestId === followUp.requestId)).toBe(false)
      const stored = await fixture.db.pool.query(`select request_id from operator_conversation_turns
        where conversation_id=$1 and request_id=$2`,
        [id, followUp.requestId])
      expect(stored.rows).toHaveLength(0)
    } finally { await fixture.provider.releaseModels() }
    await waitForRemoteReview(read, state => state.availability.canSend, 'requalified Worker chat profile')
    await fixture.value('agent_chat_send', { workspaceId, selection, message: followUp })
    const resumed = await waitForRemoteReview(read, state => {
      const turn = state.turns.find(turn => turn.requestId === followUp.requestId)
      expect(turn?.delivery, JSON.stringify(turn?.error)).not.toBe('failed')
      return turn?.delivery === 'completed'
    }, 'recovered Worker chat continuation')
    expect(resumed.turns.find(turn => turn.requestId === followUp.requestId)?.error).toBeUndefined()
    expect(resumed.conversation?.nativeSession).toEqual(completed.conversation?.nativeSession)
    expect(await fixture.details(started.run.id)).toEqual(before)
    const calls = await fixture.provider.calls()
    for (const requestId of [message.requestId, followUp.requestId]) {
      const turns = calls.filter(call => call.method === 'turn/start'
        && call.correlationId === `agent-chat:${id}:${requestId}`)
      expect(turns).toHaveLength(1)
      expect(turns[0]?.threadId).toBe(completed.conversation!.nativeSession!.nativeSessionId)
    }
    const forks = calls.filter(call => call.forkedSession)
    expect(forks).toHaveLength(1)
    expect(forks[0]?.forkedSession).toMatchObject({ source: execution.nativeSessionId,
      child: completed.conversation!.nativeSession!.nativeSessionId })
    const profile = fixture.profiles[0]!
    await fixture.value('harness_instance_save', { commandId: randomUUID(), instanceId: profile.instanceId,
      expectedRevision: profile.revision, target: profile.target, presetId: profile.presetId,
      enabled: false, configuration: profile.configuration })
    const unavailable = await read()
    expect(unavailable.availability.canSend).toBe(false)
    expect(unavailable.conversation?.nativeSession).toEqual(resumed.conversation?.nativeSession)
    expect(unavailable.messages.some(entry => entry.content === followUp.content)).toBe(true)
    const blocked = await fixture.call('agent_chat_send', { workspaceId, selection,
      message: { requestId: randomUUID(), content: 'Do not change hosts.', expectedConversationId: id } })
    expect(blocked.isError).toBe(true)
    expect((await fixture.provider.calls()).filter(call => call.forkedSession)).toHaveLength(1)
    expect(await fixture.details(started.run.id)).toEqual(before)
  } catch (error) {
    console.error('Historical Worker chat recovery failed', { failures: fixture.failures() })
    throw error
  } finally { await fixture.close() }
}, 240_000)
