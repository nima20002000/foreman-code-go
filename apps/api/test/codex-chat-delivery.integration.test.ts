import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings,
  type OperatorConversationState } from '@graphql/contracts'
import type { AgentChatState, SendAgentChatMessageRequest } from '@graphql/contracts/agent-chat'
import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorChatService, type OperatorChatAuthority, type NativeManagerResolver } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { CodexChatFiles } from '../src/modules/harnesses/codexFiles/runtime.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'
import { calls, until } from './fixtures/codex-test-helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let native: Awaited<ReturnType<typeof deliveryFixture>>
  let agentChat: AgentChatService
  let operatorChat: OperatorChatService
  let repository: PostgresAgentChatRepository
  let messages: PostgresOperatorConversationRepository
  let app: ReturnType<typeof buildApp>
  let writer: Client
  let denied: Client
  let reader: Client
  let context: SendAgentChatMessageRequest['context']
  let workspaceId: string
  let operatorFiles: CodexChatFiles | undefined
  const clients: Client[] = []
  const settings = { ...operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex), harness: 'codex' as const,
    model: 'test-model', reasoningEffort: 'low' as const, serviceTier: 'standard' as const }

  beforeEach(async () => {
    database = await agent3Database()
    native = await deliveryFixture()
    operatorFiles = undefined
    const fixture = makeCurrentWorkflowFixture(`delivery-${randomUUID()}`, 'single')
    fixture.configurations = fixture.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
      ...configuration, harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'test-model',
        reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
    }))
    const saved = await seedAgent3(database.pool, native.directory, fixture, { run: false })
    const node = saved.version.definition.nodes[0]!
    workspaceId = saved.scope.workspaceId
    context = { workflowId: saved.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const access = new PostgresAccessService(database.pool)
    const issued = await access.issue({ name: 'Delivery writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: {}, actions: [
        'agent_chat:read', 'agent_chat:write', 'agent_chat:cancel',
        'operator_chat:read', 'operator_chat:write', 'operator_chat:cancel',
      ] }] })
    const deniedAccess = await access.issue({ name: 'Other workspace', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: { workspaceIds: ['other-workspace'] },
        actions: ['agent_chat:read', 'agent_chat:write'] }] })
    const readerAccess = await access.issue({ name: 'Delivery reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: {}, actions: ['operator_chat:read'] }] })
    const agentOwners = new Map<string, NativeHarnessSessionManager>()
    const factory: AgentChatManagerFactory = (id) => {
      let owner = agentOwners.get(id)
      if (!owner) {
        owner = createAdmittedNativeManager('codex', async () => ({ manager: native.makeManager() })).manager
        agentOwners.set(id, owner)
      }
      return owner
    }
    factory.release = (id) => { agentOwners.delete(id) }
    repository = new PostgresAgentChatRepository(database.pool)
    messages = new PostgresOperatorConversationRepository(database.pool)
    agentChat = new AgentChatService(database.pool, repository, messages, new PostgresWorkflowRepository(database.pool), {
      getForWorkspace: async () => { throw new Error('No Run source in this fixture.') },
      executionPages: async () => { throw new Error('No Run source in this fixture.') },
    }, factory, database.directory)
    const operatorOwners = new Map<string, NativeHarnessSessionManager>()
    const resolver: NativeManagerResolver = (_configuration, id) => {
      let owner = operatorOwners.get(id)
      if (!owner) {
        owner = createAdmittedNativeManager('codex', async () => ({ manager: native.makeManager(operatorFiles) })).manager
        operatorOwners.set(id, owner)
      }
      return owner
    }
    resolver.release = (id) => { operatorOwners.delete(id) }
    const authority: OperatorChatAuthority = {
      current: (id) => access.currentOperator(id),
      assertConfiguration() {},
      setup: async (manager) => ({ harness: manager.harness, status: 'configured',
        endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
      prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }),
      release: async () => undefined,
    }
    operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
      resolver, native.directory, authority)
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined } }, operator: { access,
      services: { agentChat, operatorChat, commands: new PostgresCommandCoordinator(database.pool) } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'codex-delivery', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    writer = await connect(issued.token)
    denied = await connect(deniedAccess.token)
    reader = await connect(readerAccess.token)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close()
    await app?.close()
    await agentChat?.shutdown()
    await operatorChat?.shutdown()
    await native?.close()
    await database?.close()
  })

  const request = (requestId: string, expectedConversationId: string | null): SendAgentChatMessageRequest => ({
    requestId, content: 'A user message', intent: 'next_turn', context, expectedConversationId,
  })
  async function sendAgent(input: SendAgentChatMessageRequest) {
    const result = await writer.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: input } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return result.structuredContent as { state: AgentChatState; replayed: boolean }
  }
  async function readAgent() {
    const result = await writer.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query: context } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return result.structuredContent as AgentChatState
  }
  async function createOperator() {
    const result = await writer.callTool({ name: 'operator_chat_create', arguments: {} })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return (result.structuredContent as { conversation: { id: string } }).conversation.id
  }
  async function sendOperator(id: string, requestId: string, content = 'A user message') {
    const result = await writer.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: id, request: { requestId, content, settings },
    } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
  }
  async function readOperator(id: string) {
    const result = await writer.callTool({ name: 'operator_chat_get', arguments: { conversationId: id } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return result.structuredContent as OperatorConversationState
  }

  for (const fault of ['auth', 'model', 'initialize'] as const) {
    it(`Agent ${fault} rejection retires only the unsent creation and allows an explicit retry`, async () => {
      if (fault === 'auth') await native.flag('logged-out')
      if (fault === 'model') await native.json('models.json', { models: [] })
      if (fault === 'initialize') await native.flag('reject-initialize')
      const input = request('first', null)
      const admitted = await sendAgent(input)
      const id = admitted.state.conversation!.id
      await until(async () => (await repository.turn(id, 'first'))?.delivery === 'failed' || undefined)
      assert.equal((await readAgent()).availability.canSend, true)
      assert.equal((await repository.get(id))!.record.sessionCreation, undefined)
      assert.equal((await sendAgent({ ...input, expectedConversationId: id })).replayed, true)
      const before = await repository.state(id)
      const refusal = await denied.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: request('denied', id) } })
      assert.equal(refusal.isError, true)
      assert.deepEqual(await repository.state(id), before)
      assert.equal((await native.wire('thread/start')).length, 0)
      await native.unflag('logged-out')
      await native.unflag('models.json')
      await native.unflag('reject-initialize')
      await sendAgent(request('retry', id))
      await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 1)
    })
  }

  it('Agent recovery binds the original late session, settles its unsent prompt, and never creates again', async () => {
    await native.flag('late-thread-start')
    const admitted = await sendAgent(request('late', null))
    const id = admitted.state.conversation!.id
    await until(async () => (await repository.turn(id, 'late'))?.delivery === 'unknown' || undefined)
    assert.equal((await readAgent()).availability.canSend, false)
    const recovered = await until(async () => {
      await agentChat.recover()
      const row = await repository.get(id)
      return row?.native_session_id ? row : undefined
    })
    assert.equal(recovered.record.sessionCreation?.requestId, 'late')
    assert.equal((await repository.turn(id, 'late'))?.delivery, 'failed')
    assert.equal((await sendAgent(request('late', id))).replayed, true)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 0)
    await sendAgent(request('retry', id))
    await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
    assert.equal((await repository.get(id))!.native_session_id, recovered.native_session_id)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })

  it('Agent idle-exit failure is retryable and resumes the stored session without another creation', async () => {
    const admitted = await sendAgent(request('first', null))
    const id = admitted.state.conversation!.id
    await until(async () => (await repository.turn(id, 'first'))?.delivery === 'completed' || undefined)
    const sessionId = (await repository.get(id))!.native_session_id
    await native.flag('idle-exit')
    await until(async () => (await calls(native.directory)).some((entry) => entry.exited) || undefined)
    await sendAgent(request('unsent', id))
    await until(async () => (await repository.turn(id, 'unsent'))?.delivery === 'failed' || undefined)
    assert.equal((await readAgent()).availability.canSend, true)
    assert.equal((await native.wire('turn/start')).length, 1)
    await native.unflag('idle-exit')
    await sendAgent(request('retry', id))
    await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
    assert.equal((await repository.get(id))!.native_session_id, sessionId)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 2)
  })

  it('a changed Agent creation marker refuses a late session binding and preserves the original prompt fence', async () => {
    await native.flag('late-thread-start')
    const admitted = await sendAgent(request('late', null))
    const id = admitted.state.conversation!.id
    await until(async () => (await repository.turn(id, 'late'))?.delivery === 'unknown' || undefined)
    await database.pool.query(`update operator_conversations set record=jsonb_set(record,'{sessionCreation,requestId}',to_jsonb($2::text)) where id=$1`,
      [id, 'another-owner'])
    await new Promise((resolve) => setTimeout(resolve, 850))
    await agentChat.recover()
    assert.equal((await repository.get(id))!.native_session_id, null)
    assert.equal((await repository.turn(id, 'late'))?.delivery, 'unknown')
    assert.equal((await native.wire('turn/start')).length, 0)
  })

  it('Agent creation binding rejects a different request, configuration, harness or prior turn', async () => {
    await native.flag('late-thread-start')
    const admitted = await sendAgent(request('late', null))
    const id = admitted.state.conversation!.id
    await until(async () => (await repository.turn(id, 'late'))?.delivery === 'unknown' || undefined)
    const row = (await repository.get(id))!
    const session = { harness: 'codex' as const, providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'foreign-session' }
    for (const [requestId, configurationId, harness] of [
      ['another-request', row.agent_configuration_version_id, 'codex'],
      ['late', 'another-configuration', 'codex'],
      ['late', row.agent_configuration_version_id, 'opencode'],
    ] as const) {
      await assert.rejects(repository.bindCreatedSession(id, requestId, configurationId, { ...session, harness }),
        { code: 'AGENT_CHAT_SESSION_CONFLICT' })
      assert.deepEqual(await repository.get(id), row)
    }
    await database.pool.query('update operator_conversations set active_native_turn_id=$2 where id=$1', [id, 'prior-turn'])
    await assert.rejects(repository.bindCreatedSession(id, 'late', row.agent_configuration_version_id, session),
      { code: 'AGENT_CHAT_SESSION_CONFLICT' })
    assert.equal((await repository.get(id))!.native_session_id, null)
    assert.equal((await native.wire('turn/start')).length, 0)
  })

  it('Operator pre-send file failure settles as retryable after cleanup and is visible through MCP', async () => {
    operatorFiles = { prepare: async () => { throw new Error('The admitted attachment is unavailable.') } }
    const id = await createOperator()
    await sendOperator(id, 'unsent')
    const state = await until(async () => {
      const current = await readOperator(id)
      return current.turnState === 'error' ? current : undefined
    })
    assert.equal(state.activeRequestId, null)
    assert.equal((await native.wire('turn/start')).length, 0)
    const receipt = (await database.pool.query('select result,retryable from operator_conversation_turns where conversation_id=$1 and request_id=$2',
      [id, 'unsent'])).rows[0]
    assert.equal(receipt.result.outcome, 'failed')
    assert.equal(receipt.retryable, true)
    await assert.rejects(reader.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: id, request: { requestId: 'denied', content: 'Denied', settings },
    } }), /not found/i)
    operatorFiles = undefined
    await sendOperator(id, 'retry')
    await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })

  for (const fault of ['auth', 'model', 'initialize'] as const) {
    it(`Operator ${fault} creation failure permits explicit retry after cleanup`, async () => {
      if (fault === 'auth') await native.flag('logged-out')
      if (fault === 'model') await native.json('models.json', { models: [] })
      if (fault === 'initialize') await native.flag('reject-initialize')
      const id = await createOperator()
      await sendOperator(id, 'first')
      await until(async () => (await readOperator(id)).turnState === 'error' || undefined)
      assert.equal((await messages.active(id))!.active_request_id, null)
      assert.equal((await messages.active(id))!.native_session_id, null)
      assert.equal((await native.wire('thread/start')).length, 0)
      await native.unflag('logged-out')
      await native.unflag('models.json')
      await native.unflag('reject-initialize')
      await sendOperator(id, 'retry')
      await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 1)
    })
  }

  it('Operator failure after a prompt write retains its request and a readback cannot replay it', async () => {
    const id = await createOperator()
    await sendOperator(id, 'written', 'lost-start')
    await until(async () => (await readOperator(id)).turnState === 'uncertain' || undefined)
    const row = (await messages.active(id))!
    assert.equal(row.active_request_id, 'written')
    const receipt = (await database.pool.query('select result,retryable from operator_conversation_turns where conversation_id=$1 and request_id=$2',
      [id, 'written'])).rows[0]
    assert.equal(receipt.result, null)
    assert.equal(receipt.retryable, false)
    await sendOperator(id, 'written', 'lost-start')
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })

  it('Operator late creation recovery binds one session and sends no prompt until explicit retry', async () => {
    await native.flag('late-thread-start')
    const id = await createOperator()
    await sendOperator(id, 'late')
    await until(async () => (await readOperator(id)).turnState === 'uncertain' || undefined)
    await until(async () => {
      await operatorChat.reconcileActive()
      return (await readOperator(id)).turnState === 'error' || undefined
    })
    const sessionId = (await messages.active(id))!.native_session_id
    assert(sessionId)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 0)
    await native.unflag('late-thread-start')
    await sendOperator(id, 'retry')
    await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
    assert.equal((await messages.active(id))!.native_session_id, sessionId)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })
})
