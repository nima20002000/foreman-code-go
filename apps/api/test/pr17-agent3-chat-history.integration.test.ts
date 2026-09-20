import { randomUUID } from 'node:crypto'
import { OPENCODE_APPROVAL_OPTIONS_FIXTURE, type PendingNativeInteraction } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { operatorChatBootstrapFrame, OPERATOR_BOOTSTRAP_FRAME_BYTES } from '../src/modules/conversations/operatorChatBootstrap.js'
import { ReviewManager } from './fixtures/agent1OperatorChat.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
let schema: string, admin: pg.Pool, pool: pg.Pool
let owner: ManagementPrincipal, access: PostgresAccessService
let repository: PostgresOperatorConversationRepository, chat: OperatorChatService, manager: ReviewManager
beforeEach(async () => {
  schema = `agent3_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  access = new PostgresAccessService(pool)
  owner = (await access.issue({ name: 'history owner', audience: 'operator',
    grants: [{ scope: {}, actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond'] }],
    expiresAt: new Date(Date.now() + 600_000) })).principal
  repository = new PostgresOperatorConversationRepository(pool)
  manager = new ReviewManager()
  chat = new OperatorChatService(repository, new PostgresOperatorRepository(pool), () => manager, '/tmp/operator-history', {
    current: (id) => access.currentOperator(id), assertConfiguration() {},
    setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp/operator', checkedAt: new Date().toISOString() }),
    prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {},
  })
}, 30_000)
afterEach(async () => {
  await chat?.shutdown(); await pool?.end()
  if (schema) await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.end()
})

describe('PR17 Agent3 SQL history, terminal receipts, and owner recovery', () => {
  it('F7 terminal success without nativeMessageId clears the request exactly once without an assistant row', async () => {
    const c = await chat.create(owner)
    await repository.beginTurn(c.id, { requestId: 'no-message', content: 'Run without a final assistant row' }, owner.id)
    await repository.bind(c.id, 'no-message', manager.session.providerVersion, manager.session.nativeSessionId)
    await repository.submitted(c.id, 'no-message', 'turn')
    manager.nativeHistory = { correlationId: nativeCorrelation(c.id, 'no-message'), nativeTurnId: 'turn',
      events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded', output: { text: 'No provider message ID' } } }
    await chat.reconcileActive()
    const state = await chat.get(c.id, owner)
    expect(state.activeRequestId).toBeNull()
    expect(state.lastResult?.outcome).toBe('succeeded')
    expect(state.messages.map((message) => message.role)).toEqual(['user'])
    await chat.reconcileActive()
    expect((await chat.get(c.id, owner)).revision).toBe(state.revision)
    expect(await repository.finish(c.id, 'no-message', { outcome: 'succeeded' })).toBe(false)
    const rows = await pool.query('select result from operator_conversation_turns where conversation_id=$1', [c.id])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].result.outcome).toBe('succeeded')
    expect((await repository.beginTurn(c.id, { requestId: 'later', content: 'Explicit later request' }, owner.id)).replayed).toBe(false)
  })

  it('F7 a real message ID with no provider text also creates no fabricated message', async () => {
    const c = await chat.create(owner)
    await repository.beginTurn(c.id, { requestId: 'empty', content: 'Empty output' }, owner.id)
    expect(await repository.finish(c.id, 'empty', { outcome: 'succeeded', output: { text: '' } }, 'real-provider-id')).toBe(true)
    expect((await chat.get(c.id, owner)).messages.map((message) => message.role)).toEqual(['user'])
  })

  it('F12 recovers acceptance after response loss and enrollment without another submission; another owner cannot read or use it', async () => {
    const c = await chat.create(owner)
    const command = { requestId: randomUUID(), content: 'Accepted but the HTTP acknowledgement was lost', context: { route: '/workflows' } }
    await repository.beginTurn(c.id, command, owner.id) // Server accepted; no response reaches the browser.
    const enrolledOwner = await access.currentOperator(owner.id)
    const recovered = await chat.history(c.id, enrolledOwner)
    expect(recovered.entries[0]?.receipt).toMatchObject({ requestId: command.requestId, outcome: null, retryable: false })
    expect(recovered.activeRequestId).toBe(command.requestId)
    expect((await repository.beginTurn(c.id, command, enrolledOwner.id)).replayed).toBe(true)
    expect((await chat.history(c.id, enrolledOwner)).entries).toHaveLength(1)
    expect(manager.turns).toBe(0) // History/recovery did not start any native work.
    const other = (await access.issue({ name: 'other owner', audience: 'operator',
      grants: [{ scope: {}, actions: ['operator_chat:read', 'operator_chat:write'] }], expiresAt: new Date(Date.now() + 600_000) })).principal
    await expect(chat.history(c.id, other)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await expect(chat.send(c.id, command, other)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    // A completed acceptance is still recoverable after the active fence clears.
    await repository.finish(c.id, command.requestId, { outcome: 'succeeded' })
    expect((await chat.history(c.id, enrolledOwner)).entries[0]?.receipt).toMatchObject({ requestId: command.requestId, outcome: 'succeeded' })
  })

  it('F18 bootstraps and reconnects beyond 8 MiB while retaining pending/current state and every older message', async () => {
    const c = await chat.create(owner)
    await pool.query(`insert into operator_conversation_messages(id,conversation_id,role,content,record)
      select 'large-'||n,$1,'assistant',repeat('x',100000),
        jsonb_build_object('id','large-'||n,'conversationId',$1::text,'role','assistant','content',repeat('x',100000))
      from generate_series(1,100) n`, [c.id])
    await repository.beginTurn(c.id, { requestId: 'current', content: 'Current pending turn' }, owner.id)
    await repository.bind(c.id, 'current', manager.session.providerVersion, manager.session.nativeSessionId)
    await repository.submitted(c.id, 'current', 'current-native')
    const pending: PendingNativeInteraction = { session: manager.session,
      turn: { nativeTurnId: 'current-native', nativeRequestId: 'ask' },
      nativeRequestType: 'item/commandExecution/requestApproval', request: {}, responseOptions: [...OPENCODE_APPROVAL_OPTIONS_FIXTURE] }
    await repository.pending(c.id, 'current', pending)
    const total = await pool.query('select sum(octet_length(record::text))::bigint as bytes from operator_conversation_messages where conversation_id=$1', [c.id])
    expect(Number(total.rows[0].bytes)).toBeGreaterThan(8 * 1024 * 1024)
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const state = await chat.get(c.id, owner)
      const frame = operatorChatBootstrapFrame(state)
      expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(OPERATOR_BOOTSTRAP_FRAME_BYTES)
      expect(state.activeRequestId).toBe('current')
      expect(state.pendingInteraction?.turn.nativeRequestId).toBe('ask')
      expect(state.messages.length).toBeLessThan(101)
      expect(frame).toContain(`id: ${state.revision}`)
    }
    let before: string | undefined
    const ids: string[] = [], cursors = new Set<string>()
    do {
      const page = await chat.history(c.id, owner, before ? { before, limit: 20 } : { limit: 20 })
      expect(page.activeRequestId).toBe('current')
      ids.push(...page.entries.map((entry) => entry.message.id))
      before = page.nextCursor ?? undefined
      if (before) { expect(cursors.has(before)).toBe(false); cursors.add(before) }
    } while (before)
    expect(ids).toHaveLength(101)
    expect(new Set(ids).size).toBe(101)
    expect(ids).toContain('large-1')
  }, 30_000)

  it('F18 one oversized record remains retrievable and its cursor advances without an oversized SSE frame', async () => {
    const c = await chat.create(owner)
    await repository.beginTurn(c.id, { requestId: 'oversized', content: 'Get a large result' }, owner.id)
    await repository.finish(c.id, 'oversized', { outcome: 'succeeded', output: { text: 'z'.repeat(9 * 1024 * 1024) } }, 'large-native-message')
    const state = await chat.get(c.id, owner)
    const frame = operatorChatBootstrapFrame(state)
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(OPERATOR_BOOTSTRAP_FRAME_BYTES)
    expect(frame).toContain('event: state')
    expect(frame).toContain('"snapshotRequired":true')
    const page = await chat.history(c.id, owner)
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]?.message.content.length).toBe(9 * 1024 * 1024)
    expect(page.nextCursor).not.toBeNull()
    const older = await chat.history(c.id, owner, { before: page.nextCursor! })
    expect(older.entries[0]?.receipt?.requestId).toBe('oversized')
    expect(older.nextCursor).toBeNull()
  }, 30_000)

  it('F15 definite rejection receipts are explicitly retryable with the same request ID, never duplicated user messages', async () => {
    const c = await chat.create(owner), command = { requestId: 'rejected', content: 'Explicit retry' }
    await repository.beginTurn(c.id, command, owner.id)
    await repository.finish(c.id, command.requestId, { outcome: 'failed', error: { code: 'REJECTED', message: 'Not submitted', retryable: true } }, undefined, true)
    expect((await chat.history(c.id, owner)).entries[0]?.receipt?.retryable).toBe(true)
    expect((await repository.beginTurn(c.id, command, owner.id)).replayed).toBe(false)
    expect((await chat.history(c.id, owner)).entries).toHaveLength(1)
  })
})
