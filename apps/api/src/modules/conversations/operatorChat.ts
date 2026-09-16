import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
  ConversationSchema,
  MessageSchema,
  OperatorConversationStateSchema,
  OperatorConversationStreamEventSchema,
  type Conversation,
  type OperatorConfigurationVersion,
  type OperatorConversationState,
  type OperatorConversationStreamEvent,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import type { PostgresOperatorRepository } from '../operators/postgres.js'
import { withFilesystemDeadline } from '../workspaces/filesystem.js'

type TurnState = OperatorConversationState['turnState']
type ConversationRow = {
  record: unknown; turn_state: TurnState; last_error: string | null; harness: 'codex' | 'opencode'
  provider_version: string | null; native_session_id: string | null; active_request_id: string | null
}

function finalText(history: NativeHistory): string | undefined {
  const output = history.terminalResult?.output
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const value = (output as Record<string, unknown>).text ?? (output as Record<string, unknown>).content
    if (typeof value === 'string') return value
  }
  for (const event of [...history.events].reverse()) {
    const value = event.payload.text ?? event.payload.content
    if (typeof value === 'string' && /assistant|message|completed/.test(event.type)) return value
  }
}

/** Dedicated native cwd for the application Operator. It is not a workspace or an authority scope. */
export async function ensureOperatorRuntimeDirectory(managedRuntimeRoot: string): Promise<string> {
  const root = resolve(managedRuntimeRoot)
  return withFilesystemDeadline(async (check) => {
    await check(() => mkdir(root, { recursive: true }))
    const canonicalRoot = await check(() => realpath(root))
    const candidate = resolve(canonicalRoot, 'operator')
    await check(() => mkdir(candidate, { recursive: true }))
    const canonical = await check(() => realpath(candidate))
    const child = relative(canonicalRoot, canonical)
    if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
      throw new DomainError('OPERATOR_RUNTIME_DIRECTORY_INVALID', 'The Operator runtime directory must remain inside managed runtime storage.', 422)
    }
    await check(() => access(canonical, constants.R_OK | constants.W_OK | constants.X_OK))
    return canonical
  })
}

export class OperatorConversationEvents {
  private sequence = 0
  private readonly listeners = new Map<string, Set<(event: OperatorConversationStreamEvent) => void>>()
  publish(conversationId: string, type: OperatorConversationStreamEvent['type'], data: Record<string, unknown>) {
    const event = OperatorConversationStreamEventSchema.parse({ id: this.sequence++, conversationId, type, data })
    for (const listener of this.listeners.get(conversationId) ?? []) listener(event)
  }
  subscribe(conversationId: string, listener: (event: OperatorConversationStreamEvent) => void) {
    const listeners = this.listeners.get(conversationId) ?? new Set()
    listeners.add(listener); this.listeners.set(conversationId, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(conversationId) }
  }
}

