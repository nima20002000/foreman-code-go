import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GetOperatorConversationResponseSchema, OperatorActivityPageSchema,
  SendOperatorMessageResponseSchema } from '@graphql/contracts'
import { OperatorConversationHistoryPageSchema } from '@graphql/contracts/operator-chat'
import type { ManagementAction, ManagementScope } from '@graphql/contracts/management'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { ReviewManager } from './fixtures/agent1OperatorChat.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Authenticated Operator conversation tools', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let operators: PostgresOperatorRepository
  let repository: PostgresOperatorConversationRepository
  let manager: ReviewManager
  let chat: OperatorChatService
  let app: ReturnType<typeof buildApp>
  let address: string
  let clients: Client[]

  beforeEach(async () => {
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    operators = new PostgresOperatorRepository(database.pool)
    repository = new PostgresOperatorConversationRepository(database.pool)
    manager = new ReviewManager()
    chat = new OperatorChatService(repository, operators, () => manager, database.directory, {
      current: (id) => access.currentOperator(id),
      assertConfiguration() {},
      setup: async (selected) => ({
        harness: selected.harness,
        status: 'configured',
        endpoint: 'http://127.0.0.1:3000/mcp',
        checkedAt: new Date().toISOString(),
      }),
      prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }),
      release: async () => {},
    })
    app = buildApp({
      logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: {
        access,
        services: {
          operatorChat: chat,
          commands: new PostgresCommandCoordinator(database.pool),
        } as unknown as OperatorServices,
      },
    })
    clients = []
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 30_000)

  afterEach(async () => {
    await Promise.allSettled((clients ?? []).map((client) => client.close()))
    await chat?.shutdown()
    await app?.close()
    await database?.close()
  })

  async function connect(token: string) {
    const client = new Client({ name: 'operator-conversation-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }

  async function issue(actions: ManagementAction[], scope: ManagementScope = {}) {
    const issued = await access.issue({
      name: 'Conversation caller',
      audience: 'operator',
      grants: [{ actions, scope }],
      expiresAt: new Date(Date.now() + 600_000),
    })
    return { ...issued, client: await connect(issued.token) }
  }

  async function denied(client: Client, name: string, args: Record<string, unknown>) {
    try {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
      return JSON.stringify(result)
    } catch (error) {
      expect(String(error)).toMatch(/not found|ACCESS_DENIED/)
      return String(error)
    }
  }

  it('requires read and write for fresh sends and receipt-only recovery without exposing protected state', async () => {
    const writer = await issue(['operator_chat:write', 'capabilities:read'])
    const conversation = await chat.create(writer.principal)
    const request = { requestId: randomUUID(), content: 'Protected transcript from an earlier turn' }
    await repository.beginTurn(conversation.id, request, writer.principal.id)
    await repository.activity.append(conversation.id, request.requestId, {
      id: 'private-tool', requestId: request.requestId, kind: 'tool', status: 'completed',
      title: 'Protected activity', output: 'Private tool output',
    })
    await repository.finish(conversation.id, request.requestId, { outcome: 'succeeded' })
    const before = await repository.get(conversation.id)
    expect((await writer.client.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_chat_send')
    const capabilities = await writer.client.callTool({ name: 'operator_get_capabilities', arguments: {} })
    expect(capabilities.structuredContent).toMatchObject({ tools: expect.not.arrayContaining(['operator_chat_send']) })

    const fresh = { requestId: randomUUID(), content: 'A fresh request' }
    for (const command of [fresh, { ...request, recovery: 'receipt' as const }]) {
      const response = await denied(writer.client, 'operator_chat_send', {
        conversationId: conversation.id, request: command,
      })
      expect(response).not.toContain(request.content)
      expect(response).not.toContain('Private tool output')
      await expect(chat.send(conversation.id, command, writer.principal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    }
    expect(await repository.get(conversation.id)).toEqual(before)
    expect(manager.turns).toBe(0)

    const grants = [{ actions: ['operator_chat:read', 'operator_chat:write', 'capabilities:read'], scope: {} }]
    await database.pool.query('update management_principals set grants=$2::jsonb where id=$1', [
      writer.principal.id, JSON.stringify(grants),
    ])
    const reader = await connect(writer.token)
    const recovered = await reader.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: conversation.id, request: { ...request, recovery: 'receipt' },
    } })
    expect(recovered.isError).not.toBe(true)
    const result = SendOperatorMessageResponseSchema.parse(recovered.structuredContent)
    expect(result.replayed).toBe(true)
    expect(result.state.messages.map((message) => message.content)).toContain(request.content)
    expect(result.state.activities?.[0]?.output).toBe('Private tool output')
    expect(await repository.get(conversation.id)).toEqual(before)
    expect(manager.turns).toBe(0)
  })

  it('pages owned messages and activities omitted from snapshots with scoped cursors and denied callers', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write', 'capabilities:read'])
    const conversation = await chat.create(owner.principal)
    const contents: string[] = []
    const activityIds: string[] = []
    for (let turn = 0; turn < 40; turn++) {
      const requestId = `history-${turn}`
      const content = `Message ${turn}`
      contents.push(content)
      await repository.beginTurn(conversation.id, { requestId, content }, owner.principal.id)
      for (let index = 0; index < 3; index++) {
        const id = `activity-${turn}-${index}`
        activityIds.push(id)
        await repository.activity.append(conversation.id, requestId, {
          id, requestId, kind: 'tool', status: 'completed', title: id,
        })
      }
      await repository.finish(conversation.id, requestId, { outcome: 'succeeded' })
    }
    const snapshotReply = await owner.client.callTool({ name: 'operator_chat_get', arguments: {
      conversationId: conversation.id,
    } })
    const snapshot = GetOperatorConversationResponseSchema.parse(snapshotReply.structuredContent)
    expect(snapshot.messages).toHaveLength(32)
    expect(snapshot.hasEarlierMessages).toBe(true)
    expect(snapshot.activities).toHaveLength(100)
    expect(snapshot.activityNextCursor).not.toBeNull()
    const capabilities = await owner.client.callTool({ name: 'operator_get_capabilities', arguments: {} })
    expect(capabilities.structuredContent).toMatchObject({ tools: expect.arrayContaining([
      'operator_chat_history_get', 'operator_chat_activity_get',
    ]) })

    const messages: string[] = []
    let before: string | null = null
    do {
      const reply = await owner.client.callTool({ name: 'operator_chat_history_get', arguments: {
        conversationId: conversation.id, limit: 7, ...(before ? { before } : {}),
      } })
      expect(reply.isError).not.toBe(true)
      const page = OperatorConversationHistoryPageSchema.parse(reply.structuredContent)
      expect(page.revision).toBe(snapshot.revision)
      expect(page.entries.every((entry) => entry.receipt?.outcome === 'succeeded')).toBe(true)
      expect(page.nextCursor === null || page.nextCursor !== before).toBe(true)
      messages.unshift(...page.entries.map((entry) => entry.message.content))
      before = page.nextCursor
    } while (before)
    expect(messages).toEqual(contents)

    const activities: string[] = []
    do {
      const reply = await owner.client.callTool({ name: 'operator_chat_activity_get', arguments: {
        conversationId: conversation.id, limit: 17, ...(before ? { before } : {}),
      } })
      expect(reply.isError).not.toBe(true)
      const page = OperatorActivityPageSchema.parse(reply.structuredContent)
      expect(page.nextCursor === null || page.nextCursor !== before).toBe(true)
      activities.unshift(...page.activities.map((activity) => activity.id))
      before = page.nextCursor
    } while (before)
    expect(activities).toEqual(activityIds)
    expect(manager.turns).toBe(0)

    const foreign = await issue(['operator_chat:read', 'operator_chat:write'])
    const other = await chat.create(foreign.principal)
    const otherTurn = { requestId: randomUUID(), content: 'Another owner message' }
    await repository.beginTurn(other.id, otherTurn, foreign.principal.id)
    const otherActivity = await repository.activity.append(other.id, otherTurn.requestId, {
      id: 'other-tool', requestId: otherTurn.requestId, kind: 'tool', status: 'completed', title: 'Other activity',
    })
    const otherPage = await repository.history(other.id)
    await repository.finish(other.id, otherTurn.requestId, { outcome: 'succeeded' })
    for (const [name, cursor] of [
      ['operator_chat_history_get', otherPage!.entries[0]!.sequence],
      ['operator_chat_activity_get', otherActivity!.activity.sequence],
    ] as const) {
      const wrongCursor = await owner.client.callTool({ name, arguments: {
        conversationId: conversation.id, before: cursor,
      } })
      expect(wrongCursor.isError).toBe(true)
      expect(JSON.stringify(wrongCursor)).toContain('CURSOR_SCOPE_CONFLICT')
      const wrongOwner = await owner.client.callTool({ name, arguments: { conversationId: other.id } })
      expect(wrongOwner.isError).toBe(true)
      expect(JSON.stringify(wrongOwner)).toContain('CONVERSATION_NOT_FOUND')
    }
    const ungranted = await issue(['operator_chat:write'])
    const scoped = await issue(['operator_chat:read'], { workspaceIds: [randomUUID()] })
    for (const caller of [ungranted, scoped]) {
      const names = (await caller.client.listTools()).tools.map((tool) => tool.name)
      for (const name of ['operator_chat_history_get', 'operator_chat_activity_get']) {
        expect(names).not.toContain(name)
        await denied(caller.client, name, { conversationId: conversation.id })
      }
    }
    expect((await repository.get(conversation.id))?.revision).toBe(snapshot.revision)
    expect((await repository.history(conversation.id))?.entries).toHaveLength(40)
  })
})
