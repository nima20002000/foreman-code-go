import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagedAgentDefaultsSchema, AgentDefaultsUpdateResultSchema } from '@graphql/contracts/management'
import {
  operatorChatSettings, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, NativeHarnessEventSchema,
  type ExecutionResult, type NativeSessionReference,
} from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { OperatorChatService, PostgresOperatorConversationRepository, type OperatorChatAuthority } from '../src/modules/conversations/operatorChat.js'
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

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2603'

/** Only provider I/O is fake: these tests exercise real migrations, SQL, grants and service transitions. */
class ChatManager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  sessions = 0; turns = 0; attachments = 0; closes = 0; disposals = 0
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
    const correlation = input.clientCorrelationId
    const nativeTurnId = `turn-${this.turns}`
    this.active.set(session.nativeSessionId, correlation)
    this.histories.set(correlation, { correlationId: correlation, nativeTurnId, events: [], pendingInteractions: [] })
    await input.onSubmitted?.(nativeTurnId)
    yield NativeHarnessEventSchema.parse({ sequence: this.turns, type: 'assistant.delta', occurredAt: new Date().toISOString(), payload: { text: 'partial' } })
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
    setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp/operator', checkedAt: new Date().toISOString() }),
    prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {} }
  chat = new OperatorChatService(repository, operators, () => manager, '/tmp/graphql-test-operator', authority)
}, 30_000)

afterEach(async () => {
  await chat?.shutdown()
  await pool?.end()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.end()
})

describe('Operator chat persistence and native binding', () => {
  it('checks the Operator MCP setup without creating an Operator or a conversation', async () => {
    expect(await chat.setup(owner)).toMatchObject({ harness: 'codex', status: 'configured' })
    expect((await pool.query('select id from application_operators')).rowCount).toBe(0)
    expect((await pool.query('select id from operator_conversations')).rowCount).toBe(0)
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
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => issued.token } }))
        return client
      }
      const client = await connect(['settings:read', 'settings:update', 'harnesses:read'])
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('operator_mcp_setup_get')
      const read = async () => ManagedAgentDefaultsSchema.parse((await client.callTool({ name: 'agent_defaults_get', arguments: {} })).structuredContent)
      const before = await read()
      const input = { commandId: randomUUID(), expectedRevision: before.revision, value: { ...before.value,
        operator: { ...before.value.operator, showThinking: true,
          harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'gpt-5.4', reasoningEffort: 'high', serviceTier: 'priority' } } } }
      const accepted = AgentDefaultsUpdateResultSchema.parse((await client.callTool({ name: 'agent_defaults_update', arguments: input })).structuredContent)
      expect(accepted.replayed).toBe(false)
      expect((await read()).value.operator).toEqual(accepted.value.value.operator)
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
    authority.setup = async () => ({ harness: 'codex', status: 'setup_required', endpoint: 'http://127.0.0.1:3000/mcp/operator', checkedAt: new Date().toISOString() })
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
    expect(configured?.harness).toMatchObject({ model: 'gpt-5.4', reasoningEffort: 'high', serviceTier: 'priority', sandbox: DEFAULT_HARNESS_DEFAULTS.codex.sandbox })
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
    await expect(chat.send(conversation.id, { requestId: 'next-turn', content: 'continue' }, owner)).rejects.toMatchObject({ code: 'CONVERSATION_TURN_ACTIVE' })
    manager.cancelAcknowledged = true
    await chat.cancel(conversation.id, 'slow-turn', owner)
    await waitFor(async () => !(await chat.get(conversation.id, owner)).activeRequestId)
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