export class PostgresOperatorConversationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(operatorId: string, configuration: OperatorConfigurationVersion, title?: string): Promise<Conversation> {
    const now = new Date().toISOString()
    const conversation = ConversationSchema.parse({
      id: randomUUID(), agentId: operatorId, scope: 'application',
      operatorConfigurationVersionId: configuration.id, title: title ?? 'New conversation', status: 'open',
      createdAt: now, updatedAt: now,
    })
    await this.pool.query(
      `insert into operator_conversations
       (id, operator_id, operator_configuration_version_id, harness, record)
       values ($1,$2,$3,$4,$5::jsonb)`,
      [conversation.id, operatorId, configuration.id, configuration.harness.harness, JSON.stringify(conversation)],
    )
    return conversation
  }

  async list(): Promise<Conversation[]> {
    const rows = await this.pool.query<{ record: unknown }>(
      'select record from operator_conversations order by updated_at desc, id',
    )
    return rows.rows.map((row) => ConversationSchema.parse(row.record))
  }

  async get(conversationId: string): Promise<OperatorConversationState | undefined> {
    const row = await this.pool.query<ConversationRow>('select * from operator_conversations where id=$1', [conversationId])
    if (!row.rows[0]) return undefined
    const messages = await this.pool.query<{ record: unknown }>(
      'select record from operator_conversation_messages where conversation_id=$1 order by sequence', [conversationId],
    )
    return OperatorConversationStateSchema.parse({
      conversation: row.rows[0].record, messages: messages.rows.map((item) => MessageSchema.parse(item.record)),
      turnState: row.rows[0].turn_state, ...(row.rows[0].last_error ? { error: row.rows[0].last_error } : {}),
    })
  }

  async configuration(id: string): Promise<OperatorConfigurationVersion | undefined> {
    const row = await this.pool.query<{ record: OperatorConfigurationVersion }>('select record from operator_configuration_versions where id=$1', [id])
    return row.rows[0]?.record
  }

  async beginTurn(conversationId: string, requestId: string, content: string): Promise<{ replayed: boolean; state: OperatorConversationState; row: ConversationRow }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const selected = await client.query<ConversationRow>('select * from operator_conversations where id=$1 for update', [conversationId])
      const row = selected.rows[0]
      if (!row) throw new DomainError('CONVERSATION_NOT_FOUND', `Conversation '${conversationId}' was not found.`, 404)
      const prior = await client.query('select 1 from operator_conversation_messages where conversation_id=$1 and client_request_id=$2', [conversationId, requestId])
      if (prior.rowCount) {
        await client.query('commit')
        const state = await this.get(conversationId)
        if (!state) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation disappeared.', 404)
        return { replayed: true, state, row }
      }
      if (row.turn_state !== 'idle' && row.turn_state !== 'error') {
        throw new DomainError('CONVERSATION_TURN_ACTIVE', 'This conversation already has an active or uncertain turn.', 409)
      }
      const createdAt = new Date().toISOString()
      const message = MessageSchema.parse({ id: randomUUID(), conversationId, role: 'user', content, createdAt, updatedAt: createdAt })
      await client.query(
        `insert into operator_conversation_messages (id,conversation_id,role,content,client_request_id,record)
         values ($1,$2,'user',$3,$4,$5::jsonb)`, [message.id, conversationId, content, requestId, JSON.stringify(message)],
      )
      await client.query("update operator_conversations set active_request_id=$2, turn_state='starting', last_error=null, updated_at=now() where id=$1", [conversationId, requestId])
      await client.query('commit')
      const state = await this.get(conversationId)
      if (!state) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation disappeared.', 404)
      return { replayed: false, state, row: { ...row, active_request_id: requestId, turn_state: 'starting' } }
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }

  async bind(conversationId: string, requestId: string, providerVersion: string, nativeSessionId: string) {
    const result = await this.pool.query(
      `update operator_conversations set provider_version=$3,native_session_id=$4,turn_state='active',updated_at=now()
       where id=$1 and active_request_id=$2 and native_session_id is null returning id`,
      [conversationId, requestId, providerVersion, nativeSessionId],
    )
    if (!result.rowCount) throw new DomainError('NATIVE_SESSION_BINDING_UNCERTAIN', 'The native session binding could not be confirmed.', 409)
  }
  async active(conversationId: string) { return (await this.pool.query<ConversationRow>('select * from operator_conversations where id=$1', [conversationId])).rows[0] }
  async unfinished() {
    return (await this.pool.query<ConversationRow & { id: string }>(
      "select * from operator_conversations where turn_state in ('starting','active','canceling','uncertain') order by updated_at",
    )).rows
  }
  async setState(conversationId: string, state: TurnState, error?: string) {
    await this.pool.query('update operator_conversations set turn_state=$2,last_error=$3,updated_at=now() where id=$1', [conversationId, state, error ?? null])
  }
  async failIfActive(conversationId: string, requestId: string, state: 'uncertain' | 'error', error: string) {
    await this.pool.query(
      'update operator_conversations set turn_state=$3,last_error=$4,updated_at=now() where id=$1 and active_request_id=$2',
      [conversationId, requestId, state, error],
    )
  }
  async clearActive(conversationId: string) {
    await this.pool.query("update operator_conversations set active_request_id=null,active_native_turn_id=null,turn_state='idle',last_error=null,updated_at=now() where id=$1", [conversationId])
  }
  async finish(conversationId: string, requestId: string, content: string, nativeMessageId = requestId) {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const active = await client.query<{ active_request_id: string | null }>('select active_request_id from operator_conversations where id=$1 for update', [conversationId])
      if (active.rows[0]?.active_request_id !== requestId) { await client.query('commit'); return false }
      const createdAt = new Date().toISOString()
      const message = MessageSchema.parse({ id: randomUUID(), conversationId, role: 'assistant', content, createdAt, updatedAt: createdAt })
      await client.query(
        `insert into operator_conversation_messages (id,conversation_id,role,content,native_message_id,record)
         values ($1,$2,'assistant',$3,$4,$5::jsonb) on conflict (conversation_id,native_message_id) where native_message_id is not null do nothing`,
        [message.id, conversationId, content, nativeMessageId, JSON.stringify(message)],
      )
      await client.query("update operator_conversations set active_request_id=null,active_native_turn_id=null,turn_state='idle',last_error=null,updated_at=now() where id=$1 and active_request_id=$2", [conversationId, requestId])
      await client.query('commit')
      return true
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
}

export type NativeManagerResolver = (harness: 'codex' | 'opencode') => NativeHarnessSessionManager

