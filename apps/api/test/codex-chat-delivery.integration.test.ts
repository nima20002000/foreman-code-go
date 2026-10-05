import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings,
  type OperatorConversationState, type InteractionResponseValue } from '@graphql/contracts'
import type { AgentChatState, SendAgentChatMessageRequest } from '@graphql/contracts/agent-chat'
import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorChatService, type OperatorChatAuthority, type NativeManagerResolver } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { CodexChatFiles } from '../src/modules/harnesses/codexFiles/runtime.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'
import { agentMessage, calls, emit, state, until } from './fixtures/codex-test-helpers.js'
import { prepareCodexFileTurn } from '../src/modules/harnesses/codexFiles/index.js'
import { filePorts, fileScope, sourceRef } from './fixtures/codex-file-runtime-helpers.js'
import { nativeNonSubmission } from '../src/modules/conversations/nativeNonSubmission.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { FixtureServer, configuration as openCodeConfiguration, advanced as openCodeAdvanced } from './opencode-fixtures.js'

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
  let writerToken: string
  let readerToken: string
  let access: PostgresAccessService
  let context: SendAgentChatMessageRequest['context']
  let workspaceId: string
  let operatorFiles: CodexChatFiles | undefined
  let agentFiles: CodexChatFiles | undefined
  let factory: AgentChatManagerFactory
  let resolver: NativeManagerResolver
  let authority: OperatorChatAuthority
  let services: OperatorServices
  let openCodeServer: FixtureServer | undefined
  const clients: Client[] = []
  const settings = { ...operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex), harness: 'codex' as const,
    model: 'test-model', reasoningEffort: 'low' as const, serviceTier: 'standard' as const }

  beforeEach(async () => {
    database = await agent3Database()
    native = await deliveryFixture()
    operatorFiles = undefined
    agentFiles = undefined
    openCodeServer = undefined
    const fixture = makeCurrentWorkflowFixture(`delivery-${randomUUID()}`, 'single')
    fixture.configurations = fixture.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
      ...configuration, harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'test-model',
        reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
    }))
    const saved = await seedAgent3(database.pool, native.directory, fixture, { run: false })
    const node = saved.version.definition.nodes[0]!
    workspaceId = saved.scope.workspaceId
    context = { workflowId: saved.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    access = new PostgresAccessService(database.pool)
    const issued = await access.issue({ name: 'Delivery writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: {}, actions: [
        'agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond',
        'operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond',
      ] }] })
    const deniedAccess = await access.issue({ name: 'Other workspace', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: { workspaceIds: ['other-workspace'] },
        actions: ['agent_chat:read', 'agent_chat:write'] }] })
    const readerAccess = await access.issue({ name: 'Delivery reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: {}, actions: ['operator_chat:read'] }] })
    writerToken = issued.token
    readerToken = readerAccess.token
    const agentOwners = new Map<string, NativeHarnessSessionManager>()
    factory = (id) => {
      let owner = agentOwners.get(id)
      if (!owner) {
        owner = createAdmittedNativeManager('codex', async () => ({ manager: native.makeManager(agentFiles) })).manager
        agentOwners.set(id, owner)
      }
      return owner
    }
    factory.release = (id) => { agentOwners.delete(id) }
    repository = new PostgresAgentChatRepository(database.pool)
    messages = new PostgresOperatorConversationRepository(database.pool)
    agentChat = new AgentChatService(database.pool, repository, messages, new PostgresWorkflowRepository(database.pool), {
      getForWorkspace: async () => { throw new Error('No Run source in this fixture.') },
      executionPages: () => { throw new Error('No Run source in this fixture.') },
    }, factory, database.directory)
    const operatorOwners = new Map<string, NativeHarnessSessionManager>()
    resolver = (configuration, id) => {
      let owner = operatorOwners.get(id)
      if (!owner) {
        if (configuration.harness.harness === 'opencode') {
          assert(openCodeServer)
          const server = openCodeServer
          owner = createAdmittedNativeManager('opencode', async () => ({
            manager: new OpenCodeNativeSessionManager({ server, ownerAgentId: configuration.operatorId, appMcpAccess: 'none' }),
          })).manager
        } else owner = createAdmittedNativeManager('codex', async () => ({ manager: native.makeManager(operatorFiles) })).manager
        operatorOwners.set(id, owner)
      }
      return owner
    }
    resolver.release = (id) => { operatorOwners.delete(id) }
    authority = {
      current: (id) => access.currentOperator(id),
      assertConfiguration() {},
      setup: async (manager) => ({ harness: manager.harness, status: 'configured',
        endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
      prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }),
      release: async () => undefined,
    }
    operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
      resolver, native.directory, authority)
    services = { agentChat, operatorChat, commands: new PostgresCommandCoordinator(database.pool) } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined } }, operator: { access,
      services } })
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

  function restartAgentService() {
    agentChat = new AgentChatService(database.pool, repository, messages, new PostgresWorkflowRepository(database.pool), {
      getForWorkspace: async () => { throw new Error('No Run source in this fixture.') },
      executionPages: () => { throw new Error('No Run source in this fixture.') },
    }, factory, database.directory)
    services.agentChat = agentChat
  }

  for (const kind of ['agent', 'operator'] as const) {
    it(`${kind} persists a late prompt rejection before failed cleanup and settles it after service restart`, async () => {
      const ports = filePorts()
      let cleanupFails = true
      const files: CodexChatFiles = {
        prepare: async ({ session, signal }) => prepareCodexFileTurn({
          ownerPrincipalId: 'owner-a', scope: fileScope, nativeSessionId: session.nativeSessionId,
          admissionId: 'input-admission', executionHostId: 'execution-host-a', projectMode: 'read', allowMutation: false,
          allowedTools: ['files.list', 'files.read'], expiresAt: new Date(Date.now() + 60_000), attachments: [sourceRef],
        }, { ...ports.dependencies, files: ports.files, host: { ...ports.host, close: async () => {
          if (cleanupFails) throw new Error('Host closure is unconfirmed.')
          await ports.host.close()
        } } }, signal),
      }
      if (kind === 'agent') agentFiles = files
      else operatorFiles = files
      const id = kind === 'agent'
        ? (await sendAgent({ ...request('late', null), content: 'late-reject' })).state.conversation!.id
        : await createOperator()
      if (kind === 'operator') await sendOperator(id, 'late', 'late-reject')
      try {
        const rejected = await until(async () => {
          if (kind === 'agent') await agentChat.recover()
          else await operatorChat.reconcileActive()
          const row = kind === 'agent' ? await repository.get(id) : await messages.active(id)
          return row && nativeNonSubmission(row.record, 'late') || undefined
        })
        assert.equal(rejected.operation, 'turn_submission')
        assert.equal(rejected.result.error?.code, 'CODEX_TURN_START_REJECTED')
        const row = kind === 'agent' ? await repository.get(id) : await messages.active(id)
        assert.equal(row!.active_request_id, 'late')
        assert.equal(row!.active_native_turn_id, null)
        assert.equal((await native.wire('turn/start')).length, 1)
      } finally { cleanupFails = false }
      if (kind === 'agent') {
        await agentChat.shutdown()
        restartAgentService()
      } else {
        await operatorChat.shutdown()
        operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
          resolver, native.directory, authority)
        services.operatorChat = operatorChat
      }
      await until(async () => {
        if (kind === 'agent') {
          await agentChat.recover()
          return (await repository.turn(id, 'late'))?.delivery === 'failed' || undefined
        }
        await operatorChat.reconcileActive()
        return (await readOperator(id)).turnState === 'error' || undefined
      })
      assert(ports.events.includes('host:close'))
      assert.equal((await native.wire('turn/start')).length, 1)
      if (kind === 'agent') {
        await sendAgent(request('retry', id))
        await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
      } else {
        await sendOperator(id, 'retry')
        await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
      }
      assert.equal((await native.wire('turn/start')).length, 2)
    })
  }

  it('Operator retires actual OpenCode MCP preflight failure and retries after confirmed cleanup', async () => {
    openCodeServer = new FixtureServer()
    const harness = openCodeConfiguration()
    harness.advanced = { ...openCodeAdvanced(), mcp: { ...openCodeAdvanced().mcp, serverEnabled: { missing: true } } }
    const id = await createOperator()
    const refused = await writer.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: id, request: { requestId: 'opencode-preflight', content: 'A user message',
        settings: operatorChatSettings(harness) },
    } })
    assert.notEqual(refused.isError, true, JSON.stringify(refused))
    await until(async () => (await readOperator(id)).turnState === 'error' || undefined)
    const row = (await messages.active(id))!
    assert.equal(row.active_request_id, null)
    assert.equal(row.native_session_id, null)
    assert.equal(openCodeServer.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/session?')).length, 0)
    assert(openCodeServer.disposals > 0)
    const receipt = (await database.pool.query(`select result,retryable from operator_conversation_turns
      where conversation_id=$1 and request_id=$2`, [id, 'opencode-preflight'])).rows[0]
    assert.equal(receipt.result.error.code, 'OPENCODE_MCP_SERVER_NOT_CONFIGURED')
    assert.equal(receipt.retryable, true)
    openCodeServer.onPrompt = (sessionId) => {
      openCodeServer!.complete(nativeCorrelation(id, 'opencode-retry'), 'Retry completed', sessionId)
    }
    const retry = await writer.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: id, request: { requestId: 'opencode-retry', content: 'Retry',
        settings: operatorChatSettings(openCodeConfiguration()) },
    } })
    assert.notEqual(retry.isError, true, JSON.stringify(retry))
    await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
    assert.equal(openCodeServer.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/session?')).length, 1)
    assert.equal(openCodeServer.calls.filter((call) => call.path.includes('/prompt_async')).length, 1)
    assert.equal((await readOperator(id)).messages.filter((message) => message.role === 'assistant').at(-1)?.content,
      'Retry completed')
  })

  for (const kind of ['agent', 'operator'] as const) {
    it(`${kind} recovers every completed assistant item after startup persistence fails without resending`, async () => {
      await native.flag('hold-turn-start-ack')
      await database.pool.query(`create function fail_native_turn_identity() returns trigger language plpgsql as $$
        begin
          if new.active_phase='submitted' and old.active_phase is distinct from 'submitted' then
            raise exception 'Native identity persistence fault';
          end if;
          return new;
        end $$`)
      await database.pool.query(`create trigger fail_native_turn_identity before update on operator_conversations
        for each row execute function fail_native_turn_identity()`)
      const id = kind === 'agent' ? (await sendAgent({ ...request('retained', null), content: 'wait' })).state.conversation!.id
        : await createOperator()
      if (kind === 'operator') await sendOperator(id, 'retained', 'wait')
      const nativeRequest = await until(async () => (await native.wire('turn/start'))[0])
      const sessionId = String((nativeRequest.params as { threadId: string }).threadId)
      const turn = (await state(native.directory, sessionId)).turns[0]!
      const commentary = agentMessage('commentary', 'Before the final answer', 'commentary')
      const answer = agentMessage('answer', 'The final answer')
      const params = { threadId: sessionId, turnId: turn.id }
      await emit(native.directory, { method: 'item/started', params: {
        ...params, startedAtMs: 1, item: { ...commentary, text: '' },
      } })
      await emit(native.directory, { method: 'item/agentMessage/delta', params: {
        ...params, itemId: commentary.id, delta: commentary.text,
      } })
      await emit(native.directory, { method: 'item/completed', params: {
        ...params, completedAtMs: 2, item: commentary,
      } })
      await emit(native.directory, { id: nativeRequest.id, result: { turn } })
      await until(async () => kind === 'agent'
        ? (await repository.turn(id, 'retained'))?.delivery === 'unknown' || undefined
        : (await readOperator(id)).turnState === 'uncertain' || undefined)
      assert(Array.isArray(turn.items))
      await emit(native.directory, { method: 'turn/completed', params: { threadId: sessionId, turn: {
        ...turn, status: 'completed', completedAt: 3, items: [...turn.items, commentary, answer],
      } } })
      await until(async () => (await state(native.directory, sessionId)).turns[0]!.status === 'completed' || undefined)
      await database.pool.query('drop trigger fail_native_turn_identity on operator_conversations')
      await until(async () => {
        if (kind === 'agent') {
          await agentChat.recover()
          return (await repository.turn(id, 'retained'))?.delivery === 'completed' || undefined
        }
        await operatorChat.reconcileActive()
        return (await readOperator(id)).turnState === 'idle' || undefined
      })
      const readback = kind === 'agent' ? await readAgent() : await readOperator(id)
      assert.deepEqual(readback.messages.filter((message) => message.role === 'assistant').map((message) => message.content),
        [commentary.text, answer.text])
      assert.equal((await native.wire('turn/start')).length, 1)
    })

    it(`${kind} retains a late definitive creation rejection, cleans up, and permits explicit retry`, async () => {
      await native.flag('late-reject-thread-start')
      const id = kind === 'agent' ? (await sendAgent(request('late-rejected', null))).state.conversation!.id
        : await createOperator()
      if (kind === 'operator') await sendOperator(id, 'late-rejected')
      await until(async () => kind === 'agent'
        ? (await repository.turn(id, 'late-rejected'))?.delivery === 'unknown' || undefined
        : (await readOperator(id)).turnState === 'uncertain' || undefined)
      await until(async () => {
        if (kind === 'agent') {
          await agentChat.recover()
          return (await repository.turn(id, 'late-rejected'))?.delivery === 'failed' || undefined
        }
        await operatorChat.reconcileActive()
        return (await readOperator(id)).turnState === 'error' || undefined
      })
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 0)
      if (kind === 'agent') {
        assert.equal((await repository.get(id))!.record.sessionCreation, undefined)
        assert.equal((await readAgent()).availability.canSend, true)
      } else assert.equal((await readOperator(id)).activeRequestId, null)
      await native.unflag('late-reject-thread-start')
      if (kind === 'agent') {
        await sendAgent(request('retry', id))
        await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
      } else {
        await sendOperator(id, 'retry')
        await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
      }
      assert.equal((await native.wire('thread/start')).length, 2)
      assert.equal((await native.wire('turn/start')).length, 1)
    })

    for (const restart of [false, true]) {
      it(`${kind} settles a known unsent attachment after cleanup retry${restart ? ' across restart' : ''}`, async () => {
        const ports = filePorts()
        let cleanupFails = true
        let preparationFails = true
        let rechecks = 0
        const files: CodexChatFiles = {
          prepare: async ({ session, signal }) => prepareCodexFileTurn({
            ownerPrincipalId: 'owner-a', scope: fileScope, nativeSessionId: session.nativeSessionId,
            admissionId: 'input-admission', executionHostId: 'execution-host-a', projectMode: 'read', allowMutation: false,
            allowedTools: ['files.list', 'files.read'], expiresAt: new Date(Date.now() + 60_000), attachments: [sourceRef],
          }, { ...ports.dependencies, files: ports.files, source: {
            ...ports.dependencies.source, recheck: async () => {
              rechecks++
              if (preparationFails && rechecks === 2) throw new Error('Attachment disappeared before submission.')
              return ports.dependencies.source.recheck()
            },
          }, host: { ...ports.host, close: async () => {
            if (cleanupFails) throw new Error('Host closure is unconfirmed.')
            await ports.host.close()
          } } }, signal),
        }
        if (kind === 'agent') agentFiles = files
        else operatorFiles = files
        const id = kind === 'agent' ? (await sendAgent(request('unsent', null))).state.conversation!.id
          : await createOperator()
        if (kind === 'operator') await sendOperator(id, 'unsent')
        try {
          await until(async () => {
            const row = kind === 'agent' ? await repository.get(id) : await messages.active(id)
            return row && nativeNonSubmission(row.record, 'unsent') || undefined
          })
          assert.equal((await native.wire('turn/start')).length, 0)
          if (kind === 'agent') assert.equal((await readAgent()).availability.canSend, false)
          else assert.equal((await readOperator(id)).activeRequestId, 'unsent')
        } finally { cleanupFails = false }
        if (restart) {
          if (kind === 'agent') {
            await agentChat.shutdown()
            restartAgentService()
          } else {
            await operatorChat.shutdown()
            operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
              resolver, native.directory, authority)
            services.operatorChat = operatorChat
          }
        }
        await until(async () => {
          if (kind === 'agent') {
            await agentChat.recover()
            return (await repository.turn(id, 'unsent'))?.delivery === 'failed' || undefined
          }
          await operatorChat.reconcileActive()
          return (await readOperator(id)).turnState === 'error' || undefined
        })
        assert(ports.events.includes('host:close'))
        assert.equal((await native.wire('turn/start')).length, 0)
        assert.equal((await native.wire('thread/read')).length, 0)
        preparationFails = false
        if (kind === 'agent') {
          await sendAgent(request('retry', id))
          await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
        } else {
          await sendOperator(id, 'retry')
          await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
        }
        assert.equal((await native.wire('thread/start')).length, 1)
        assert.equal((await native.wire('turn/start')).length, 1)
      })
    }
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

  it('Agent retains non-submission across restart when recovered creation settlement fails', async () => {
    await native.flag('late-thread-start')
    await database.pool.query(`create function fail_chat_settlement() returns trigger language plpgsql as $$
      begin
        if old.active_request_id='late' and new.active_request_id is null then
          raise exception 'Settlement persistence fault';
        end if;
        return new;
      end $$`)
    await database.pool.query(`create trigger fail_chat_settlement before update on operator_conversations
      for each row execute function fail_chat_settlement()`)
    const admitted = await sendAgent(request('late', null))
    const id = admitted.state.conversation!.id
    const bound = await until(async () => {
      await agentChat.recover()
      const row = await repository.get(id)
      return row?.native_session_id && nativeNonSubmission(row.record, 'late') ? row : undefined
    })
    assert.equal(bound.active_request_id, 'late')
    assert.equal(bound.record.nativeNonSubmission?.operation, 'turn_submission')
    assert.equal((await native.wire('turn/start')).length, 0)
    await agentChat.shutdown()
    restartAgentService()
    await database.pool.query('drop trigger fail_chat_settlement on operator_conversations')
    await until(async () => {
      await agentChat.recover()
      return (await repository.turn(id, 'late'))?.delivery === 'failed' || undefined
    })
    assert.equal((await native.wire('thread/read')).length, 0)
    assert.equal((await native.wire('thread/start')).length, 1)
    await native.unflag('late-thread-start')
    await sendAgent(request('retry', id))
    await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
    assert.equal((await repository.get(id))!.native_session_id, bound.native_session_id)
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
      await assert.rejects(repository.bindCreatedSession(id, requestId, configurationId, { ...session, harness },
        { outcome: 'failed' }),
        { code: 'AGENT_CHAT_SESSION_CONFLICT' })
      assert.deepEqual(await repository.get(id), row)
    }
    await database.pool.query('update operator_conversations set active_native_turn_id=$2 where id=$1', [id, 'prior-turn'])
    await assert.rejects(repository.bindCreatedSession(id, 'late', row.agent_configuration_version_id, session,
      { outcome: 'failed' }),
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
  for (const kind of ['questions', 'form', 'standalone-form'] as const) {
    it(`Agent ${kind} responses validate through HTTP and MCP, persist, and never replay native input`, async () => {
      const admitted = await sendAgent({ ...request('input-turn', null), content: 'wait' })
      const id = admitted.state.conversation!.id
      const active = await until(async () => {
        const current = await readAgent()
        return current.activeTurn?.nativeTurnId && current.conversation?.nativeSession ? current : undefined
      })
      const params = kind === 'questions' ? {
        itemId: 'questions', isBlocking: true, autoResolutionMs: null,
        questions: [{ id: 'answer', header: 'Answer', question: 'What should happen next?',
          isOther: true, isSecret: true, options: null }],
      } : { mode: 'openai/form', serverName: 'app', message: 'Enter details', _meta: null,
        requestedSchema: { type: 'object', additionalProperties: false,
          properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } }
      const method = kind === 'questions' ? 'item/tool/requestUserInput' : 'mcpServer/elicitation/request'
      await emit(native.directory, { id: 5101, method, params: {
        threadId: active.conversation!.nativeSession!.nativeSessionId,
        turnId: kind === 'standalone-form' ? null : active.activeTurn!.nativeTurnId, ...params,
      } })
      const pending = await until(async () => (await readAgent()).pendingInteraction)
      if (kind === 'standalone-form') assert.equal(pending.turn.nativeTurnId, undefined)
      const response: InteractionResponseValue = kind === 'questions'
        ? { answer: { answers: ['User-entered answer'] } } : { count: 2 }
      const input = { requestId: 'input-response', nativeRequestId: pending.turn.nativeRequestId!,
        optionId: pending.responseOptions[0]!.optionId, response }
      const responses = async () => (await calls(native.directory)).filter((entry) => {
        const wire = entry.wire as { id?: number; result?: unknown } | undefined
        return wire?.id === 5101 && wire.result
      })
      assert.equal((await responses()).length, 0)
      const refusal = await denied.callTool({ name: 'agent_chat_respond', arguments: {
        workspaceId, conversationId: id, ...input,
      } }).catch(() => ({ isError: true }))
      assert.equal(refusal.isError, true)
      const invalid = await app.inject({ method: 'POST',
        url: `/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/responses`,
        headers: { authorization: `Bearer ${writerToken}` }, payload: { ...input, response: {} } })
      assert.equal(invalid.statusCode, 400)
      assert.equal((await responses()).length, 0)
      assert.equal((await readAgent()).pendingInteraction?.turn.nativeRequestId, pending.turn.nativeRequestId)
      const valid = await writer.callTool({ name: 'agent_chat_respond', arguments: {
        workspaceId, conversationId: id, ...input,
      } })
      assert.notEqual(valid.isError, true, JSON.stringify(valid))
      const receipt = (await database.pool.query(`select result from management_command_receipts
        where operation='agent_chat_control' and command_id=$1`, [input.requestId])).rows[0]!
      assert.deepEqual(receipt.result.acceptedControl.choice.response, response)
      assert.equal(receipt.result.status, 'completed')
      if (kind === 'questions') assert.equal(receipt.result.providerAcknowledgment, undefined)
      else {
        assert.equal(receipt.result.providerAcknowledgment.nativeRequestId, input.nativeRequestId)
        assert.equal(receipt.result.providerAcknowledgment.optionId, input.optionId)
        assert.match(receipt.result.providerAcknowledgment.responseDigest, /^[a-f0-9]{64}$/)
      }
      const state = (valid.structuredContent as { state: AgentChatState }).state
      const activity = state.activitySnapshot
      const decisions = [...(activity?.pendingInteractions ?? []),
        ...(activity?.activities.flatMap((item) => item.kind === 'interaction' ? [item.interaction] : []) ?? [])]
        .filter((item) => item.native?.requestId === input.nativeRequestId && item.answerRecorded)
      assert(decisions.length > 0)
      assert(decisions.every((item) => item.providerAcknowledged === (kind !== 'questions')))
      const replay = await writer.callTool({ name: 'agent_chat_respond', arguments: {
        workspaceId, conversationId: id, ...input,
      } })
      assert.notEqual(replay.isError, true, JSON.stringify(replay))
      assert.equal((await responses()).length, 1)
      const conflict = await writer.callTool({ name: 'agent_chat_respond', arguments: {
        workspaceId, conversationId: id, ...input,
        response: kind === 'questions' ? { answer: { answers: ['Different answer'] } } : { count: 3 },
      } })
      assert.equal(conflict.isError, true)
      assert.equal((await responses()).length, 1)
      const nativeResponse = (await responses())[0]!.wire as { result: unknown }
      assert.deepEqual(nativeResponse.result, kind === 'questions' ? { answers: response }
        : { action: 'accept', content: response, _meta: null })
    })

    it(`Operator ${kind} responses deny read-only callers and preserve HTTP/MCP readback after service restart`, async () => {
      const id = await createOperator()
      await sendOperator(id, 'input-turn', 'wait')
      const submission = await until(async () => {
        const row = await messages.active(id)
        return row?.native_session_id && row.active_native_turn_id ? row : undefined
      })
      const params = kind === 'questions' ? {
        itemId: 'questions', isBlocking: true, autoResolutionMs: null,
        questions: [{ id: 'answer', header: 'Answer', question: 'What should happen next?',
          isOther: true, isSecret: false, options: null }],
      } : { mode: 'openai/form', serverName: 'app', message: 'Enter details', _meta: null,
        requestedSchema: { type: 'object', additionalProperties: false,
          properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } }
      const method = kind === 'questions' ? 'item/tool/requestUserInput' : 'mcpServer/elicitation/request'
      await emit(native.directory, { id: 5102, method, params: {
        threadId: submission.native_session_id,
        turnId: kind === 'standalone-form' ? null : submission.active_native_turn_id, ...params,
      } })
      const pending = await until(async () => (await readOperator(id)).pendingInteraction)
      if (kind === 'standalone-form') assert.equal(pending.turn.nativeTurnId, undefined)
      const response: InteractionResponseValue = kind === 'questions'
        ? { answer: { answers: ['User-entered answer'] } } : { count: 2 }
      const input = { commandId: 'input-response', requestId: 'input-turn', nativeRequestId: pending.turn.nativeRequestId!,
        optionId: pending.responseOptions[0]!.optionId, response }
      const responses = async () => (await calls(native.directory)).filter((entry) => {
        const wire = entry.wire as { id?: number; result?: unknown } | undefined
        return wire?.id === 5102 && wire.result
      })
      const deniedHttp = await app.inject({ method: 'POST', url: `/api/operator/conversations/${id}/responses`,
        headers: { authorization: `Bearer ${readerToken}` }, payload: input })
      assert.equal(deniedHttp.statusCode, 403)
      const deniedMcp = await reader.callTool({ name: 'operator_chat_respond', arguments: {
        conversationId: id, request: input,
      } }).catch(() => ({ isError: true }))
      assert.equal(deniedMcp.isError, true)
      const invalid = await writer.callTool({ name: 'operator_chat_respond', arguments: {
        conversationId: id, request: { ...input, response: {} },
      } })
      assert.equal(invalid.isError, true)
      assert.equal((await responses()).length, 0)
      const accepted = await app.inject({ method: 'POST', url: `/api/operator/conversations/${id}/responses`,
        headers: { authorization: `Bearer ${writerToken}` }, payload: input })
      assert.equal(accepted.statusCode, 200, accepted.body)
      const receipt = (await database.pool.query(`select result from management_command_receipts
        where operation='operator_chat_control' and command_id=$1`, [input.commandId])).rows[0]!
      assert.deepEqual(receipt.result.acceptedControl.choice.response, response)
      assert.equal(receipt.result.status, 'completed')
      if (kind === 'questions') assert.equal(receipt.result.providerAcknowledgment, undefined)
      else {
        assert.equal(receipt.result.providerAcknowledgment.nativeRequestId, input.nativeRequestId)
        assert.equal(receipt.result.providerAcknowledgment.optionId, input.optionId)
        assert.match(receipt.result.providerAcknowledgment.responseDigest, /^[a-f0-9]{64}$/)
      }
      const activity = (accepted.json().state as OperatorConversationState).activitySnapshot
      const decisions = [...(activity?.pendingInteractions ?? []),
        ...(activity?.activities.flatMap((item) => item.kind === 'interaction' ? [item.interaction] : []) ?? [])]
        .filter((item) => item.native?.requestId === input.nativeRequestId && item.answerRecorded)
      assert(decisions.length > 0)
      assert(decisions.every((item) => item.providerAcknowledged === (kind !== 'questions')))
      await operatorChat.shutdown()
      operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
        resolver, native.directory, authority)
      services.operatorChat = operatorChat
      await app.close()
      app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
        checkpoints: { ping: async () => undefined } }, operator: { access, services } })
      const origin = await app.listen({ host: '127.0.0.1', port: 0 })
      const restarted = new Client({ name: 'restarted-input-response', version: '1' })
      clients.push(restarted)
      await restarted.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        authProvider: { token: async () => writerToken },
      }))
      const replay = await restarted.callTool({ name: 'operator_chat_respond', arguments: {
        conversationId: id, request: input,
      } })
      assert.notEqual(replay.isError, true, JSON.stringify(replay))
      const http = await app.inject({ method: 'GET', url: `/api/operator/conversations/${id}`,
        headers: { authorization: `Bearer ${writerToken}` } })
      assert.equal(http.statusCode, 200)
      assert.equal((await responses()).length, 1)
      assert.deepEqual((await database.pool.query(`select result from management_command_receipts
        where operation='operator_chat_control' and command_id=$1`, [input.commandId])).rows[0]!.result, receipt.result)
    })
  }
})
