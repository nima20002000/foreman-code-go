import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { it } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { configuration, FixtureServer } from './opencode-fixtures.js'
import { eventually } from './helpers/agentChatF5.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

for (const size of ['multi-image prompt', 'large page'] as const) {
  it(`settles a ${size} and delivers queued input through authenticated MCP and persisted chat recovery`, async () => {
    const database = await agent3Database()
    const { pool, directory } = database
    const clients: Client[] = []
    const managers: OpenCodeNativeSessionManager[] = []
    const provider = new FixtureServer()
    provider.config = { mcp: { 'foreman-code': { enabled: false } } }
    let service: AgentChatService | undefined
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const fixture = makeCurrentWorkflowFixture(`media-${randomUUID()}`, 'single')
      for (const config of fixture.configurations) config.harness = configuration()
      await seedAgent3(pool, directory, fixture, { run: false })
      const access = new PostgresAccessService(pool)
      const writer = await access.issue({ name: 'Media recovery writer', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }] })
      const reader = await access.issue({ name: 'Media recovery reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: {} }] })
      const repository = new PostgresAgentChatRepository(pool)
      // The production service, repositories, manager and HTTP client remain intact.
      // Only the external OpenCode HTTP/SSE boundary supplies deterministic native history.
      service = new AgentChatService(pool, repository, new PostgresOperatorConversationRepository(pool),
        new PostgresWorkflowRepository(pool),
        { getForWorkspace: async () => { throw new Error('No Run is used') }, async *executionPages() { yield [] } },
        id => {
          const manager = new OpenCodeNativeSessionManager({ server: provider, ownerAgentId: id, appMcpAccess: 'none' })
          managers.push(manager)
          return manager
        }, directory)
      app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
        operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'media-recovery', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      const mcp = await connect(writer.token)
      const denied = await connect(reader.token)
      const node = fixture.version.definition.nodes[0]!
      const workspaceId = fixture.scope.workspaceId
      const query = { workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
      let conversationId = ''
      let firstMessageId = ''
      let sessionId = ''
      provider.onPrompt = (id, body) => {
        if (!firstMessageId) {
          firstMessageId = String(body.messageID)
          sessionId = id
          if (size === 'multi-image prompt') {
            const root = provider.messages.get(id)!.find(message => message.info.id === firstMessageId)!
            const url = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024)
            root.parts.push(...[0, 1].map(index => ({ id: `image-${index}`, sessionID: id,
              messageID: firstMessageId, type: 'file', filename: `photo-${index}.png`, mime: 'image/png', url })))
          }
          return
        }
        provider.complete(agentChatCorrelation(conversationId, 'next'), 'Completed next', id)
      }
      const send = async (requestId: string, expectedConversationId: string | null) => {
        const result = await mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId,
          request: { requestId, context: query, content: requestId, intent: 'next_turn', expectedConversationId },
        } })
        assert.notEqual(result.isError, true, JSON.stringify(result))
        return result.structuredContent as { state: { conversation: { id: string } } }
      }
      conversationId = (await send('first', null)).state.conversation.id
      await eventually(async () => (await repository.get(conversationId))?.active_native_turn_id === firstMessageId)
      await send('next', conversationId)
      const held = await repository.state(conversationId)
      assert.equal(held?.turns.find(turn => turn.requestId === 'next')?.delivery, 'queued')
      const rejected = { workspaceId, request: { requestId: 'denied', context: query, content: 'denied',
        intent: 'next_turn', expectedConversationId: conversationId } }
      assert.equal((await denied.listTools()).tools.some(tool => tool.name === 'agent_chat_send'), false)
      await expectMcpAccessDenied(denied.callTool({ name: 'agent_chat_send', arguments: rejected }))
      assert.equal((await repository.state(conversationId))?.turns.some(turn => turn.requestId === 'denied'), false)
      if (size === 'large page') {
        for (let index = 0; index < 64; index += 1) {
          const message = provider.assistant(firstMessageId, '', 'tool-calls', true, sessionId)
          message.parts = [{ id: `reasoning-${index}`, sessionID: sessionId, messageID: message.info.id,
            type: 'reasoning', text: 'x'.repeat(160_000) }]
        }
      }
      // Persist the answer without a terminal SSE event, exercising the production repair path.
      provider.assistant(firstMessageId, 'Recovered first', 'stop', true, sessionId)
      provider.statuses.delete(sessionId)
      await service.recover()
      await eventually(async () => {
        const state = await repository.state(conversationId)
        return state?.turns.length === 2 && state.turns.every(turn => turn.delivery === 'completed')
      })
      const read = await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query } })
      assert.notEqual(read.isError, true, JSON.stringify(read))
      const state = AgentChatStateSchema.parse(read.structuredContent)
      assert.equal(state.activeTurn, null)
      assert(state.messages.some(message => message.content === 'Recovered first'))
      assert(state.messages.some(message => message.content === 'Completed next'))
      assert.deepEqual(state.turns.map(turn => turn.delivery), ['completed', 'completed'])
      for (const requestId of ['first', 'next']) {
        const expected = nativeMessageId(agentChatCorrelation(conversationId, requestId))
        assert.equal(provider.calls.filter(call => call.path.includes('/prompt_async') && call.body?.messageID === expected).length, 1)
        assert.equal(state.turns.find(turn => turn.requestId === requestId)?.nativeTurnId, expected)
      }
      const persisted = await pool.query<{ request_id: string; result: unknown }>(
        'select request_id,result from operator_conversation_turns where conversation_id=$1 order by turn_sequence',
        [conversationId])
      assert.deepEqual(persisted.rows, [
        { request_id: 'first', result: { outcome: 'succeeded', output: { text: 'Recovered first' } } },
        { request_id: 'next', result: { outcome: 'succeeded', output: { text: 'Completed next' } } },
      ])
      assert.equal(managers.length, 1)
      assert.equal(provider.calls.filter(call => call.path.includes('/abort')).length, 0)
      assert.equal(provider.restartEnvironments.length, 0)
      assert.equal(provider.generation, 0)
    } finally {
      await service?.shutdown()
      await Promise.allSettled(clients.map(client => client.close()))
      await app?.close()
      await Promise.allSettled(managers.map(manager => manager.dispose()))
      await database.close()
    }
  }, 60_000)
}
