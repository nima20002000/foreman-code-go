import type pg from 'pg'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import type { ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import type { OperatorConfigurationVersion, NativeSessionReference, OperatorConversationState } from '@graphql/contracts'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { allocateClaudeNativeHarness } from '../src/modules/harnesses/claudeSdk/composition.js'
import { createPostgresClaudeInteractionBridge } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { createClaudeSdkCallbacks } from '../src/modules/harnesses/claudeSdk/sdkCallbacks.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { deferred } from './support/claudeProduction.js'

/** Native transport frames are doubled; runner, normalizer, manager, callback authority, caller and PostgreSQL are real. */
function runtime(pool: pg.Pool, repository: PostgresOperatorConversationRepository, configuration: OperatorConfigurationVersion,
  conversationId: string, directory: string, nativeHistory: unknown[], offers: string[]) {
  const domain = createPostgresClaudeInteractionBridge({ database: pool, configuration: configuration.harness as ClaudeHarnessConfiguration,
    binding: { kind: 'operator', conversationId, repository },
    manager: { nativeCallbackContext: (sessionId, toolId) => manager.nativeCallbackContext(sessionId, toolId) } })
  const frames = new ClaudeBoundedQueue<unknown>(64)
  const ready = deferred<AsyncIterator<ClaudeSdkUserMessage>>()
  let options!: Options
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284',
    query(input) {
      options = input.options as Options
      ready.resolve(input.prompt[Symbol.asyncIterator]())
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(),
        interrupt: async () => undefined, initializationResult: async () => ({}) }
    },
    getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => nativeHistory,
    forkSession: async () => { throw new Error('Approval recovery cannot fork a native session.') },
  }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  const open = runner.open.bind(runner)
  runner.open = async input => {
    const session = await open(input)
    const offer = session.offer.bind(session)
    session.offer = (message, signal) => { offers.push(message.promptUuid); return offer(message, signal) }
    return session
  }
  const manager: ClaudeNativeSessionManager = allocateClaudeNativeHarness({ harness: 'claude', role: 'operator', ownerAgentId: conversationId,
    workingDirectory: directory, appMcpAccess: 'none', scope: { deviceId: 'test-host', profilePath: '/test-profile', configRevision: '1', cwd: directory },
    runner, sdkOptions: createClaudeSdkCallbacks({ manager: () => manager, bridge: domain.bridge }),
    qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: false, history: true, interactions: true },
    interactionPort: domain.interactionPort, liveCallbacks: domain.bridge, cancelPendingRequests: () => domain.bridge.close(),
    pendingInteractions: session => domain.bridge.pendingInteractions(session),
    ownerForStart: () => ({ ownerId: conversationId, attemptId: 'model-request', generation: 'test-owner' }),
  }).manager
  domain.bridge.subscribePending(notification => manager.notifyPendingChanged(notification))
  const initial = manager.startInitialTurn.bind(manager)
  manager.startInitialTurn = async function* (start, message, signal) {
    yield* initial(start, { ...message, callbackAuthority: await domain.callbackAdmission() }, signal)
  }
  const reconcile = manager.reconcile.bind(manager)
  manager.reconcile = async (session, correlationId, signal) => ({ ...await reconcile(session, correlationId, signal),
    responseDeliveries: domain.bridge.deliveryEvidence(session) })
  return { manager, ready, frames, options: () => options }
}

