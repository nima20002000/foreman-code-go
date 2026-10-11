import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { historicalChatPlacement, historicalChatSource, forkHistoricalChat } from './helpers/historicalChatPlacement.js'

it('forks historical chat on its accepted Worker and denies a read-only caller', async () => {
  await historicalChatPlacement(async fixture => {
    const source = await historicalChatSource(fixture)
    const { workspaceId, selection, read } = source
    const reader = await fixture.access.issue({ name: 'Historical chat reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    const message = { requestId: randomUUID(), content: 'Continue the saved task.', expectedConversationId: null }
    const denied = await fixture.call('agent_chat_send', { workspaceId, selection, message }, reader.token)
    expect(denied.isError).toBe(true)
    expect((await read()).conversation).toBeNull()
    const { completed, id, execution, before, started } = await forkHistoricalChat(fixture, source, message)
    const calls = await fixture.provider.calls()
    const turns = calls.filter(call => call.method === 'turn/start'
      && call.correlationId === `agent-chat:${id}:${message.requestId}`)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.threadId).toBe(completed.conversation!.nativeSession!.nativeSessionId)
    const forks = calls.filter(call => call.forkedSession)
    expect(forks).toHaveLength(1)
    expect(forks[0]?.forkedSession).toMatchObject({ source: execution.nativeSessionId,
      child: completed.conversation!.nativeSession!.nativeSessionId })
    expect(await fixture.details(started.run.id)).toEqual(before)
  })
}, 240_000)
