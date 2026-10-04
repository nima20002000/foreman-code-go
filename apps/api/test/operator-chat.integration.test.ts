import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagedAgentDefaultsSchema, AgentDefaultsUpdateResultSchema } from '@graphql/contracts/management'
import {
  applyOperatorChatSettings, operatorChatSettings, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, NativeHarnessEventSchema,
  type ExecutionResult, type NativeSessionReference, type OperatorConversationState,
} from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import {
  OperatorChatService, PostgresOperatorConversationRepository, type OperatorChatAuthority, type NativeManagerResolver,
} from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { createClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeSdkClient } from '../src/modules/harnesses/claudeSdk/port.js'

const connectionString = process.env.TEST_DATABASE_URL

/** Only provider I/O is fake: these tests exercise real migrations, SQL, grants and service transitions. */
class ChatManager implements NativeHarnessSessionManager {
  constructor(readonly harness: 'codex' | 'opencode' = 'codex') {}
  sessions = 0; turns = 0; attachments = 0; closes = 0; disposals = 0
  prompts: string[] = []
  publicMessages: string[] = []
  autoFinish = true; failAttach = false; cancelAcknowledged = true
  private readonly histories = new Map<string, NativeHistory>()
  private readonly active = new Map<string, string>()
  private readonly releases = new Map<string, () => void>()
  capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> { throw new Error('Not used by this provider fixture.') }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('Not used by this provider fixture.') }
  async createSession(): Promise<NativeSessionReference> {
    this.sessions++
    return { harness: this.harness, providerVersion: 'codex-cli 0.154.0', nativeSessionId: `native-${this.sessions}` }
  }
  async attachSession(session: NativeSessionReference) {
    this.attachments++
    if (this.failAttach) throw new Error('CODEX_SESSION_UNAVAILABLE')
    return session
  }
  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    this.turns++
    this.prompts.push(input.prompt)
    const correlation = input.clientCorrelationId
    const nativeTurnId = `turn-${this.turns}`
    this.active.set(session.nativeSessionId, correlation)
    this.histories.set(correlation, { correlationId: correlation, nativeTurnId, events: [], pendingInteractions: [] })
    await input.onSubmitted?.(nativeTurnId)
    yield NativeHarnessEventSchema.parse({ sequence: this.turns, type: 'assistant.delta', occurredAt: new Date().toISOString(), payload: { text: 'partial' } })
    for (const [index, text] of this.publicMessages.entries()) yield NativeHarnessEventSchema.parse({
      sequence: this.turns * 100 + index, type: 'item.completed', occurredAt: new Date().toISOString(),
      payload: { turnId: nativeTurnId, item: { id: `commentary-${index}`, type: 'agentMessage', text, phase: 'commentary' } },
    })
    if (this.autoFinish) this.finish(correlation)
    else if (!this.histories.get(correlation)?.terminalResult) await new Promise<void>((resolve) => {
      const done = () => { signal?.removeEventListener('abort', done); this.releases.delete(correlation); resolve() }
      this.releases.set(correlation, done)
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
  }
  finish(correlation: string, result: ExecutionResult = { outcome: 'succeeded', output: { text: 'final answer' } }) {
    const history = this.histories.get(correlation)
    if (history) {
      history.terminalResult = result
      history.nativeMessageId = `answer:${history.nativeTurnId}`
    }
    this.releases.get(correlation)?.()
  }
  async pending() { return undefined }
  async respond() {}
  async cancel(session: NativeSessionReference) {
    const correlation = this.active.get(session.nativeSessionId)
    if (!this.cancelAcknowledged || !correlation) return false
    this.finish(correlation, { outcome: 'canceled' })
    return true
  }
  async history(session: NativeSessionReference): Promise<NativeHistory> {
    return this.histories.get(this.active.get(session.nativeSessionId) ?? '') ?? { events: [], pendingInteractions: [] }
  }
  async reconcile(_session: NativeSessionReference, correlation: string): Promise<NativeHistory> {
    return this.histories.get(correlation) ?? { events: [], pendingInteractions: [] }
  }
  async close(session: NativeSessionReference) { this.closes++; this.releases.get(this.active.get(session.nativeSessionId) ?? '')?.() }
  async dispose() { this.disposals++; for (const release of this.releases.values()) release() }
}

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)) }
  throw new Error('Condition was not reached.')
}

let schema: string
let admin: pg.Pool
let pool: pg.Pool
let access: PostgresAccessService
let owner: ManagementPrincipal
let operators: PostgresOperatorRepository
let repository: PostgresOperatorConversationRepository
let manager: ChatManager
let authority: OperatorChatAuthority
let chat: OperatorChatService