it.each(['aborted', 'resident-write-loss', 'restart-without-proof', 'restart-with-stored-proof', 'restart-wrong-generation', 'terminal-after-response'] as const)(
  'recovers %s Claude approval through authenticated MCP with no response or prompt replay', async scenario => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const access = new PostgresAccessService(pool)
      const owner = await access.issue({ name: 'approval owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond'], scope: {} }] })
      const denied = await access.issue({ name: 'approval reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['operator_chat:read'], scope: {} }] })
      const settings = new PostgresFoundationSettingsRepository(pool)
      const defaults = await settings.getAgentDefaults()
      const harness: ClaudeHarnessConfiguration = { harness: 'claude', model: 'transport-fixture', authMode: 'subscription',
        configDirectory: '/test-profile', permissionMode: 'default', sandbox: 'read-only', tools: ['Read'],
        permissionRules: [{ tool: 'Read', effect: 'ask' }], instructions: '', mcpServers: {} }
      await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator, harness } }, defaults.revision)
      const repository = new PostgresOperatorConversationRepository(pool)
      const nativeHistory: unknown[] = []
      const offers: string[] = []
      const runtimes: ReturnType<typeof runtime>[] = []
      const createChat = () => new OperatorChatService(repository, new PostgresOperatorRepository(pool), (configuration, id) => {
        const owned = runtime(pool, repository, configuration, id, directory, nativeHistory, offers)
        runtimes.push(owned)
        return owned.manager
      }, directory, { current: id => access.currentOperator(id), assertConfiguration() {},
        setup: async () => ({ harness: 'claude', status: 'configured', endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
        prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {} })
      let chat = createChat()
      const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { operatorChat: { get: (...args: Parameters<OperatorChatService['get']>) => chat.get(...args),
          respond: (...args: Parameters<OperatorChatService['respond']>) => chat.respond(...args) },
        commands: new PostgresCommandCoordinator(pool) } as never } })
      const controller = new AbortController()
      const session: NativeSessionReference = { harness: 'claude', nativeSessionId: 'approval-session', providerVersion: '2.1.284' }
      let responses = 0
      try {
        const conversation = await chat.create(owner.principal)
        const id = conversation.id
        await chat.send(id, { requestId: 'model-request', content: 'Read an admitted file' }, owner.principal)
        await vi.waitFor(() => expect(runtimes).toHaveLength(1))
        const owned = runtimes[0]!
        const message = (await (await owned.ready.promise).next()).value!
        nativeHistory.push({ type: 'user', uuid: message.uuid, session_id: session.nativeSessionId,
          parent_tool_use_id: null, message: { role: 'user', content: 'Read an admitted file' } })
        void owned.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId, claude_code_version: session.providerVersion, cwd: directory })
        void owned.frames.offer({ type: 'assistant', uuid: 'tool-reply', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
          parent_tool_use_id: null, message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'read-tool', name: 'Read', input: { file_path: '/test-file' } }] } })
        const hook = { session_id: session.nativeSessionId, transcript_path: '/test-transcript', cwd: directory,
          tool_use_id: 'read-tool', tool_name: 'Read', tool_input: { file_path: '/test-file' } }
        const callbacks = owned.options()
        await callbacks.hooks!.PreToolUse![0]!.hooks[0]!({ ...hook, hook_event_name: 'PreToolUse' }, 'read-tool', { signal: controller.signal })
        const permission = callbacks.canUseTool!('Read', hook.tool_input, {
          toolUseID: 'read-tool', requestId: 'permission-request', signal: controller.signal,
        }).then(decision => { responses++; return decision })
        await vi.waitFor(async () => expect((await repository.get(id))?.pendingInteraction).toBeDefined())
        const admitted = await graphRpc(app, owner.token, 'tools/call', {
          name: 'operator_chat_get', arguments: { conversationId: id },
        })
        expect(admitted.result?.isError).not.toBe(true)
        expect(graphRpcValue(admitted.result)).toMatchObject({ activeRequestId: 'model-request',
          nativeSubmission: { kind: 'message', nativeSessionId: session.nativeSessionId,
            nativeMessageId: message.uuid, clientCorrelationId: `operator:${id}:model-request` } })
        const input = { commandId: 'response-command', requestId: 'model-request', nativeRequestId: 'permission-request', optionId: 'allow_once' }
        const deniedResponse = await graphRpc(app, denied.token, 'tools/call', { name: 'operator_chat_respond', arguments: { conversationId: id, request: input } })
        expect(deniedResponse.error || deniedResponse.result?.isError).toBeTruthy()
        expect((await pool.query('select count(*)::int as n from management_command_receipts')).rows[0].n).toBe(0)
        const query = pool.query.bind(pool)
        let validations = 0
        const spy = vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
          const statement = String(args[0])
          if (scenario === 'aborted' && statement.includes('select principal_id,result from management_command_receipts') && ++validations === 2) {
            controller.abort(new Error('SDK callback canceled after selection'))
          }
          if (scenario !== 'aborted' && statement.includes('with settled as')) return Promise.reject(new Error('Control outcome write lost'))
          return (query as (...values: unknown[]) => unknown)(...args)
        }) as typeof pool.query)
        const storedProof = scenario === 'restart-with-stored-proof' || scenario === 'restart-wrong-generation'
        if (storedProof) {
          const respond = owned.manager.respond.bind(owned.manager)
          owned.manager.respond = async (...args) => {
            await respond(...args)
            await callbacks.hooks!.PostToolUse![0]!.hooks[0]!({ ...hook, hook_event_name: 'PostToolUse', tool_response: 'read-completed' },
              'read-tool', { signal: new AbortController().signal })
          }
        }
        const response = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_respond', arguments: { conversationId: id, request: input } })
        spy.mockRestore()
        expect(response.result?.isError).toBe(true)
        expect((await permission)?.behavior).toBe(scenario === 'aborted' ? 'deny' : 'allow')
        const readReceipt = async () => (await pool.query('select result from management_command_receipts where command_id=$1', [input.commandId])).rows[0].result
        const original = await readReceipt()
        expect(original.status).toBe(scenario === 'aborted' ? 'uncertain' : 'pending')
        if (scenario === 'resident-write-loss' || scenario === 'terminal-after-response') {
          await callbacks.hooks!.PostToolUse![0]!.hooks[0]!({ ...hook, hook_event_name: 'PostToolUse', tool_response: 'read-completed' },
            'read-tool', { signal: new AbortController().signal })
        }
        if (scenario === 'terminal-after-response') {
          void owned.frames.offer({ type: 'user', uuid: 'completed-tool', session_id: session.nativeSessionId,
            parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-tool', content: 'read-completed' }] } })
          void owned.frames.offer({ type: 'assistant', uuid: 'after-approval-answer', session_id: session.nativeSessionId,
            user_message_uuid: message.uuid, parent_tool_use_id: null,
            message: { id: 'after-approval', content: [{ type: 'text', text: 'Tool completed after approval.' }] } })
          void owned.frames.offer({ type: 'result', uuid: 'after-approval-terminal', session_id: session.nativeSessionId,
            user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
          await vi.waitFor(async () => expect(await repository.terminal(id, 'model-request')).toBeDefined())
        }
        if (scenario.startsWith('restart')) {
          expect(Boolean(original.providerAcknowledgment)).toBe(storedProof)
          if (scenario === 'restart-wrong-generation') {
            original.providerAcknowledgment.nativeIdentity.generation = 'foreign-generation'
            await pool.query('update management_command_receipts set result=$1::jsonb where command_id=$2', [JSON.stringify(original), input.commandId])
          }
          await chat.shutdown()
          chat = createChat()
        }
        await chat.reconcileActive()
        const receipt = await readReceipt()
        const completed = scenario === 'resident-write-loss' || scenario === 'restart-with-stored-proof' || scenario === 'terminal-after-response'
        expect(receipt.status).toBe(completed ? 'completed' : original.status)
        if (completed) expect(receipt.providerAcknowledgment.nativeIdentity).toMatchObject({ kind: 'message', nativeMessageId: message.uuid })
        const readback = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_get', arguments: { conversationId: id } })
        expect(readback.result?.isError).not.toBe(true)
        const state = graphRpcValue(readback.result) as OperatorConversationState
        if (scenario === 'terminal-after-response') {
          expect(state.activeRequestId).toBeNull()
          expect(state.messages).toContainEqual(expect.objectContaining({ content: 'Tool completed after approval.' }))
          expect(state.activities).toContainEqual(expect.objectContaining({ kind: 'file_read', status: 'completed' }))
          expect((await repository.terminal(id, 'model-request'))?.closureState).toBe('closed')
        } else expect(state).toMatchObject({ nativeSubmission: { kind: 'message', nativeMessageId: message.uuid } })
        const activity = state.activitySnapshot?.activities.find(activity => activity.kind === 'interaction'
          && activity.interaction?.answerRecorded)
        const summary = activity?.kind === 'interaction' ? activity.interaction : undefined
        expect(summary?.providerAcknowledged).toBe(completed)
        if (!completed) expect(summary?.delivery).not.toBe('delivered')
        const replay = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_respond', arguments: { conversationId: id, request: input } })
        expect(Boolean(replay.result?.isError)).toBe(!completed)
        expect(offers).toEqual([message.uuid])
        expect(responses).toBe(1)
      } finally {
        vi.restoreAllMocks()
        controller.abort()
        await app.close()
        await chat.shutdown()
      }
    })
  }, 120_000)
