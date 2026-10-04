import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { NativeHarnessEvent, NativeSessionReference } from '@graphql/contracts'
import type { ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorConversationRepository, nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import { createPostgresClaudeInteractionBridge } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { claudeNativeEvent } from '../src/modules/harnesses/claudeSdk/nativeEvents.js'
import { createClaudeEventNormalizer } from '../src/modules/harnesses/claudeSdk/normalization.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { createClaudeSdkCallbacks } from '../src/modules/harnesses/claudeSdk/sdkCallbacks.js'
import {
  createClaudeNativeSessionManager, type ClaudeMessageTurnInput, type ClaudeNativeSessionManager,
} from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { agent3Database } from './helpers/wave25Agent3.js'

async function drain(events: AsyncIterable<NativeHarnessEvent>) {
  const values: NativeHarnessEvent[] = []
  for await (const event of events) values.push(event)
  return values
}

it('persists one message admission across later tool rounds and validates each callback against the real domain', async () => {
  const db = await agent3Database()
  let manager: ClaudeNativeSessionManager | undefined
  try {
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'Session callback writer', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond'], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    const reader = await access.issue({ name: 'Session callback reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const harness: ClaudeHarnessConfiguration = {
      harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: db.directory,
      permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'], permissionRules: [],
      instructions: '', mcpServers: {},
    }
    const operators = new PostgresOperatorRepository(db.pool)
    const original = await operators.ensure()
    const configured = await operators.update(harness, original.configuration.id)
    const repository = new PostgresOperatorConversationRepository(db.pool)
    const conversation = await repository.create(configured.operator.id, configured.configuration, writer.principal.id)
    const session: NativeSessionReference = { harness: 'claude', providerVersion: '2.1.284', nativeSessionId: randomUUID() }
    const frames = new ClaudeBoundedQueue<unknown>(32)
    let messages!: AsyncIterator<ClaudeSdkUserMessage>
    const query = vi.fn<ClaudeSdkClient['query']>(input => {
      messages = input.prompt[Symbol.asyncIterator]()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
        initializationResult: async () => ({}), interrupt: async () => undefined, close: () => frames.close() }
    })
    const sdk: ClaudeSdkClient = {
      sdkVersion: '0.3.284', query, getSessionInfo: async sessionId => ({ sessionId }),
      getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'unused' }),
    }
    const domain = createPostgresClaudeInteractionBridge({ database: db.pool, configuration: harness,
      binding: { kind: 'operator', conversationId: conversation.id, repository },
      manager: { nativeCallbackContext: (nativeSessionId, toolUseId) =>
        manager!.nativeCallbackContext(nativeSessionId, toolUseId) } })
    const callbacks = createClaudeSdkCallbacks({ manager: () => manager!, bridge: domain.bridge })
    manager = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
      scope: { deviceId: 'main', profilePath: db.directory, configRevision: configured.configuration.id, cwd: db.directory },
      sdkOptions: callbacks, qualification: { sdkVersion: sdk.sdkVersion, cliVersion: session.providerVersion,
        basicTurns: true, resume: true, fork: false, history: true, interactions: true },
      interactionPort: domain.interactionPort, liveCallbacks: domain.bridge,
      cancelPendingRequests: () => domain.bridge.close(),
      pendingInteractions: value => domain.bridge.pendingInteractions(value),
      decodeFactory() {
        const normalizer = createClaudeEventNormalizer({
          owner: { ownerId: conversation.id, attemptId: 'conversation', generation: 'fixture' },
          observedAt: () => new Date().toISOString(),
        })
        return raw => normalizer.ingest(raw).map(event => claudeNativeEvent(event, 0))
      },
    })
    const start: NativeSessionStart = { kind: 'operator', correlationId: 'attach',
      configuration: configured.configuration, workingDirectory: db.directory }
    await manager.attachSession(session, start)
    const begin = async (requestId: string) => {
      await repository.beginTurn(conversation.id, { requestId, content: 'Read the files' }, writer.principal.id)
      await repository.bind(conversation.id, requestId, session.providerVersion, session.nativeSessionId)
      expect(await repository.phase(conversation.id, requestId, 'submitting')).toBe(true)
      const admission = await domain.callbackAdmission()
      const input: ClaudeMessageTurnInput = { prompt: 'Read the files',
        clientCorrelationId: nativeCorrelation(conversation.id, requestId), callbackAuthority: admission,
        onMessageSubmitted: async receipt => {
          expect(await repository.submittedMessage(conversation.id, requestId, receipt)).toBe(true)
        } }
      const output = drain(manager!.startTurn(session, input))
      return { output, message: (await messages.next()).value! }
    }
    const assistant = (id: string, content: unknown[], promptUuid?: string) => frames.offer({
      type: 'assistant', session_id: session.nativeSessionId, parent_tool_use_id: null, uuid: randomUUID(),
      message: { id, content }, ...(promptUuid ? { user_message_uuid: promptUuid } : {}),
    })
    const result = (promptUuid: string) => frames.offer({ type: 'result', session_id: session.nativeSessionId,
      uuid: `result-${promptUuid}`, user_message_uuid: promptUuid, subtype: 'success', is_error: false, result: 'done' })

    const oldId = randomUUID()
    const old = await begin(oldId)
    assistant('older', [{ type: 'text', text: 'older response' }], old.message.uuid)
    result(old.message.uuid)
    await old.output
    expect(await repository.finish(conversation.id, oldId, { outcome: 'succeeded', output: 'done' })).toBe(true)

    const requestId = randomUUID()
    const current = await begin(requestId)
    for (const [index, messageId] of ['A1', 'A2'].entries()) {
      const toolUseID = `tool-${index}`
      const request = `control-${index}`
      const signal = new AbortController().signal
      const decision = callbacks.canUseTool!('Read', { file_path: `${db.directory}/file` }, {
        signal, toolUseID, requestId: request,
      })
      assistant(messageId, [{ type: 'tool_use', id: toolUseID, name: 'Read', input: {} }],
        index === 0 ? current.message.uuid : undefined)
      await vi.waitFor(async () => {
        expect((await repository.get(conversation.id))?.pendingInteraction?.turn.nativeRequestId).toBe(request)
      })
      const context = manager.nativeCallbackContext(session.nativeSessionId, toolUseID)!
      expect(context.nativeMessageId).toBe(current.message.uuid)
      const identity = { ...context, ownerPrincipalId: writer.principal.id, attemptId: requestId,
        toolUseId: toolUseID, nativeRequestId: request, nativeRequestType: 'can_use_tool' as const }
      await expect(domain.authority.validate({ ...identity, ownerPrincipalId: reader.principal.id }))
        .rejects.toThrow('no longer matches')
      await domain.authority.validate(identity)
      const option = domain.bridge.pendingInteractions(session)[0]!.responseOptions
        .find(value => value.semantic === 'approve_once')!
      const control = { schemaVersion: 1, kind: 'respond', modelRequestId: requestId, conversationId: conversation.id,
        scope: { kind: 'operator_chat', conversationId: conversation.id },
        native: { harness: 'claude', providerVersion: session.providerVersion, sessionId: session.nativeSessionId,
          messageId: current.message.uuid, generation: context.generation, requestId: request, requestType: 'can_use_tool' },
        choice: { optionId: option.optionId, semantic: option.semantic } }
      await db.pool.query(`insert into management_command_receipts
        (principal_id,operation,command_id,target_key,input_hash,result) values ($1,'operator_chat_control',$2,$3,$4,$5::jsonb)`,
      [writer.principal.id, randomUUID(), conversation.id, `claim-${index}`,
        JSON.stringify({ status: 'pending', acceptedControl: control })])
      expect(await repository.claimResponse(conversation.id, requestId, request)).toBe(true)
      await manager.respond(session, request, option)
      expect((await decision).behavior).toBe('allow')
      frames.offer({ type: 'user', session_id: session.nativeSessionId, uuid: `tool-result-${index}`,
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, content: 'file' }] } })
      if (index === 0) assistant('older', [{ type: 'text', text: 'late older response' }])
    }
    assistant('A3', [{ type: 'text', text: 'final response' }])
    result(current.message.uuid)
    const output = await current.output
    expect(output.some(event => event.payload.text === 'late older response')).toBe(false)
    expect(output.find(event => event.payload.text === 'final response')?.payload.clientCorrelationId)
      .toBe(nativeCorrelation(conversation.id, requestId))
    expect(await repository.submittedMessageId(conversation.id, requestId)).toBe(current.message.uuid)
    expect((await manager.reconcile(session, nativeCorrelation(conversation.id, requestId))).terminalResult)
      .toEqual({ outcome: 'succeeded', output: 'done' })
    expect(query).toHaveBeenCalledTimes(1)
  } finally {
    await manager?.dispose?.()
    await db.close()
  }
}, 60_000)