export class OperatorChatService {
  constructor(
    private readonly repository: PostgresOperatorConversationRepository,
    private readonly operators: PostgresOperatorRepository,
    private readonly managers: NativeManagerResolver,
    private readonly workingDirectory: string,
    readonly events = new OperatorConversationEvents(),
  ) {}
  async create(title?: string) { const { operator, configuration } = await this.operators.ensure(); return this.repository.create(operator.id, configuration, title) }
  list() { return this.repository.list() }
  async get(id: string) { const state = await this.repository.get(id); if (!state) throw new DomainError('CONVERSATION_NOT_FOUND', `Conversation '${id}' was not found.`, 404); return state }
  async send(id: string, input: { requestId: string; content: string; context?: Record<string, string | undefined> }) {
    const begun = await this.repository.beginTurn(id, input.requestId, input.content)
    if (begun.replayed) return { state: begun.state, replayed: true }
    const configurationId = begun.state.conversation.operatorConfigurationVersionId
    const configuration = configurationId ? await this.repository.configuration(configurationId) : undefined
    if (!configuration) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The pinned Operator configuration was not found.', 409)
    void this.runTurn(id, input.requestId, input.content, input.context, configuration).catch(() => {})
    return { state: begun.state, replayed: false }
  }
  private async runTurn(id: string, requestId: string, content: string, context: Record<string, string | undefined> | undefined, configuration: OperatorConfigurationVersion) {
    const manager = this.managers(configuration.harness.harness)
    try {
      const row = await this.repository.active(id)
      if (!row) return
      let session = row.native_session_id ? { harness: row.harness, providerVersion: row.provider_version ?? 'unknown', nativeSessionId: row.native_session_id } : undefined
      const start = { kind: 'operator' as const, correlationId: requestId, configuration, workingDirectory: this.workingDirectory }
      if (!session) {
        session = await manager.createSession(start)
        await this.repository.bind(id, requestId, session.providerVersion, session.nativeSessionId)
      } else {
        try {
          session = await manager.attachSession(session, start)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The native session is unavailable.'
          await this.repository.failIfActive(id, requestId, 'error', message)
          this.events.publish(id, 'error', { message, turnState: 'error' })
          return
        }
      }
      this.events.publish(id, 'state', { turnState: 'active' })
      const hint = context && Object.values(context).some(Boolean) ? `\n\n[Non-authoritative route context: ${JSON.stringify(context)}]` : ''
      for await (const event of manager.startTurn(session, { prompt: `${content}${hint}`, clientCorrelationId: requestId })) {
        const text = event.payload.text ?? event.payload.content
        if (typeof text === 'string') this.events.publish(id, 'delta', { text })
      }
      const history = await manager.reconcile(session, requestId)
      const text = finalText(history)
      if (!text) throw new Error('Native turn completed without a final assistant message.')
      if (!await this.repository.finish(id, requestId, text)) return
      this.events.publish(id, 'message', { content: text, requestId })
      this.events.publish(id, 'state', { turnState: 'idle' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Native turn failed.'
      await this.repository.failIfActive(id, requestId, 'uncertain', message)
      this.events.publish(id, 'error', { message, turnState: 'uncertain' })
    }
  }
  async cancel(id: string) {
    const row = await this.repository.active(id)
    if (!row) throw new DomainError('CONVERSATION_NOT_FOUND', `Conversation '${id}' was not found.`, 404)
    if (!row.native_session_id || !['starting','active','uncertain'].includes(row.turn_state)) throw new DomainError('CONVERSATION_NOT_CANCELABLE', 'The conversation has no cancelable turn.', 409)
    await this.repository.setState(id, 'canceling')
    await this.managers(row.harness).cancel({ harness: row.harness, providerVersion: row.provider_version ?? 'unknown', nativeSessionId: row.native_session_id })
    await this.repository.clearActive(id)
    this.events.publish(id, 'state', { turnState: 'idle', canceled: true })
    return this.get(id)
  }
  async reconcileActive() {
    for (const row of await this.repository.unfinished()) {
      if (!row.native_session_id || !row.active_request_id) {
        await this.repository.setState(row.id, 'uncertain', 'The native session binding is uncertain; a new session will not be created automatically.')
        continue
      }
      try {
        const conversation = ConversationSchema.parse(row.record)
        const configurationId = conversation.operatorConfigurationVersionId
        const configuration = configurationId ? await this.repository.configuration(configurationId) : undefined
        if (!configuration) throw new Error('The pinned Operator configuration was not found.')
        const manager = this.managers(row.harness)
        const session = await manager.attachSession({
          harness: row.harness, providerVersion: row.provider_version ?? 'unknown', nativeSessionId: row.native_session_id,
        }, { kind: 'operator', correlationId: row.active_request_id, configuration, workingDirectory: this.workingDirectory })
        const history = await manager.reconcile(session, row.active_request_id)
        const text = finalText(history)
        if (text) await this.repository.finish(row.id, row.active_request_id, text)
        else await this.repository.setState(row.id, 'uncertain', 'The native turn has no reconciled terminal result yet.')
      } catch (error) {
        await this.repository.setState(row.id, 'error', error instanceof Error ? error.message : 'The native session is unavailable.')
      }
    }
  }
}
