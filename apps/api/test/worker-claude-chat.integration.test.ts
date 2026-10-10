import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, SessionControlStateSchema, SessionPreferencesSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { workerClaudeReplacementFixture } from '../src/modules/conversations/workerClaudeReplacement.test-support.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { readSystemPromptSetting } from '../src/modules/settings/foundation.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

it('preserves remote Claude ownership and definite non-delivery through authenticated Operator MCP', async () => {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent', 'claude')
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  fixture.configurations = fixture.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: recorded.configuration.harness, harnessProfileSelection: recorded.binding.profile }))
  let worker: Awaited<ReturnType<typeof workerClaudeReplacementFixture>> | undefined
  let chat: AgentChatService | undefined
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'remote Claude writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }] })
    const reader = await access.issue({ name: 'remote Claude reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    const repository = new PostgresAgentChatRepository(db.pool)
    const messages = new PostgresOperatorConversationRepository(db.pool)
    const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const conversation = await repository.ensureForControls(agentChatKey(context), { context,
      agentConfigurationVersionId: configuration.id, harness: 'claude', origin: { kind: 'fresh' },
      workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'remote-chat') }, async () => {})
    worker = await workerClaudeReplacementFixture({ ...recorded, configuration,
      binding: { ...recorded.binding, workingDirectory: db.directory,
        systemPrompt: await readSystemPromptSetting(db.pool), owner: { kind: 'agent',
        conversationId: conversation.id, workspaceId: configuration.workspaceId,
        workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: configuration.agentId,
        configurationVersionId: configuration.id, configurationHash: commandInputHash(configuration) } } })
    chat = new AgentChatService(db.pool, repository, messages, new PostgresWorkflowRepository(db.pool), {
      getForWorkspace: async () => { throw new Error('Chat must not select a Run.') },
      executionPages() { throw new Error('Chat must not select a Run execution.') },
    }, (id, selected, cwd) => {
      expect(id).toBe(conversation.id)
      expect(selected).toEqual(configuration)
      expect(cwd).toBe(db.directory)
      return worker!.createManager()
    }, db.directory)
    app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never } })
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }
    const call = (token: string, name: string, args: Record<string, unknown>) => graphRpc(app!, token, 'tools/call', {
      name, arguments: { workspaceId: seeded.scope.workspaceId, ...args },
    })
    const first = { requestId: 'remote-initial', content: 'Initial task', intent: 'next_turn',
      expectedConversationId: conversation.id, context: query }
    const denied = await call(reader.token, 'agent_chat_send', { request: first })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    expect(worker.offers).toHaveLength(0)
    const started = await call(writer.token, 'agent_chat_send', { request: first })
    expect(started.result?.isError).not.toBe(true)
    const id = conversation.id
    expect(graphRpcValue(started.result)).toMatchObject({ state: { conversation: { id } } })
    await vi.waitFor(async () => expect((await repository.turn(id, first.requestId))?.delivery).toBe('completed'))
    const nativeId = (await repository.get(id))!.native_session_id
    const previous = (await worker!.journal.conversations.read(worker!.binding))!.nativeOwner
    const controls = await call(writer.token, 'agent_chat_controls_get', { conversationId: id })
    const state = SessionControlStateSchema.parse(graphRpcValue(controls.result))
    const request = { requestId: 'remote-preferences', expectedRevision: state.revision, kind: 'preferences',
      preferences: SessionPreferencesSchema.parse({ autoCompact: 'off' }) }
    const deniedSettings = await call(reader.token, 'agent_chat_controls_update', { conversationId: id, request })
    expect(deniedSettings.error || deniedSettings.result?.isError).toBeTruthy()
    const applied = await call(writer.token, 'agent_chat_controls_update', { conversationId: id, request })
    expect(applied.result?.isError).not.toBe(true)
    expect(SessionControlStateSchema.parse(graphRpcValue(applied.result)).desired.autoCompact).toBe('off')
    const afterPreferences = { ...first, requestId: 'remote-after-preferences', expectedConversationId: id }
    expect((await call(writer.token, 'agent_chat_send', { request: afterPreferences })).result?.isError).not.toBe(true)
    await vi.waitFor(async () => expect((await repository.turn(id, afterPreferences.requestId))?.delivery).toBe('completed'))
    expect((await worker!.journal.conversations.read(worker!.binding))!.nativeOwner).not.toEqual(previous)
    worker!.failMode()
    const failedInput = { ...first, requestId: 'remote-unoffered', expectedConversationId: id, sessionMode: 'plan' }
    expect((await call(writer.token, 'agent_chat_send', { request: failedInput })).result?.isError).not.toBe(true)
    await vi.waitFor(async () => expect((await repository.turn(id, failedInput.requestId))?.delivery).toBe('failed'))
    expect((await repository.turn(id, failedInput.requestId))?.nativeSubmission).toBeUndefined()
    expect((await repository.get(id))?.active_request_id).toBeNull()
    expect(worker!.offers).toHaveLength(2)
    const retry = { ...first, requestId: 'remote-later', expectedConversationId: id }
    expect((await call(writer.token, 'agent_chat_send', { request: retry })).result?.isError).not.toBe(true)
    await vi.waitFor(async () => expect(await repository.turn(id, retry.requestId)).toMatchObject({ delivery: 'completed' }))
    const read = await call(writer.token, 'agent_chat_read', { query })
    expect(read.result?.isError).not.toBe(true)
    expect(graphRpcValue(read.result)).toMatchObject({ conversation: { id, nativeSession: { nativeSessionId: nativeId } } })
    const readControls = await call(writer.token, 'agent_chat_controls_get', { conversationId: id })
    expect(SessionControlStateSchema.parse(graphRpcValue(readControls.result)).applied?.autoCompact).toBe('off')
    await call(writer.token, 'agent_chat_send', { request: failedInput })
    expect(worker!.offers).toHaveLength(3)
  } finally {
    try { await chat?.shutdown() }
    finally {
      try { await worker?.close() }
      finally { try { await app?.close() } finally { await db.close() } }
    }
  }
}, 120_000)