beforeEach(async () => {
  let database: URL
  try { database = new URL(connectionString!) } catch { throw new Error('Use a loopback PostgreSQL database explicitly named for tests') }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
    || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(database.pathname.slice(1)))
    || database.search || database.hash) throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  schema = `chat_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  // A one-slot pool catches accidental post-commit nested checkouts.
  pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  access = new PostgresAccessService(pool)
  owner = (await access.issue({ name: 'chat owner', audience: 'operator',
    grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'settings:update', 'harnesses:read'], scope: {} }],
    expiresAt: new Date(Date.now() + 600_000) })).principal
  operators = new PostgresOperatorRepository(pool)
  repository = new PostgresOperatorConversationRepository(pool)
  manager = new ChatManager()
  authority = { current: (id) => access.currentOperator(id), assertConfiguration() {},
    setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
    prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {} }
  chat = new OperatorChatService(repository, operators, () => manager, '/tmp/graphql-test-operator', authority)
}, 30_000)

afterEach(async () => {
  await chat?.shutdown()
  await pool?.end()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.end()
})

describe.skipIf(!connectionString)('Operator chat persistence and native binding with stubbed authority', () => {
  it('projects accepted models through authenticated MCP and history without changing immutable turn or message facts', async () => {
    const writer = await access.issue({ name: 'Accepted model reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const source = await chat.create(writer.principal)
    const first = { requestId: 'accepted-sol', content: 'First model fixture',
      settings: { ...operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex), harness: 'codex' as const,
        model: 'gpt-6.1-sol', reasoningEffort: 'medium' as const, serviceTier: 'standard' as const } }
    const second = { ...first, requestId: 'accepted-luna', content: 'Second model fixture',
      settings: { ...first.settings, model: 'gpt-6-luna' } }
    await chat.send(source.id, first, writer.principal)
    await waitFor(async () => (await chat.get(source.id, writer.principal)).turnState === 'idle')
    await chat.send(source.id, second, writer.principal)
    await waitFor(async () => (await chat.get(source.id, writer.principal)).turnState === 'idle')
    const current = await operators.ensure()
    await operators.update({ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'different-future-default' }, current.configuration.id)
    const facts = async () => (await pool.query(`select record::text from operator_conversation_messages where conversation_id=$1 order by sequence`, [source.id])).rows
    const before = await facts()
    const acceptedFirst = await repository.acceptedConfiguration(source.id, first.requestId)
    const acceptedSecond = await repository.acceptedConfiguration(source.id, second.requestId)
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'accepted-model-parity', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const client = await connect(writer.token)
      const read = await client.callTool({ name: 'operator_chat_get', arguments: { conversationId: source.id } })
      expect(read.isError, JSON.stringify(read)).not.toBe(true)
      const state = read.structuredContent as OperatorConversationState
      expect(state.messages.map(message => [message.requestId, message.acceptedModel])).toEqual([
        [first.requestId, { harness: 'codex', model: first.settings.model }],
        [first.requestId, { harness: 'codex', model: first.settings.model }],
        [second.requestId, { harness: 'codex', model: second.settings.model }],
        [second.requestId, { harness: 'codex', model: second.settings.model }],
      ])
      const history = await chat.history(source.id, writer.principal, { limit: 2 })
      expect(history.entries.map(entry => entry.message.acceptedModel)).toEqual([
        { harness: 'codex', model: second.settings.model }, { harness: 'codex', model: second.settings.model },
      ])
      const older = await chat.history(source.id, writer.principal, { before: history.nextCursor!, limit: 2 })
      expect(older.entries.map(entry => entry.message.acceptedModel)).toEqual([
        { harness: 'codex', model: first.settings.model }, { harness: 'codex', model: first.settings.model },
      ])
      const denied = await access.issue({ name: 'No conversation read grant', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const deniedClient = await connect(denied.token)
      expect((await deniedClient.listTools()).tools.map(tool => tool.name)).not.toContain('operator_chat_get')
      await expect(deniedClient.callTool({ name: 'operator_chat_get', arguments: { conversationId: source.id } })).rejects.toThrow('not found')
      await expect(chat.get(source.id, denied.principal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(await facts()).toEqual(before)
      expect(await repository.acceptedConfiguration(source.id, first.requestId)).toEqual(acceptedFirst)
      expect(await repository.acceptedConfiguration(source.id, second.requestId)).toEqual(acceptedSecond)
    } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close() }
  })

  it('persists explicit Claude native-default effort through authenticated MCP and denies an ungranted writer', async () => {
    const defaults = new PostgresFoundationSettingsRepository(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const mainId = '11111111-1111-4111-8111-111111111111'
    const selection = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
      applicationInstallationId: mainId, harnessInstallationId: 'synthetic-haiku-installation', installationFingerprint: 'synthetic-payload' } }
    const base = { harness: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const, authMode: 'subscription' as const,
      configDirectory: '/synthetic/profile', permissionMode: 'default' as const, sandbox: 'read-only' as const,
      tools: ['Read'], permissionRules: [], instructions: 'Keep the saved read-only policy.', mcpServers: {} }
    const configuration = applyOperatorChatSettings(base, { harness: 'claude', model: 'claude-haiku-4-5-20251001', showThinking: false })
    const validated: unknown[] = []
    const prepared: unknown[] = []
    const service = new FoundationSettingsManagementService(defaults, commands, undefined, operators, {
      validateSelection: async (_principal, selected, harness) => { expect(selected).toEqual(selection); validated.push(harness) },
      prepareOperatorConfiguration: async (_principal, source, harness) => { expect(source).toBe('mcp'); prepared.push(harness); return selection },
    })
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { settings: service, operatorChat: chat, commands } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (actions: ManagementPrincipal['grants'][number]['actions']) => {
        const issued = await access.issue({ name: 'Claude effort settings', audience: 'operator', grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
        const client = new Client({ name: 'claude-effort-parity', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => issued.token } }))
        return client
      }
      const client = await connect(['settings:read', 'settings:update', 'harnesses:read', 'harnesses:update'])
      const read = async () => ManagedAgentDefaultsSchema.parse((await client.callTool({ name: 'agent_defaults_get', arguments: {} })).structuredContent)
      const before = await read()
      const input = { commandId: randomUUID(), expectedRevision: before.revision, value: { ...before.value,
        operator: { ...before.value.operator, harness: configuration } } }
      const accepted = AgentDefaultsUpdateResultSchema.parse((await client.callTool({ name: 'agent_defaults_update', arguments: input })).structuredContent)
      expect((await read()).value.operator.harness).toEqual(configuration)
      expect((await read()).value.operator.harness).not.toHaveProperty('effort')
      expect((await read()).value.operator.harness).toMatchObject({ sandbox: 'read-only', tools: ['Read'] })
      expect(validated).toEqual([configuration])
      expect(prepared).toEqual([configuration])
      expect((await read()).value.operator.harnessProfileSelection).toEqual(selection)
      const denied = await connect(['settings:read'])
      await expect(denied.callTool({ name: 'agent_defaults_update', arguments: { ...input, commandId: randomUUID() } })).rejects.toThrow('not found')
      expect((await read()).revision).toBe(accepted.value.revision)
      expect(validated).toHaveLength(1)
      expect(prepared).toHaveLength(1)
    } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close() }
  })

  it('changes harness in an empty conversation without a fork or inherited context', async () => {
    const openCode = new ChatManager('opencode')
    chat = new OperatorChatService(repository, operators,
      (configuration) => configuration.harness.harness === 'opencode' ? openCode : manager,
      '/tmp/graphql-test-operator', authority)
    const source = await chat.create(owner)
    const settings = new PostgresFoundationSettingsRepository(pool)
    const defaults = await settings.getAgentDefaults()
    await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator,
      harness: DEFAULT_HARNESS_DEFAULTS.opencode } }, defaults.revision)
    await operators.update(DEFAULT_HARNESS_DEFAULTS.opencode, (await operators.ensure()).configuration.id)
    const first = await chat.send(source.id, { requestId: 'empty-switch', content: 'First message.',
      settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.opencode), defaultsRevision: defaults.revision + 1, configurationVersionId: source.operatorConfigurationVersionId }, owner)
    expect(first.state.conversation.id).toBe(source.id)
    expect(first.state.handoff).toBeUndefined()
    await waitFor(async () => (await chat.get(source.id, owner)).turnState === 'idle')
    expect(openCode.prompts).toEqual(['First message.'])
  })
  it('keeps completed public messages through an active turn and final reconciliation', async () => {
    manager.autoFinish = false
    manager.publicMessages = ['I will create the folder.', 'The read-only sandbox blocked that attempt.']
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'commentary-turn', content: 'Create a folder.' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).messages.filter((message) => message.role === 'assistant').length === 2)
    manager.finish(nativeCorrelation(conversation.id, 'commentary-turn'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const messages = (await chat.get(conversation.id, owner)).messages.filter((message) => message.role === 'assistant')
    expect(messages.map((message) => message.content)).toEqual([
      'I will create the folder.', 'The read-only sandbox blocked that attempt.', 'final answer',
    ])
    expect(messages.map((message) => message.nativeMessageId)).toEqual(['commentary-0', 'commentary-1', 'answer:turn-1'])
  })
  it('forks the first cross-harness message with frozen context and idempotent retry', async () => {
    manager.publicMessages = ['First agent update.', 'Second agent update.']
    const openCode = new ChatManager('opencode')
    chat = new OperatorChatService(repository, operators,
      (configuration) => configuration.harness.harness === 'opencode' ? openCode : manager,
      '/tmp/graphql-test-operator', authority)
    const source = await chat.create(owner)
    await chat.send(source.id, { requestId: 'source-turn', content: 'Please inspect the release.' }, owner)
    await waitFor(async () => (await chat.get(source.id, owner)).turnState === 'idle')
    manager.publicMessages = []
    for (const [role, content] of [['tool', 'TOOL_RESULT_MUST_NOT_TRANSFER'], ['system', 'SYSTEM_TEXT_MUST_NOT_TRANSFER']] as const) {
      const id = randomUUID()
      await pool.query(`insert into operator_conversation_messages (id,conversation_id,role,content,record)
        values ($1,$2,$3,$4,$5::jsonb)`, [id,source.id,role,content,JSON.stringify({ id, conversationId: source.id, role, content })])
    }
    await pool.query(`insert into operator_conversation_activity (conversation_id,request_id,activity_id,record)
      values ($1,$2,$3,$4::jsonb)`, [source.id,'source-turn','mcp-result',JSON.stringify({
      id: 'mcp-result', requestId: 'source-turn', kind: 'mcp', title: 'MCP call', status: 'completed',
      input: 'MCP_INPUT_MUST_NOT_TRANSFER', output: 'MCP_OUTPUT_MUST_NOT_TRANSFER',
    })])
    const before = await chat.get(source.id, owner)
    const settings = new PostgresFoundationSettingsRepository(pool)
    const defaults = await settings.getAgentDefaults()
    const target = { ...DEFAULT_HARNESS_DEFAULTS.opencode, advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!,
      permissionRules: [{ permission: 'shell', pattern: '*', effect: 'deny' as const }] } }
    await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator, harness: target } }, defaults.revision)
    await operators.update(target, (await operators.ensure()).configuration.id)
    const input = { requestId: 'fork-turn', content: 'Continue with OpenCode.',
      settings: operatorChatSettings(target), forkExpectedRevision: before.revision, defaultsRevision: defaults.revision + 1, configurationVersionId: source.operatorConfigurationVersionId }
    const first = await chat.send(source.id, input, owner)
    expect(first.replayed).toBe(false)
    expect(first.state.conversation.id).toBe('operator-fork:fork-turn')
    expect(first.state.handoff).toMatchObject({ parentConversationId: source.id, sourceHarness: 'codex', omittedMessages: 0 })
    await waitFor(async () => (await chat.get(first.state.conversation.id, owner)).turnState === 'idle')
    const prompt = openCode.prompts[0]!
    expect(prompt).toContain('Please inspect the release.')
    const history = ['User: "Please inspect the release."', 'Assistant: "First agent update."',
      'Assistant: "Second agent update."', 'Assistant: "final answer"']
    expect(history.map((line) => prompt.indexOf(line))).toEqual([...history.map((line) => prompt.indexOf(line))].sort((a, b) => a - b))
    expect(history.every((line) => prompt.includes(line))).toBe(true)
    for (const excluded of ['TOOL_RESULT_MUST_NOT_TRANSFER', 'SYSTEM_TEXT_MUST_NOT_TRANSFER',
      'MCP_INPUT_MUST_NOT_TRANSFER', 'MCP_OUTPUT_MUST_NOT_TRANSFER']) expect(prompt).not.toContain(excluded)
    expect(openCode.prompts[0]).toContain('Current user message:\nContinue with OpenCode.')
    expect((await repository.configuration(first.state.conversation.operatorConfigurationVersionId!))?.harness).toMatchObject({
      harness: 'opencode', advanced: { permissionRules: [{ permission: 'shell', pattern: '*', effect: 'deny' }] },
    })
    expect((await chat.get(source.id, owner)).conversation.operatorConfigurationVersionId).toBe(before.conversation.operatorConfigurationVersionId)
    expect((await chat.send(source.id, input, owner)).replayed).toBe(true)
    expect((await repository.list(owner.id)).filter((item) => item.id === first.state.conversation.id)).toHaveLength(1)
    await chat.send(source.id, { requestId: 'return-to-parent', content: 'Continue with Codex.' }, owner)
    await waitFor(async () => (await chat.get(source.id, owner)).turnState === 'idle')
    expect(manager.sessions).toBe(1)
    const reader = (await access.issue({ name: 'Fork history reader', audience: 'operator',
      grants: [{ actions: ['operator_handoff:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })).principal
    await pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values ($1,$2)', [reader.id,first.state.conversation.id])
    const older = await chat.handoffHistory(reader)
    expect(older.sourceConversationId).toBe(source.id)
    expect(older.messages.map((message) => message.content)).toContain('Please inspect the release.')
    expect(older.messages.map((message) => message.content)).not.toContain('Continue with Codex.')
    expect(older.messages.map((message) => message.content)).not.toContain('TOOL_RESULT_MUST_NOT_TRANSFER')
    await expect(chat.handoffHistory(reader, 'unrelated-chat')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(chat.send(source.id, { ...input, requestId: 'stale-fork', forkExpectedRevision: before.revision - 1 }, owner))
      .rejects.toMatchObject({ code: 'CONVERSATION_REVISION_CONFLICT' })
  })
  describe('MCP fork source fixture', () => {
    let app: ReturnType<typeof buildApp>
    let address: string
    let clients: Client[]
    let connect: (actions: ManagementPrincipal['grants'][number]['actions']) => Promise<Client>
    let client: Client
    let sourceId: string
    let get: (id: string) => Promise<OperatorConversationState>
    let source: OperatorConversationState
    beforeEach(async () => {
      const openCode = new ChatManager('opencode')
      chat = new OperatorChatService(repository, operators,
        (configuration) => configuration.harness.harness === 'opencode' ? openCode : manager,
        '/tmp/graphql-test-operator', authority)
      const service = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(pool),
        new PostgresCommandCoordinator(pool), { qualifyConfiguration: async () => ({} as never) }, operators)
      app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { settings: service, operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
      clients = []
      address = await app.listen({ host: '127.0.0.1', port: 0 })
      connect = async (actions) => {
        const issued = await access.issue({ name: 'Fork MCP caller', audience: 'operator', grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
        const client = new Client({ name: 'fork-mcp', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => issued.token } }))
        return client
      }
      client = await connect(['operator_chat:read', 'operator_chat:write', 'settings:read', 'settings:update', 'harnesses:read'])
      const created = (await client.callTool({ name: 'operator_chat_create', arguments: {} })).structuredContent as { conversation: { id: string } }
      sourceId = created.conversation.id
      await client.callTool({ name: 'operator_chat_send', arguments: { conversationId: sourceId,
        request: { requestId: 'mcp-source', content: 'Remember the release details.' } } })
      get = async (id: string) => (await client.callTool({ name: 'operator_chat_get', arguments: { conversationId: id } })).structuredContent as OperatorConversationState
      await waitFor(async () => (await get(sourceId)).turnState === 'idle')
      source = await get(sourceId)
    })
    afterEach(async () => {
      for (const client of clients ?? []) await client.close()
      await app?.close()
    })
    it('offers the same fork through authenticated MCP with persisted readback and denied callers', async () => {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['operator_chat_create', 'operator_chat_get', 'operator_chat_send']))
      const defaults = (await client.callTool({ name: 'agent_defaults_get', arguments: {} })).structuredContent as { revision: number; value: typeof DEFAULT_AGENT_DEFAULTS }
      const target = { ...DEFAULT_HARNESS_DEFAULTS.opencode }
      const changed = await client.callTool({ name: 'agent_defaults_update', arguments: { commandId: randomUUID(), expectedRevision: defaults.revision,
        value: { ...defaults.value, operator: { ...defaults.value.operator, harness: target } } } })
      expect(changed.isError).not.toBe(true)
      const request = { requestId: 'mcp-fork', content: 'Continue with OpenCode.', settings: operatorChatSettings(target), forkExpectedRevision: source.revision, defaultsRevision: defaults.revision + 1, configurationVersionId: source.conversation.operatorConfigurationVersionId }
      const fork = (await client.callTool({ name: 'operator_chat_send', arguments: { conversationId: sourceId, request } })).structuredContent as { state: OperatorConversationState; replayed: boolean }
      expect(fork.state.handoff?.parentConversationId).toBe(sourceId)
      expect(fork.state.conversation.id).toBe('operator-fork:mcp-fork')
      await waitFor(async () => (await get(fork.state.conversation.id)).turnState === 'idle')
      expect((await get(fork.state.conversation.id)).messages.some((message) => message.content === 'Continue with OpenCode.')).toBe(true)
      expect((await get(sourceId)).conversation.operatorConfigurationVersionId).toBe(source.conversation.operatorConfigurationVersionId)
      expect(((await client.callTool({ name: 'operator_chat_send', arguments: { conversationId: sourceId, request } })).structuredContent as { replayed: boolean }).replayed).toBe(true)
      const delegated = await access.issue({ name: 'Bound handoff reader', audience: 'operator',
        grants: [{ actions: ['operator_handoff:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      await pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values ($1,$2)',
        [delegated.principal.id,fork.state.conversation.id])
      const reader = new Client({ name: 'handoff-reader', version: '1' }); clients.push(reader)
      await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => delegated.token } }))
      expect((await reader.listTools()).tools.map((tool) => tool.name)).toContain('operator_handoff_history_get')
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_chat_send')
      const history = (await reader.callTool({ name: 'operator_handoff_history_get', arguments: {} })).structuredContent as { messages: Array<{ content: string }> }
      expect(history.messages.map((message) => message.content)).toContain('Remember the release details.')
      expect((await reader.callTool({ name: 'operator_handoff_history_get', arguments: { sourceConversationId: 'unrelated-chat' } })).isError).toBe(true)
      const denied = await connect(['operator_chat:read'])
      expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_chat_send')
      await expect(denied.callTool({ name: 'operator_chat_send', arguments: { conversationId: sourceId, request } })).rejects.toThrow('not found')
    })
  })
  it('inspects persisted Claude setup through read-only HTTP and MCP without creating an execution owner', async () => {
    const settings = new PostgresFoundationSettingsRepository(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const inspected: Array<{ principalId: string; configurationId: string; profileId?: string }> = []
    let endpoint = ''
    let managersCreated = 0
    const inspectionAuthority: OperatorChatAuthority = { ...authority,
      setupConfiguration: (principal, configuration, signal) => new PostgresOperatorChatAuthority(pool, access, {} as NativeRollout,
        '/tmp/graphql-test-operator', endpoint, undefined, async () => {}, async (current, selected) => {
          inspected.push({ principalId: current.id, configurationId: selected.id,
            ...(selected.harnessProfileSelection ? { profileId: selected.harnessProfileSelection.instanceId } : {}) })
          return { harness: 'claude', status: 'configured', endpoint, checkedAt: new Date().toISOString() }
        }).setupConfiguration(principal, configuration, signal),
    }
    chat = new OperatorChatService(repository, operators, () => { managersCreated++; throw new Error('Setup must not allocate a turn manager') },
      '/tmp/graphql-test-operator', inspectionAuthority)
    const service = new FoundationSettingsManagementService(settings, commands, undefined, operators)
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { settings: service, operatorChat: chat, commands } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 }); endpoint = `${address}/mcp`
      const mainId = '11111111-1111-4111-8111-111111111111'
      const selector = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
        applicationInstallationId: mainId, harnessInstallationId: 'synthetic-claude-installation', installationFingerprint: 'synthetic-payload' } }
      const saved = await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator,
        harnessProfileSelection: selector, harness: { harness: 'claude', model: 'synthetic-claude-model', authMode: 'subscription',
          configDirectory: '/synthetic/profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '',
          mcpServers: { graphql: { type: 'http', url: endpoint } } } } }, 0)
      const first = (await operators.ensure()).configuration
      const reader = await access.issue({ name: 'Claude installation reader', audience: 'operator',
        grants: [{ actions: ['settings:read', 'harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const response = await fetch(`${address}/api/operator/setup?harness=claude&expectedDefaultsRevision=${saved.revision}`, { headers: { Authorization: `Bearer ${reader.token}` } })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: 'configured', harness: 'claude', configurationVersionId: first.id })
      const client = new Client({ name: 'claude-setup-reader', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => reader.token } }))
      expect((await client.callTool({ name: 'operator_mcp_setup_get', arguments: {} })).structuredContent).toMatchObject({ status: 'configured', configurationVersionId: first.id })
      const readback = ManagedAgentDefaultsSchema.parse((await client.callTool({ name: 'agent_defaults_get', arguments: {} })).structuredContent)
      expect(readback.value.operator.harnessProfileSelection).toEqual(selector)
      expect(readback.value.operator.harness).toMatchObject({ sandbox: 'danger-full-access' })
      const nextSelector = { ...selector, instanceId: randomUUID(), instanceRevision: '2' }
      const changed = await settings.updateAgentDefaults({ ...saved.value, operator: { ...saved.value.operator, harnessProfileSelection: nextSelector } }, saved.revision)
      const connection = await pool.connect()
      let second: typeof first
      try {
        await connection.query('begin')
        second = (await operators.updateWithClient(connection, first.harness, first.id, first.showThinking, undefined, nextSelector)).configuration
        await connection.query('commit')
      } catch (error) { await connection.query('rollback'); throw error } finally { connection.release() }
      expect(changed.value.operator.harnessProfileSelection).toEqual(nextSelector)
      const transitioned = await fetch(`${address}/api/operator/setup?harness=claude&expectedDefaultsRevision=${changed.revision}`, { headers: { Authorization: `Bearer ${reader.token}` } })
      expect(transitioned.status).toBe(200)
      expect(await transitioned.json()).toMatchObject({ configurationVersionId: second.id })
      expect(inspected).toEqual([
        { principalId: reader.principal.id, configurationId: first.id, profileId: selector.instanceId },
        { principalId: reader.principal.id, configurationId: first.id, profileId: selector.instanceId },
        { principalId: reader.principal.id, configurationId: second.id, profileId: nextSelector.instanceId },
      ])
      expect((await repository.configuration(first.id))?.harnessProfileSelection).toEqual(selector)
      const denied = await access.issue({ name: 'No installation grant', audience: 'operator', grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const deniedResponse = await fetch(`${address}/api/operator/setup?harness=claude`, { headers: { Authorization: `Bearer ${denied.token}` } })
      expect(deniedResponse.status).toBe(403)
      const deniedClient = new Client({ name: 'claude-setup-denied', version: '1' }); clients.push(deniedClient)
      await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => denied.token } }))
      expect((await deniedClient.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_mcp_setup_get')
      await expect(deniedClient.callTool({ name: 'operator_mcp_setup_get', arguments: {} })).rejects.toThrow('not found')
      await expect(client.callTool({ name: 'operator_chat_create', arguments: {} })).rejects.toThrow('not found')
      expect(managersCreated).toBe(0)
      expect((await pool.query('select id from operator_conversations')).rowCount).toBe(0)
      expect((await pool.query('select request_id from operator_conversation_turns')).rowCount).toBe(0)
      expect((await pool.query('select principal_id from operator_chat_credentials')).rowCount).toBe(0)
    } finally { for (const client of clients) await client.close(); await app.close() }
  })

  it.each(['scope', 'missing grant', 'parent grant', 'parent write', 'revoked parent', 'expired parent', 'expired delegate', 'revoked delegate', 'dead turn'] as const)(
    'inspects an active chat-derived MCP setup without Run/root authority and denies %s', async (denial) => {
      const parent = await access.issue({ name: 'Read-only native delegation owner', audience: 'operator', grants: [{
        actions: ['operator_chat:read', 'operator_chat:write', 'harnesses:read', 'settings:read'], scope: {},
      }], expiresAt: new Date(Date.now() + 120_000) })
      const settings = new PostgresFoundationSettingsRepository(pool)
      const commands = new PostgresCommandCoordinator(pool)
      const inspected: string[] = []
      let endpoint = ''
      let token: string | undefined
      const makeAuthority = () => new PostgresOperatorChatAuthority(pool, access, new NativeRollout({ NODE_ENV: 'test', HOST: '127.0.0.1' }),
        '/tmp/graphql-test-operator', endpoint, () => ({ inspect: async (request) => ({ harness: request.harness,
          providerVersion: 'synthetic-codex-cli', runnerId: request.runnerId, workingDirectory: request.workingDirectory, inspectedAt: new Date().toISOString(),
          entry: { name: 'graphql', enabled: true, transport: 'stdio', automaticEndpoint: true,
            credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', status: 'connected' } }) }), async () => {},
        async (principal, configuration) => {
          inspected.push(principal.id)
          return { harness: 'claude', status: 'configured', endpoint: configuration.harness.harness === 'claude' ? configuration.harness.mcpServers.graphql!.url : '', checkedAt: new Date().toISOString() }
        })
      let nativeAuthority: PostgresOperatorChatAuthority
      const bound: OperatorChatAuthority = { current: (id) => nativeAuthority.current(id),
        assertConfiguration: (value) => nativeAuthority.assertConfiguration(value),
        setup: (...input) => nativeAuthority.setup(...input), setupConfiguration: (...input) => nativeAuthority.setupConfiguration(...input),
        prepare: async (...input) => { const environment = await nativeAuthority.prepare(...input); token = environment.variables.GRAPHQL_MCP_TOKEN; return environment },
        release: (id) => nativeAuthority.release(id) }
      manager.autoFinish = false
      chat = new OperatorChatService(repository, operators, () => manager, '/tmp/graphql-test-operator', bound)
      const service = new FoundationSettingsManagementService(settings, commands, undefined, operators)
      const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { settings: service, operatorChat: chat, commands } as unknown as OperatorServices } })
      const client = new Client({ name: 'actual-chat-delegate', version: '1' })
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 }); endpoint = `${address}/mcp`
        nativeAuthority = makeAuthority()
        const conversation = await chat.create(parent.principal)
        await chat.send(conversation.id, { requestId: 'active-delegate-turn', content: 'Synthetic native admission fixture' }, parent.principal)
        await waitFor(async () => (await repository.active(conversation.id))?.active_phase === 'submitted')
        expect(token).toBeTruthy()
        const delegate = await access.authenticate(token)
        expect(delegate.id).not.toBe(parent.principal.id)
        await expect(access.currentOperator(delegate.id)).rejects.toMatchObject({ code: 'AUTH_INVALID' })
        const readAuthority = await access.currentHarnessInspectionPrincipal(delegate.id)
        expect(readAuthority.id).toBe(delegate.id)
        expect(readAuthority.grants.flatMap((grant) => grant.actions)).not.toContain('operator_chat:write')
        expect(readAuthority.grants.flatMap((grant) => grant.actions)).not.toContain('settings:update')
        const first = (await operators.ensure()).configuration
        const mainId = '11111111-1111-4111-8111-111111111111'
        const selector = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
          applicationInstallationId: mainId, harnessInstallationId: 'synthetic-installed-claude', installationFingerprint: 'synthetic-native-payload' } }
        const harness = { harness: 'claude' as const, model: 'synthetic-claude', authMode: 'subscription' as const, configDirectory: '/synthetic/profile',
          permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '',
          mcpServers: { graphql: { type: 'http' as const, url: endpoint } } }
        await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness, harnessProfileSelection: selector } }, 0)
        const connection = await pool.connect()
        try { await connection.query('begin'); await operators.updateWithClient(connection, harness, first.id, false, undefined, selector); await connection.query('commit') }
        catch (error) { await connection.query('rollback'); throw error } finally { connection.release() }
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token! } }))
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('operator_mcp_setup_get')
        expect((await client.callTool({ name: 'operator_mcp_setup_get', arguments: {} })).isError).not.toBe(true)
        expect(inspected).toEqual([delegate.id])
        expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_chat_create')
        if (denial === 'dead turn') {
          manager.finish(nativeCorrelation(conversation.id, 'active-delegate-turn'))
          await waitFor(async () => (await repository.active(conversation.id))?.active_request_id === null)
        } else if (denial === 'revoked parent') await access.revoke(parent.principal.id)
        else if (denial === 'revoked delegate') await access.revoke(delegate.id)
        else if (denial === 'expired parent' || denial === 'expired delegate') await pool.query('update management_principals set expires_at=$2 where id=$1',
          [denial === 'expired parent' ? parent.principal.id : delegate.id, new Date(Date.now() - 1000)])
        else {
          const parentChange = denial === 'parent grant' || denial === 'parent write'
          const actions = parentChange ? parent.principal.grants[0]!.actions.filter((action) => action !== (denial === 'parent write' ? 'operator_chat:write' : 'harnesses:read'))
            : denial === 'missing grant' ? ['settings:read'] : ['harnesses:read']
          await pool.query('update management_principals set grants=$2::jsonb where id=$1', [parentChange ? parent.principal.id : delegate.id,
            JSON.stringify([{ actions, scope: denial === 'scope' ? { workspaceIds: ['unrelated-workspace'] } : {} }])])
        }
        const result = await client.callTool({ name: 'operator_mcp_setup_get', arguments: {} }).then((value) => value, (error: unknown) => error)
        expect(result instanceof Error || typeof result === 'object' && result !== null && 'isError' in result && result.isError === true).toBe(true)
        expect(inspected).toEqual([delegate.id])
      } finally { await client.close().catch(() => {}); await app.close() }
    }, 30_000)

  it('checks the Operator MCP setup without creating an Operator or a conversation', async () => {
    expect(await chat.setup(owner)).toMatchObject({ harness: 'codex', status: 'configured' })
    expect((await pool.query('select id from application_operators')).rowCount).toBe(0)
    expect((await pool.query('select id from operator_conversations')).rowCount).toBe(0)
  })
  it('checks reviewed Claude defaults for an unaccepted harness change without replacing its source pin or admitting a turn', async () => {
    const source = await chat.create(owner)
    const sourcePin = source.operatorConfigurationVersionId!
    const settings = new PostgresFoundationSettingsRepository(pool)
    const mainId = '11111111-1111-4111-8111-111111111111'
    const selector = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
      applicationInstallationId: mainId, harnessInstallationId: 'synthetic-claude', installationFingerprint: 'synthetic-payload' } }
    const harness = { harness: 'claude' as const, model: 'synthetic-claude', authMode: 'subscription' as const, configDirectory: '/synthetic/profile',
      permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '',
      mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3050/mcp' } } }
    const saved = await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS,
      operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness, harnessProfileSelection: selector } }, 0)
    const connection = await pool.connect()
    let targetPin: string
    try {
      await connection.query('begin')
      targetPin = (await operators.updateWithClient(connection, harness, sourcePin, false, undefined, selector)).configuration.id
      await connection.query('commit')
    } catch (error) { await connection.query('rollback'); throw error } finally { connection.release() }
    let inspections = 0
    authority.setupConfiguration = async (_principal, configuration) => {
      inspections++
      expect(configuration.id).toBe(targetPin)
      expect(configuration.harnessProfileSelection).toEqual(selector)
      return { harness: 'claude', status: 'configured', endpoint: harness.mcpServers.graphql.url, checkedAt: new Date().toISOString() }
    }
    const pending = { conversationId: source.id, requestId: 'pending-unaccepted', configurationVersionId: sourcePin,
      harness: 'claude' as const, expectedDefaultsRevision: saved.revision }
    expect(await chat.setup(owner, pending)).toMatchObject({ status: 'configured', harness: 'claude', configurationVersionId: targetPin })
    expect((await repository.active(source.id))?.operator_configuration_version_id).toBe(sourcePin)
    expect(await repository.hasTurn(source.id, pending.requestId)).toBe(false)
    expect(manager.sessions).toBe(0)
    await expect(chat.setup(owner, { conversationId: source.id, requestId: pending.requestId,
      configurationVersionId: sourcePin, harness: 'claude' })).rejects.toMatchObject({ code: 'OPERATOR_CONFIGURATION_CONFLICT' })
    await expect(chat.setup(owner, { ...pending, configurationVersionId: targetPin, harness: 'opencode' })).rejects.toMatchObject({ code: 'OPERATOR_CONFIGURATION_CONFLICT' })
    await settings.updateAgentDefaults(saved.value, saved.revision)
    await expect(chat.setup(owner, pending)).rejects.toMatchObject({ code: 'OPERATOR_DEFAULTS_CHANGED' })
    expect(inspections).toBe(1)
  })

  it('checks an accepted harness-change receipt instead of newer defaults or its original source pin', async () => {
    const source = await chat.create(owner)
    const sourcePin = source.operatorConfigurationVersionId!
    const settings = new PostgresFoundationSettingsRepository(pool)
    const saved = await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS,
      operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: DEFAULT_HARNESS_DEFAULTS.opencode } }, 0)
    await operators.update(DEFAULT_HARNESS_DEFAULTS.opencode, (await operators.ensure()).configuration.id)
    const openCode = new ChatManager('opencode')
    chat = new OperatorChatService(repository, operators, (configuration) => configuration.harness.harness === 'opencode' ? openCode : manager,
      '/tmp/graphql-test-operator', authority)
    const request = { requestId: 'accepted-change', content: 'Synthetic receipt fixture', configurationVersionId: sourcePin,
      defaultsRevision: saved.revision, settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.opencode) }
    await chat.send(source.id, request, owner)
    await waitFor(async () => (await chat.get(source.id, owner)).turnState === 'idle')
    const accepted = await repository.acceptedConfiguration(source.id, request.requestId)
    expect(accepted?.harness.harness).toBe('opencode')
    await settings.updateAgentDefaults({ ...saved.value, operator: { ...saved.value.operator, harness: DEFAULT_HARNESS_DEFAULTS.codex } }, saved.revision)
    await operators.update(DEFAULT_HARNESS_DEFAULTS.codex, (await operators.ensure()).configuration.id)
    expect(await chat.setup(owner, { conversationId: source.id, requestId: request.requestId, configurationVersionId: sourcePin,
      harness: 'opencode', expectedDefaultsRevision: saved.revision })).toMatchObject({ harness: 'opencode', status: 'configured', configurationVersionId: accepted!.id })
    expect(await repository.acceptedConfiguration(source.id, request.requestId)).toEqual(accepted)
    expect(openCode.turns).toBe(1)
  })

  it('shares saved chat defaults with future sessions through authenticated MCP, preserving conflicts and denied callers', async () => {
    const settings = new PostgresFoundationSettingsRepository(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const service = new FoundationSettingsManagementService(settings, commands,
      { qualifyConfiguration: async () => ({} as never) }, operators)
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { settings: service, operatorChat: chat, commands } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(actions: ManagementPrincipal['grants'][number]['actions']) {
        const issued = await access.issue({ name: 'Settings parity', audience: 'operator', grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
        const client = new Client({ name: 'settings-parity', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => issued.token } }))
        return client
      }
      const client = await connect(['settings:read', 'settings:update', 'harnesses:read'])
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('operator_mcp_setup_get')
      const read = async () => ManagedAgentDefaultsSchema.parse((await client.callTool({ name: 'agent_defaults_get', arguments: {} })).structuredContent)
      const before = await read()
      expect(before.value.operator.harness).toMatchObject({ harness: 'codex', sandbox: 'danger-full-access' })
      expect(before.value.coder.harness).toMatchObject({ sandbox: 'read-only' })
      const input = { commandId: randomUUID(), expectedRevision: before.revision, value: { ...before.value,
        operator: { ...before.value.operator, showThinking: true,
          harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'gpt-5.4', reasoningEffort: 'high', sandbox: 'danger-full-access', serviceTier: 'priority' } } } }
      const accepted = AgentDefaultsUpdateResultSchema.parse((await client.callTool({ name: 'agent_defaults_update', arguments: input })).structuredContent)
      expect(accepted.replayed).toBe(false)
      expect((await read()).value.operator).toEqual(accepted.value.value.operator)
      expect((await read()).value.operator.harness).toMatchObject({ sandbox: 'danger-full-access' })
      const conversation = await chat.create(owner)
      expect((await chat.get(conversation.id, owner)).settings).toEqual({ harness: 'codex', model: 'gpt-5.4', reasoningEffort: 'high', serviceTier: 'priority', showThinking: true })
      expect(AgentDefaultsUpdateResultSchema.parse((await client.callTool({ name: 'agent_defaults_update', arguments: input })).structuredContent).replayed).toBe(true)
      expect((await client.callTool({ name: 'agent_defaults_update', arguments: { ...input, commandId: randomUUID() } })).isError).toBe(true)
      expect((await client.callTool({ name: 'operator_mcp_setup_get', arguments: {} })).structuredContent).toMatchObject({ status: 'configured', harness: 'codex' })
      const denied = await connect(['settings:read'])
      expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_mcp_setup_get')
      await expect(denied.callTool({ name: 'operator_mcp_setup_get', arguments: {} })).rejects.toThrow('not found')
      await expect(denied.callTool({ name: 'agent_defaults_update', arguments: { ...input, commandId: randomUUID() } })).rejects.toThrow('not found')
      expect((await read()).revision).toBe(accepted.value.revision)
    } finally { for (const client of clients) await client.close(); await app.close() }
  })

  it('blocks an existing native session when its Operator MCP installation is removed', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'before-removal', content: 'Hello' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const turns = manager.turns
    authority.setup = async () => ({ harness: 'codex', status: 'setup_required', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() })
    authority.prepare = async () => { throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Install and enable Operator MCP first.', 409) }
    await chat.send(conversation.id, { requestId: 'after-removal', content: 'Continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'error')
    expect(manager.turns).toBe(turns)
    expect((await chat.get(conversation.id, owner)).error).toContain('Install and enable')
  })
  it('keeps sidebar order tied to messages, not background status reconciliation', async () => {
    const first = await chat.create(owner)
    const second = await chat.create(owner)
    await repository.beginTurn(first.id, { requestId: 'order-first', content: 'First topic' }, owner.id)
    await repository.beginTurn(second.id, { requestId: 'order-second', content: 'Second topic' }, owner.id)
    await repository.pending(first.id, 'order-first')
    expect((await chat.summaries(owner)).map((entry) => entry.conversationId)).toEqual([second.id, first.id])
    expect((await chat.summaries(owner, 1)).map((entry) => entry.conversationId)).toEqual([second.id])
    expect(await chat.summaries(owner, undefined, true)).toEqual([])
  })

  it('persists activity monotonically, fences late events, and pages exact bigint identities', async () => {
    const conversation = await chat.create(owner)
    manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'activity-request', content: 'Read the fixture' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    await pool.query("select setval(pg_get_serial_sequence('operator_conversation_activity','sequence'),$1::bigint,false)", ['9007199254740993'])
    const started = { id: 'native-read', requestId: 'activity-request', kind: 'file_read' as const, title: 'Read fixture', status: 'running' as const, input: 'fixture.txt' }
    const first = await repository.activity.append(conversation.id, 'activity-request', started)
    expect(first?.activity.sequence).toBe('9007199254740993')
    const completed = { ...started, status: 'completed' as const, output: 'Read result' }
    await repository.activity.append(conversation.id, 'activity-request', completed)
    expect(await repository.activity.append(conversation.id, 'activity-request', started)).toBeUndefined()
    expect(await repository.activity.append(conversation.id, 'activity-request', completed)).toBeUndefined()
    const second = await repository.activity.append(conversation.id, 'activity-request', { ...started, id: 'native-command', kind: 'tool' })
    const page = await chat.activityPage(conversation.id, owner, { limit: 1 })
    expect(page.nextCursor).toBe(second?.activity.sequence)
    const older = await chat.activityPage(conversation.id, owner, { limit: 1, before: page.nextCursor! })
    expect(older.activities[0]).toMatchObject({ sequence: '9007199254740993', status: 'completed', output: 'Read result' })
    expect(older.nextCursor).toBeNull()
    manager.finish(nativeCorrelation(conversation.id, 'activity-request'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const final = await chat.get(conversation.id, owner)
    expect(final.messages[0]?.requestId).toBe('activity-request')
    expect(final.activities?.find((entry) => entry.id === 'native-command')?.status).toBe('unknown')
    expect(await repository.activity.append(conversation.id, 'activity-request', completed)).toBeUndefined()
    const other = (await access.issue({ name: 'activity other owner', audience: 'operator', grants: owner.grants, expiresAt: new Date(Date.now() + 600_000) })).principal
    await expect(chat.activityPage(conversation.id, other, {})).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
  })

  it('lists chats only after the first message and supports owner-scoped deletion and Undo', async () => {
    const conversation = await chat.create(owner)
    expect(await chat.summaries(owner)).toEqual([])
    await chat.send(conversation.id, { requestId: 'visible-message', content: 'A named topic' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    expect(await chat.summaries(owner)).toEqual([expect.objectContaining({ conversationId: conversation.id, title: 'A named topic' })])
    const other = (await access.issue({ name: 'other', audience: 'operator', grants: owner.grants, expiresAt: new Date(Date.now() + 600_000) })).principal
    await expect(chat.setDeleted(conversation.id, other, true)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await chat.setDeleted(conversation.id, owner, true)
    expect(await chat.summaries(owner)).toEqual([])
    await expect(chat.get(conversation.id, owner)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await expect(chat.send(conversation.id, { requestId: 'deleted', content: 'No' }, owner)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await chat.setDeleted(conversation.id, owner, true)
    await chat.setDeleted(conversation.id, owner, false)
    expect((await chat.get(conversation.id, owner)).messages).toHaveLength(2)
    expect(await chat.summaries(owner)).toHaveLength(1)
  })

  it('requires an active response to stop before a chat can be deleted', async () => {
    const conversation = await chat.create(owner)
    manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'delete-busy', content: 'Running' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    await expect(chat.setDeleted(conversation.id, owner, true)).rejects.toMatchObject({ code: 'CONVERSATION_TURN_ACTIVE' })
    expect((await repository.active(conversation.id))?.deleted_at).toBeNull()
    manager.finish(nativeCorrelation(conversation.id, 'delete-busy'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  })

  it('accepts next-message settings atomically, resumes the same harness, and binds retries to those settings', async () => {
    const conversation = await chat.create(owner)
    const first = { requestId: 'settings-first', content: 'First message', settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex) }
    await chat.send(conversation.id, first, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const before = await repository.active(conversation.id)
    const originalHarness = (await repository.configuration(before!.operator_configuration_version_id))!.harness
    const settings = { ...first.settings, harness: 'codex' as const, model: 'gpt-5.4', reasoningEffort: 'high' as const, serviceTier: 'priority' as const, showThinking: true }
    const next = { requestId: 'settings-second', content: 'Second message', settings }
    await chat.send(conversation.id, next, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const state = await chat.get(conversation.id, owner)
    expect(state.settings).toEqual(settings)
    const after = await repository.active(conversation.id)
    expect(after?.native_session_id).toBe(before?.native_session_id)
    expect(after?.operator_configuration_version_id).not.toBe(before?.operator_configuration_version_id)
    expect(manager.attachments).toBeGreaterThan(0)
    const configured = await repository.configuration(after!.operator_configuration_version_id)
    expect(configured?.harness).toMatchObject({ ...originalHarness, model: 'gpt-5.4', reasoningEffort: 'high', serviceTier: 'priority' })
    expect((await chat.send(conversation.id, next, owner)).replayed).toBe(true)
    await expect(chat.send(conversation.id, { ...next, settings: { ...settings, reasoningEffort: 'low' } }, owner)).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })

  it('does not change settings or interrupt a running turn', async () => {
    const conversation = await chat.create(owner)
    manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'busy', content: 'Work' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    const before = await repository.active(conversation.id)
    await expect(chat.send(conversation.id, { requestId: 'blocked-settings', content: 'Next',
      settings: { ...operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex), model: 'other-model' } }, owner)).rejects.toMatchObject({ code: 'CONVERSATION_TURN_ACTIVE' })
    expect((await repository.active(conversation.id))?.operator_configuration_version_id).toBe(before?.operator_configuration_version_id)
    expect(manager.disposals).toBe(0)
    manager.finish(nativeCorrelation(conversation.id, 'busy'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  })

  it('pins existing conversations while defaults advance the shared Operator configuration', async () => {
    const before = await chat.create(owner, 'Before defaults change')
    const settings = new PostgresFoundationSettingsRepository(pool)
    const service = new FoundationSettingsManagementService(
      settings,
      new PostgresCommandCoordinator(pool),
      { qualifyConfiguration: async () => ({} as never) },
      operators,
    )
    const current = await settings.getAgentDefaults()
    await service.updateAgentDefaults(owner, 'http', {
      commandId: 'change-operator-harness', expectedRevision: current.revision,
      value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: DEFAULT_HARNESS_DEFAULTS.opencode } },
    })
    const after = await chat.create(owner, 'After defaults change')
    expect(after.operatorConfigurationVersionId).not.toBe(before.operatorConfigurationVersionId)
    expect((await repository.configuration(before.operatorConfigurationVersionId!))?.harness.harness).toBe('codex')
    expect((await repository.configuration(after.operatorConfigurationVersionId!))?.harness.harness).toBe('opencode')
  })

  it('keeps empty history native-free; replay and later sends reuse one durable session with a one-slot pool', async () => {
    const conversation = await chat.create(owner)
    expect(manager.sessions).toBe(0)
    const input = { requestId: 'request-one', content: 'hello' }
    expect((await chat.send(conversation.id, input, owner)).replayed).toBe(false)
    expect((await chat.send(conversation.id, input, owner)).replayed).toBe(true)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    await chat.send(conversation.id, { requestId: 'request-two', content: 'continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).messages.length === 4)
    expect(manager.sessions).toBe(1); expect(manager.attachments).toBe(1); expect(manager.turns).toBe(2)
    expect(manager.closes).toBe(0)
    expect(manager.disposals).toBe(2) // Disposal owns session closure and avoids racing the lifecycle lock.
    const state = await chat.get(conversation.id, owner)
    expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(new Set(state.messages.map((message) => message.id)).size).toBe(4)
    expect(state.conversation.title).toBe('hello')
    expect(Date.parse(state.conversation.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(conversation.createdAt!))
  })

  it('rejects changed payload reuse rather than silently replaying old content', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'same-key', content: 'original', context: { route: '/a' } }, owner)
    await expect(chat.send(conversation.id, { requestId: 'same-key', content: 'changed', context: { route: '/a' } }, owner))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    await expect(chat.send(conversation.id, { requestId: 'same-key', content: 'original', context: { route: '/b' } }, owner))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })

  it('keeps cancel(false) fenced and makes a failed cancel retryable; a stale cancel cannot clear a new request', async () => {
    manager.autoFinish = false; manager.cancelAcknowledged = false
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'slow-turn', content: 'wait' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    await chat.cancel(conversation.id, 'slow-turn', owner)
    expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('slow-turn')
    const cancellationReceipt = async () => (await pool.query(`select command_id,target_key,input_hash,result from management_command_receipts
      where principal_id=$1 and operation='operator_chat_control' and target_key=$2 order by command_id`, [owner.id, conversation.id])).rows
    const originalCancellation = await cancellationReceipt()
    expect(originalCancellation).toHaveLength(1)
    await expect(chat.send(conversation.id, { requestId: 'next-turn', content: 'continue' }, owner)).rejects.toMatchObject({ code: 'CONVERSATION_TURN_ACTIVE' })
    manager.cancelAcknowledged = true
    await chat.cancel(conversation.id, 'slow-turn', owner)
    expect(await cancellationReceipt()).toEqual(originalCancellation)
    // This bare service fixture has no lifecycle worker. Replaying the original
    // control must not resend; drive its real persisted recovery until native
    // terminal history settles the still-fenced cancellation.
    await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
    await chat.send(conversation.id, { requestId: 'next-turn', content: 'continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    await chat.cancel(conversation.id, 'slow-turn', owner)
    expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('next-turn')
    await chat.cancel(conversation.id, 'next-turn', owner)
    expect(manager.sessions).toBe(1)
  })

  it('surfaces missing persisted native sessions without replacement and preserves known terminal errors', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'first', content: 'hello' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    manager.failAttach = true
    await chat.send(conversation.id, { requestId: 'missing', content: 'continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'error')
    expect((await chat.get(conversation.id, owner)).error).toContain('SESSION_UNAVAILABLE')
    expect(manager.sessions).toBe(1); expect(manager.turns).toBe(1)
    manager.failAttach = false; manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'missing', content: 'continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    manager.finish(nativeCorrelation(conversation.id, 'missing'), {
      outcome: 'failed', error: { code: 'QUOTA', message: 'quota exhausted', retryable: false },
    })
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'error')
    const state = await chat.get(conversation.id, owner)
    expect(state.error).toBe('quota exhausted')
    expect(state.activeRequestId).toBeNull()
    expect(state.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  })

  it('does not accept ephemeral Codex configuration or expose another principal’s history', async () => {
    const current = await operators.ensure()
    const harness = DEFAULT_HARNESS_DEFAULTS.codex
    await operators.update({ ...harness, advanced: { ...harness.advanced!, sessionPersistence: 'ephemeral' } }, current.operator.currentConfigurationVersionId)
    const conversation = await chat.create(owner)
    await expect(chat.send(conversation.id, { requestId: 'ephemeral', content: 'hello' }, owner)).rejects.toThrow()
    expect((await chat.get(conversation.id, owner)).messages).toHaveLength(0)
    const other = (await access.issue({ name: 'other', audience: 'operator', grants: owner.grants, expiresAt: new Date(owner.expiresAt) })).principal
    await expect(chat.get(conversation.id, other)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    expect(await chat.list(other)).toEqual([])
    const reader = { ...owner, grants: [{ actions: ['capabilities:read' as const], scope: {} }] }
    await expect(chat.send(conversation.id, { requestId: 'read-only', content: 'hello' }, reader)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })
})

/** Real Claude session manager over a synthetic SDK: the turn runs until interrupted. */
function interruptibleClaude() {
  const interrupts: string[] = []
  const sdk: ClaudeSdkClient = {
    sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'unused-fork' }),
    query(input) {
      const frames = new ClaudeBoundedQueue<unknown>(64)
      let active: string | undefined
      let initialized = false
      void (async () => {
        for await (const message of input.prompt) {
          if (!initialized) frames.offer({ type: 'system', subtype: 'init', session_id: 'claude-session', claude_code_version: '2.1.284', cwd: '/tmp/graphql-test-operator' })
          initialized = true
          active = message.uuid
          frames.offer({ type: 'assistant', uuid: `reply:${message.uuid}`, session_id: 'claude-session', parent_tool_use_id: null, user_message_uuid: message.uuid,
            message: { id: `msg:${message.uuid}`, content: [{ type: 'text', text: 'working' }] } })
        }
      })().catch(error => frames.close(error))
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(),
        initializationResult: async () => ({}), mcpServerStatus: async () => [], setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        interrupt: async () => {
          interrupts.push(active!)
          frames.offer({ type: 'result', uuid: `result:${active}`, session_id: 'claude-session', user_message_uuid: active,
            subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [] })
          return { still_queued: [] }
        } }
    },
  }
  // Like production, each Operator runtime gets its own manager; completion disposes it.
  const managers: ReturnType<typeof createClaudeNativeSessionManager>[] = []
  const manager = () => {
    const created = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
      scope: { deviceId: 'main', profilePath: '/synthetic/profile', configRevision: '1', cwd: '/tmp/graphql-test-operator' }, sdkOptions: {},
      qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: false, history: false } })
    managers.push(created)
    return created
  }
  return { manager, managers, interrupts }
}

function settlingClaude() {
  const prompts: string[] = []
  const managers: ReturnType<typeof createClaudeNativeSessionManager>[] = []
  const persistedMessages: unknown[] = []
  let frames: ClaudeBoundedQueue<unknown>
  let promptUuid: string
  let closed = 0
  let failClosure = false
  const sdk: ClaudeSdkClient = {
    sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => persistedMessages, forkSession: async () => ({ sessionId: 'unused-fork' }),
    query(input) {
      const output = new ClaudeBoundedQueue<unknown>(64)
      frames = output
      if (input.options.resume) output.offer({ type: 'system', subtype: 'init', session_id: 'settling-session',
        claude_code_version: '2.1.284', cwd: '/tmp/graphql-test-operator' })
      void (async () => {
        for await (const message of input.prompt) {
          prompts.push(message.message.content)
          promptUuid = message.uuid
          persistedMessages.push({ type: 'user', uuid: message.uuid, session_id: 'settling-session', parent_tool_use_id: null })
          output.offer({ type: 'system', subtype: 'init', session_id: 'settling-session',
            claude_code_version: '2.1.284', cwd: '/tmp/graphql-test-operator' })
          const reply = { type: 'assistant', uuid: `reply:${message.uuid}`, session_id: 'settling-session',
            parent_tool_use_id: null, user_message_uuid: message.uuid,
            message: { id: `answer:${message.uuid}`, content: [{ type: 'text', text: 'Text alone is not completion.' }] } }
          persistedMessages.push(reply)
          output.offer(reply)
        }
      })().catch(error => output.close(error))
      return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: () => output.close(),
        joinClosed: async () => {
          if (failClosure) throw new Error('Native closure unavailable')
          closed++
        },
        initializationResult: async () => ({}), mcpServerStatus: async () => [],
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }), interrupt: async () => undefined }
    },
  }
  const manager = () => {
    const created = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
      scope: { deviceId: 'main', profilePath: '/synthetic/profile', configRevision: '1', cwd: '/tmp/graphql-test-operator' },
      sdkOptions: {}, qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true,
        resume: true, fork: false, history: true } })
    managers.push(created)
    return created
  }
  return { manager, managers, prompts, closed: () => closed,
    failClosure: (value: boolean) => { failClosure = value },
    result: () => frames.offer({ type: 'result', uuid: `result:${promptUuid}`, session_id: 'settling-session',
      user_message_uuid: promptUuid, subtype: 'success', is_error: false, result: 'Saved native result.' }) }
}

async function configureSettlingClaude(claude: ReturnType<typeof settlingClaude>) {
  await operators.update({ harness: 'claude', model: 'synthetic-claude', authMode: 'subscription',
    configDirectory: '/synthetic/profile', permissionMode: 'default', sandbox: 'danger-full-access',
    tools: [], permissionRules: [], instructions: '',
    mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1:3050/mcp' } } },
  (await operators.ensure()).configuration.id)
  chat = new OperatorChatService(repository, operators, claude.manager, '/tmp/graphql-test-operator', authority)
}

async function startSettlingClaude(claude: ReturnType<typeof settlingClaude>) {
  await configureSettlingClaude(claude)
  const conversation = await chat.create(owner)
  await chat.send(conversation.id, { requestId: 'terminal-request', content: 'Run once.' }, owner)
  await waitFor(async () => Boolean(await repository.submittedMessageId(conversation.id, 'terminal-request')))
  return conversation
}

describe.skipIf(!connectionString)('Operator native terminal persistence', () => {
  it.each(['journalTerminal', 'closurePending', 'closureProven', 'finish'] as const)(
    'recovers a failed %s without replaying the native prompt', async method => {
      const claude = settlingClaude()
      const conversation = await startSettlingClaude(claude)
      const finish = repository.finish.bind(repository)
      const fault = vi.spyOn(repository, method).mockRejectedValue(new Error(`Failed ${method}`))
      try {
        claude.result()
        await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
        const terminal = await repository.terminal(conversation.id, 'terminal-request')
        expect(terminal?.closureState).toBe({ journalTerminal: undefined, closurePending: 'observed',
          closureProven: 'pending', finish: 'closed' }[method])
        expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
        expect(claude.closed()).toBe(['closureProven', 'finish'].includes(method) ? 1 : 0)
        if (terminal) {
          expect(terminal.observation.result).toEqual({ outcome: 'succeeded', output: 'Saved native result.' })
          await expect(finish(conversation.id, 'terminal-request', { outcome: 'canceled' }))
            .rejects.toMatchObject({ code: 'OPERATOR_CLOSURE_PENDING' })
        }
        fault.mockRestore()
        if (method === 'finish') {
          chat = new OperatorChatService(repository, operators, claude.manager, '/tmp/graphql-test-operator', authority)
        }
        await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
        expect((await chat.get(conversation.id, owner)).lastResult).toEqual({ outcome: 'succeeded', output: 'Saved native result.' })
        expect(claude.prompts).toEqual(['Run once.'])
        expect(claude.managers).toHaveLength(1)
        expect(claude.closed()).toBe(1)
      } finally { fault.mockRestore() }
    }, 30_000)

  it('keeps the terminal saved and the request fenced while native closure fails', async () => {
    const claude = settlingClaude()
    const conversation = await startSettlingClaude(claude)
    claude.failClosure(true)
    try {
      claude.result()
      await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
      expect((await repository.terminal(conversation.id, 'terminal-request'))?.closureState).toBe('pending')
      expect((await chat.get(conversation.id, owner)).lastResult).toBeUndefined()
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
      claude.failClosure(false)
      await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
      expect(claude.prompts).toEqual(['Run once.'])
      expect(claude.closed()).toBe(1)
    } finally { claude.failClosure(false) }
  })

  it.each(['closurePending', 'nativeClosure', 'closureProven'] as const)(
    'does not fabricate old-runtime closure after a restart at %s', async method => {
      const claude = settlingClaude()
      const conversation = await startSettlingClaude(claude)
      const fault = method === 'nativeClosure' ? undefined
        : vi.spyOn(repository, method).mockRejectedValue(new Error('Server stopped'))
      if (method === 'nativeClosure') claude.failClosure(true)
      const previous = chat
      try {
        claude.result()
        await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
        fault?.mockRestore()
        chat = new OperatorChatService(repository, operators, claude.manager, '/tmp/graphql-test-operator', authority)
        await chat.reconcileActive()
        const state = await chat.get(conversation.id, owner)
        expect(state.activeRequestId).toBe('terminal-request')
        expect(state.turnState).toBe('uncertain')
        expect(state.lastResult).toBeUndefined()
        expect((await repository.terminal(conversation.id, 'terminal-request'))?.observation.result.outcome).toBe('succeeded')
        expect(claude.prompts).toEqual(['Run once.'])
        expect(claude.managers).toHaveLength(1)
      } finally { fault?.mockRestore(); claude.failClosure(false); await previous.shutdown() }
    })

  it('does not reconstruct a terminal from assistant text after a crash before journaling', async () => {
    const claude = settlingClaude()
    const conversation = await startSettlingClaude(claude)
    const fault = vi.spyOn(repository, 'journalTerminal').mockRejectedValue(new Error('Server stopped before journal'))
    const previous = chat
    try {
      claude.result()
      await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
      fault.mockRestore()
      chat = new OperatorChatService(repository, operators, claude.manager, '/tmp/graphql-test-operator', authority)
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
      expect((await chat.get(conversation.id, owner)).lastResult).toBeUndefined()
      expect(await repository.terminal(conversation.id, 'terminal-request')).toBeUndefined()
      expect(claude.prompts).toEqual(['Run once.'])
    } finally { fault.mockRestore(); await previous.shutdown() }
  }, 30_000)

  it('recovers a saved native result only after the original process owner confirms closure', async () => {
    const claude = settlingClaude()
    const conversation = await startSettlingClaude(claude)
    const fault = vi.spyOn(repository, 'closureProven').mockRejectedValue(new Error('Closure write unavailable'))
    const previous = chat
    try {
      claude.result()
      await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
      expect(claude.closed()).toBe(1)
      fault.mockRestore()
      const resolver: NativeManagerResolver = claude.manager
      const closeOwner = vi.fn<NonNullable<NativeManagerResolver['closeRecoveredRuntime']>>(async () => false)
      resolver.closeRecoveredRuntime = closeOwner
      chat = new OperatorChatService(repository, operators, resolver, '/tmp/graphql-test-operator', authority)
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
      expect((await repository.terminal(conversation.id, 'terminal-request'))?.closureState).toBe('pending')
      closeOwner.mockImplementation(async id => id === conversation.id && claude.closed() === 1)
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).lastResult).toEqual({ outcome: 'succeeded', output: 'Saved native result.' })
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBeNull()
      expect(closeOwner).toHaveBeenCalledWith(conversation.id, expect.any(AbortSignal))
      expect(claude.managers).toHaveLength(1)
      expect(claude.prompts).toEqual(['Run once.'])
    } finally { fault.mockRestore(); await previous.shutdown() }
  })

  it('requires saved terminal and closure before native settlement through the repository', async () => {
    const claude = settlingClaude()
    const conversation = await startSettlingClaude(claude)
    await expect(repository.finish(conversation.id, 'terminal-request', { outcome: 'succeeded', output: 'Guess' }))
      .rejects.toMatchObject({ code: 'OPERATOR_CLOSURE_PENDING' })
    expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
    claude.result()
    await waitFor(async () => !(await chat.get(conversation.id, owner)).activeRequestId)
  })

  it('recovers final persistence through authenticated MCP without granting a reader write access', async () => {
    const claude = settlingClaude()
    await configureSettlingClaude(claude)
    const writer = await access.issue({ name: 'terminal writer', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 60_000) })
    const reader = await access.issue({ name: 'terminal reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { operatorChat: chat } as OperatorServices } })
    const clients: Client[] = []
    const fault = vi.spyOn(repository, 'finish').mockRejectedValue(new Error('Final persistence unavailable'))
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'terminal-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const allowed = await connect(writer.token)
      const denied = await connect(reader.token)
      const created = await allowed.callTool({ name: 'operator_chat_create', arguments: {} })
      expect(created.isError, JSON.stringify(created)).not.toBe(true)
      const conversationId = (created.structuredContent as { conversation: { id: string } }).conversation.id
      const input = { requestId: 'mcp-terminal-request', content: 'Run once.' }
      const send = { name: 'operator_chat_send', arguments: { conversationId, request: input } }
      expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('operator_chat_send')
      await expect(denied.callTool(send)).rejects.toThrow('not found')
      expect(claude.prompts).toHaveLength(0)
      expect((await allowed.callTool(send)).isError).not.toBe(true)
      await waitFor(async () => Boolean(await repository.submittedMessageId(conversationId, input.requestId)))
      claude.result()
      await waitFor(async () => (await repository.active(conversationId))?.turn_state === 'uncertain')
      const get = () => allowed.callTool({ name: 'operator_chat_get', arguments: { conversationId } })
      expect((await get()).structuredContent).toMatchObject({ activeRequestId: input.requestId, turnState: 'uncertain' })
      expect((await repository.terminal(conversationId, input.requestId))?.closureState).toBe('closed')
      expect((await allowed.callTool(send)).structuredContent).toMatchObject({ replayed: true })
      fault.mockRestore()
      await waitFor(async () => { await chat.reconcileActive(); return !(await repository.active(conversationId))?.active_request_id })
      expect((await get()).structuredContent).toMatchObject({ activeRequestId: null,
        lastResult: { outcome: 'succeeded', output: 'Saved native result.' } })
      const persisted = (await pool.query('select result from operator_conversation_turns where conversation_id=$1 and request_id=$2',
        [conversationId, input.requestId])).rows[0]?.result
      expect(persisted).toEqual({ outcome: 'succeeded', output: 'Saved native result.' })
      expect(claude.prompts).toEqual(['Run once.'])
      expect(claude.managers).toHaveLength(1)
    } finally {
      fault.mockRestore()
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
    }
  }, 30_000)
})

describe.skipIf(!connectionString)('Operator chat Stop on Claude', () => {
  it('interrupts the exact Claude message over HTTP service and MCP, settles canceled and accepts the next message', async () => {
    const claude = interruptibleClaude()
    const harness = { harness: 'claude' as const, model: 'synthetic-claude', authMode: 'subscription' as const, configDirectory: '/synthetic/profile',
      permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '',
      mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3050/mcp' } } }
    await operators.update(harness, (await operators.ensure()).configuration.id)
    chat = new OperatorChatService(repository, operators, claude.manager, '/tmp/graphql-test-operator', authority)
    const user = await access.issue({ name: 'Claude stop owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const owner = user.principal
    const conversation = await chat.create(owner)
    const active = async (requestId: string) => {
      await chat.send(conversation.id, { requestId, content: 'long task' }, owner)
      await waitFor(async () => Boolean(await repository.submittedMessageId(conversation.id, requestId)))
    }
    await active('claude-http-stop')
    const receipt = await repository.submittedMessageId(conversation.id, 'claude-http-stop')
    await chat.cancel(conversation.id, 'claude-http-stop', owner)
    expect(claude.interrupts).toEqual([receipt])
    await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
    expect((await pool.query(`select result from operator_conversation_turns where conversation_id=$1 and request_id=$2`,
      [conversation.id, 'claude-http-stop'])).rows[0]?.result).toEqual({ outcome: 'canceled' })

    await active('claude-mcp-stop')
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'claude-stop', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const reader = await access.issue({ name: 'Claude stop reader', audience: 'operator',
        grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const denied = await connect(reader.token)
      const refused = await denied.callTool({ name: 'operator_chat_cancel', arguments: { conversationId: conversation.id, request: { requestId: 'claude-mcp-stop' } } })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('ACCESS_DENIED')
      expect(claude.interrupts).toHaveLength(1)
      const ownerClient = await connect(user.token)
      const result = await ownerClient.callTool({ name: 'operator_chat_cancel', arguments: { conversationId: conversation.id, request: { requestId: 'claude-mcp-stop' } } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(claude.interrupts).toHaveLength(2)
      await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
      const read = await ownerClient.callTool({ name: 'operator_chat_get', arguments: { conversationId: conversation.id } })
      expect((read.structuredContent as OperatorConversationState).activeRequestId).toBeNull()
    } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close() }

    await chat.send(conversation.id, { requestId: 'claude-after-stop', content: 'next' }, owner)
    await waitFor(async () => Boolean(await repository.submittedMessageId(conversation.id, 'claude-after-stop')))
    await Promise.allSettled(claude.managers.map(manager => manager.dispose?.()))
  }, 60_000)
})
