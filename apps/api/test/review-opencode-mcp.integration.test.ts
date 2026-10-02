import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { it, vi } from 'vitest'
import { AgentChatStateSchema } from '@graphql/contracts/agent-chat'
import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { ManagedOpenCodeServer } from '../src/modules/harnesses/opencodeTransport.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { FixtureServer, configuration, json, permission } from './opencode-fixtures.js'
import { eventually } from './helpers/agentChatF5.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

it('F-10 exposes credential-free approval through authenticated MCP, denies a reader and persists its response', async () => {
  // Own one random local demo database; never migrate or delete a shared database.
  const name = `review_opencode_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: 'postgresql://graphql:graphql@127.0.0.1:5432/postgres' })
  await admin.connect()
  await admin.query(`create database "${name}"`)
  const pool = new pg.Pool({ connectionString: `postgresql://graphql:graphql@127.0.0.1:5432/${name}`, max: 8 })
  const directory = await mkdtemp(join(tmpdir(), 'review-opencode-mcp-'))
  const clients: Client[] = []
  let service: AgentChatService | undefined
  let app: ReturnType<typeof buildApp> | undefined
  const provider = new FixtureServer()
  provider.config = { mcp: { graphql: { enabled: false } } }
  try {
    await applyApplicationMigrations(pool)
    const fixture = makeCurrentWorkflowFixture(`opencode-${randomUUID()}`, 'single')
    for (const config of fixture.configurations) config.harness = configuration()
    await seedAgent3(pool, directory, fixture, { run: false })
    const access = new PostgresAccessService(pool)
    const writer = await access.issue({ name: 'OpenCode writer', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:respond'], scope: {} }] })
    const reader = await access.issue({ name: 'OpenCode reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    const repository = new PostgresAgentChatRepository(pool)
    service = new AgentChatService(pool, repository, new PostgresOperatorConversationRepository(pool), new PostgresWorkflowRepository(pool),
      { getForWorkspace: async () => { throw new Error('No Run is used') }, async *executionPages() { yield [] } },
      id => {
        const server = new ManagedOpenCodeServer({ binary: '/unused-fixture-binary', workingDirectory: directory,
          ownerAgentId: id, appMcpAccess: 'none' })
        server.expectedVersion = provider.expectedVersion
        vi.spyOn(server, 'ensure').mockImplementation(signal => provider.ensure(signal))
        vi.spyOn(server, 'request').mockImplementation((...args) => provider.request(...args))
        vi.spyOn(server, 'dispose').mockImplementation(() => provider.dispose())
        vi.spyOn(server, 'residentGeneration', 'get').mockReturnValue(0)
        vi.spyOn(server, 'requestResident').mockImplementation(async (path, signal, generation) => {
          signal.throwIfAborted()
          assert.equal(generation, 0)
          const segments = new URL(path, 'http://fixture.invalid').pathname.split('/').filter(Boolean).map(decodeURIComponent)
          if (segments[0] === 'permission') return json(provider.permissions)
          if (segments[2] === 'message') return json(provider.messages.get(segments[1]!)?.find(message => message.info.id === segments[3]))
          return json(provider.sessionInfos.get(segments[1]!))
        })
        vi.spyOn(server, 'restart').mockRejectedValue(new Error('Chat must not issue or bind credentials'))
        return new OpenCodeNativeSessionManager({ server, ownerAgentId: id, appMcpAccess: 'none' })
      }, directory)
    app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'review-opencode', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const mcp = await connect(writer.token), denied = await connect(reader.token)
    const node = fixture.version.definition.nodes[0]!
    const workspaceId = fixture.scope.workspaceId
    const query = { workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    provider.onPrompt = (sessionID, body) => {
      const tool = provider.assistant(String(body.messageID), 'awaiting approval', 'tool-calls', false, sessionID)
      const ask = permission('approval', sessionID)
      ask.tool = { messageID: tool.info.id, callID: 'call' }
      provider.permissions = [ask]
      provider.emit('permission.asked', ask)
    }
    const sent = await mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId,
      request: { requestId: 'turn', context: query, content: 'hello', intent: 'next_turn', expectedConversationId: null } } })
    assert.notEqual(sent.isError, true, JSON.stringify(sent))
    const conversationId = (sent.structuredContent as { state: { conversation: { id: string } } }).state.conversation.id
    await eventually(async () => (await repository.get(conversationId))?.pending_interaction != null)
    const read = await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query } })
    assert.notEqual(read.isError, true, JSON.stringify(read))
    const state = AgentChatStateSchema.parse(read.structuredContent)
    assert.equal(state.responseAvailability?.available, true)
    assert.equal(state.responseAvailability?.reason, 'qualified_recovery')
    const before = await repository.get(conversationId)
    const optionId = state.pendingInteraction!.responseOptions[0]!.optionId
    const args = { workspaceId, conversationId, requestId: 'answer', nativeRequestId: 'approval', optionId }
    assert.equal((await denied.listTools()).tools.some(tool => tool.name === 'agent_chat_respond'), false)
    await assert.rejects(denied.callTool({ name: 'agent_chat_respond', arguments: args }), /not found/)
    assert.deepEqual(await repository.get(conversationId), before)
    assert.equal(provider.calls.filter(call => call.path.includes('/reply')).length, 0)
    const reply = await mcp.callTool({ name: 'agent_chat_respond', arguments: args })
    assert.notEqual(reply.isError, true, JSON.stringify(reply))
    assert.equal((await repository.get(conversationId))!.pending_interaction, null)
    assert.equal((await pool.query("select result->>'status' as status from management_command_receipts where operation='agent_chat_control' and command_id=$1", ['answer'])).rows[0]?.status, 'completed')
    const persisted = await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query } })
    assert.equal(AgentChatStateSchema.parse(persisted.structuredContent).pendingInteraction, undefined)
    assert.equal(provider.calls.filter(call => call.path.includes('/reply')).length, 1)
  } finally {
    await service?.shutdown()
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    vi.restoreAllMocks()
    await pool.end()
    await admin.query(`drop database "${name}"`)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
