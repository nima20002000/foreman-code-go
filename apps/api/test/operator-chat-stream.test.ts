import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { OperatorConversationEvents } from '../src/modules/conversations/operatorChat.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'

describe('Operator chat SSE lifecycle', () => {
  it('closes hijacked streams before Fastify waits for open connections', async () => {
    const app = Fastify()
    const chat = {
      events: new OperatorConversationEvents(),
      get: async () => ({
        conversation: {
          id: 'conversation-stream', agentId: 'application-operator', scope: 'application',
          operatorConfigurationVersionId: 'operator-config', status: 'open',
        },
        messages: [], turnState: 'idle',
      }),
    }
    registerOperatorChatRoutes(app, chat as never)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(`${address}/api/operator/conversations/conversation-stream/events`)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot')
    await expect(Promise.race([
      app.close().then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ])).resolves.toBe('closed')
    expect((await reader.read()).done).toBe(true)
  })
})
