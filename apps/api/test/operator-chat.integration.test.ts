import { randomUUID } from 'node:crypto'
import {
  DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, NativeHarnessEventSchema,
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
    grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'settings:update'], scope: {} }],
    expiresAt: new Date(Date.now() + 600_000) })).principal
  operators = new PostgresOperatorRepository(pool)
  repository = new PostgresOperatorConversationRepository(pool)
  manager = new ChatManager()
  authority = { current: (id) => access.currentOperator(id), assertConfiguration() {},
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
