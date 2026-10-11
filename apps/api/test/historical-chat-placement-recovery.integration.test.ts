import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { historicalChatPlacement, historicalChatSource, forkHistoricalChat } from './helpers/historicalChatPlacement.js'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'

it('recovers historical chat on its accepted Worker through Main restart and profile requalification', async () => {
  await historicalChatPlacement(async fixture => {
    const source = await historicalChatSource(fixture)
    const { workspaceId, selection, read, message, completed, id, before, started, execution } =
      await forkHistoricalChat(fixture, source)
    const followUp = { requestId: randomUUID(), content: 'Continue after recovery.', expectedConversationId: id }
    let callsBefore = 0
    let modelsBlocked = false
    try {
      await fixture.restartMain({ mode: 'graceful', afterShutdown: async () => {
        // Hold only the reconnect check after the old Main has drained its work.
        callsBefore = (await fixture.provider.calls()).length
        await fixture.provider.blockModels({ workingDirectory: fixture.stateDirectory })
        modelsBlocked = true
      } })
      await waitForRemoteReview(() => fixture.provider.calls(), calls => calls.slice(callsBefore).some(call =>
        call.method === 'model/list' && typeof call.workingDirectory === 'string'
        && call.workingDirectory.startsWith(`${fixture.stateDirectory}/`)),
      'Worker profile requalification entry')
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
    } finally {
      if (modelsBlocked) await fixture.provider.releaseModels()
    }
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
  })
}, 240_000)
