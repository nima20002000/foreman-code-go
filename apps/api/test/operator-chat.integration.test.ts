import { randomUUID } from 'node:crypto'

import { NativeHarnessEventSchema, type NativeSessionReference } from '@graphql/contracts'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2603'

class ChatManager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  sessions = 0; turns = 0; cancels = 0; completed = false
  attachments = 0
  closes = 0; disposals = 0
  failAttach = false
  blockFirst = false
  private releaseFirst?: () => void
  capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> { throw new Error('not used') }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('not used') }
  async createSession(input: NativeSessionStart) { void input; this.sessions++; return { harness: this.harness, providerVersion: '0.154.0', nativeSessionId: `native-${this.sessions}` } }
  async attachSession(session: NativeSessionReference, input: NativeSessionStart) {
    void input; this.attachments++
    if (this.failAttach) throw new Error('CODEX_SESSION_UNAVAILABLE')
    return session
  }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput) {
    this.turns++
    if (this.blockFirst && this.turns === 1) await new Promise<void>((resolve) => { this.releaseFirst = resolve })
    if (this.cancels && this.turns === 1) return
    this.completed = true
    yield NativeHarnessEventSchema.parse({ sequence: this.turns, type: 'assistant.delta', occurredAt: new Date().toISOString(), payload: { text: `answer:${input.prompt.split('\n')[0]}` } })
  }
  async pending() { return undefined }
  async respond() {}
  async cancel() { this.cancels++; this.releaseFirst?.(); return true }
  async history(): Promise<NativeHistory> { return this.completed ? { events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded', output: { text: 'final answer' } } } : { events: [], pendingInteractions: [] } }
  reconcile(): Promise<NativeHistory> { return this.history() }
  async close() { this.closes++ }
  async dispose() { this.disposals++ }
}

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 40; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)) }
  throw new Error('condition was not reached')
}

describe('Operator chat persistence and native binding', () => {
  it('keeps empty conversations native-free and reuses exactly one session across replayed and later turns', async () => {
    const schema = `chat_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString }); await admin.query(`create schema "${schema}"`)
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    try {
      await applyApplicationMigrations(pool)
      const manager = new ChatManager()
      const service = new OperatorChatService(new PostgresOperatorConversationRepository(pool), new PostgresOperatorRepository(pool), () => manager, '/tmp/graphql-nim2603-operator')
      const conversation = await service.create()
      expect(manager.sessions).toBe(0)
      const first = await service.send(conversation.id, { requestId: 'request-one', content: 'hello' })
      expect(first.replayed).toBe(false)
      const replay = await service.send(conversation.id, { requestId: 'request-one', content: 'hello' })
      expect(replay.replayed).toBe(true)
      await waitFor(async () => (await service.get(conversation.id)).turnState === 'idle')
      expect(manager.sessions).toBe(1); expect(manager.turns).toBe(1)
      await service.send(conversation.id, { requestId: 'request-two', content: 'continue' })
      await waitFor(async () => (await service.get(conversation.id)).messages.length === 4)
      expect(manager.sessions).toBe(1); expect(manager.attachments).toBe(1); expect(manager.turns).toBe(2)
      const state = await service.get(conversation.id)
      expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(new Set(state.messages.map((message) => message.id)).size).toBe(4)
      await service.shutdown()
      expect(manager.closes).toBe(1)
      expect(manager.disposals).toBe(1)
    } finally { await pool.end(); await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end() }
  }, 30_000)

  it('cancels only the addressed turn and continues on the same native session', async () => {
    const schema = `chat_cancel_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString }); await admin.query(`create schema "${schema}"`)
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    try {
      await applyApplicationMigrations(pool)
      const manager = new ChatManager(); manager.blockFirst = true
      const service = new OperatorChatService(new PostgresOperatorConversationRepository(pool), new PostgresOperatorRepository(pool), () => manager, '/tmp/graphql-nim2603-operator')
      const conversation = await service.create()
      await service.send(conversation.id, { requestId: 'slow-turn', content: 'wait' })
      await waitFor(async () => (await service.get(conversation.id)).turnState === 'active')
      await service.cancel(conversation.id)
      expect((await service.get(conversation.id)).turnState).toBe('idle')
      await service.send(conversation.id, { requestId: 'next-turn', content: 'continue' })
      await waitFor(async () => (await service.get(conversation.id)).messages.length === 3)
      expect(manager.sessions).toBe(1); expect(manager.cancels).toBe(1); expect(manager.turns).toBe(2)
    } finally { await pool.end(); await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end() }
  }, 30_000)

  it('surfaces a missing persisted native session without creating a replacement', async () => {
    const schema = `chat_missing_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString }); await admin.query(`create schema "${schema}"`)
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    try {
      await applyApplicationMigrations(pool)
      const manager = new ChatManager()
      const service = new OperatorChatService(new PostgresOperatorConversationRepository(pool), new PostgresOperatorRepository(pool), () => manager, '/tmp/graphql-nim2603-operator')
      const conversation = await service.create()
      await service.send(conversation.id, { requestId: 'first', content: 'hello' })
      await waitFor(async () => (await service.get(conversation.id)).turnState === 'idle')
      manager.failAttach = true
      await service.send(conversation.id, { requestId: 'missing', content: 'continue' })
      await waitFor(async () => (await service.get(conversation.id)).turnState === 'error')
      const state = await service.get(conversation.id)
      expect(state.error).toContain('SESSION_UNAVAILABLE')
      expect(manager.sessions).toBe(1)
      expect(manager.turns).toBe(1)
    } finally { await pool.end(); await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end() }
  }, 30_000)
})
