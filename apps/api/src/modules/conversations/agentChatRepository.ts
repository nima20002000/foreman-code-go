import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { ExecutionResultSchema, MessageSchema, PendingNativeInteractionSchema, type ExecutionResult, type Message, type PendingNativeInteraction } from '@graphql/contracts'
import {
  AgentChatTurnSchema, AgentConversationSchema, type AgentChatContext, type AgentChatIntent, type AgentChatOrigin,
  type AgentChatTurn, type AgentConversation, type SendAgentChatMessageRequest,
} from '@graphql/contracts/agent-chat'

import { DomainError } from '../errors.js'

type Queryable = Pick<pg.PoolClient, 'query'>

/** Agent rows in the shared conversation table. Operator columns stay null. */
export interface AgentConversationRow {
  id: string
  agent_key: string
  workspace_id: string
  workflow_id: string
  workflow_node_id: string
  agent_id: string
  agent_configuration_version_id: string
  origin_run_id: string | null
  origin_execution_id: string | null
  harness: 'codex' | 'opencode'
  provider_version: string | null
  native_session_id: string | null
  active_request_id: string | null
  active_native_turn_id: string | null
  cancel_requested: boolean
  turn_state: 'idle' | 'starting' | 'active' | 'canceling' | 'uncertain' | 'error'
  last_error: string | null
  revision: string | number
  pending_interaction: PendingNativeInteraction | null
  last_result: ExecutionResult | null
  record: {
    origin: AgentChatOrigin; workingDirectory: string; runtimeDirectory: string; startupDelivered?: boolean; sessionUnavailable?: string
    sessionUnavailableReason?: 'native_session_missing' | 'harness_unavailable'
    /** Durable fence: an unbound native creation is never permission to create a replacement. */
    sessionCreation?: { requestId: string }
    startupReceipt?: { requestId: string; nativeSessionId: string }
  }
  created_at: Date
  updated_at: Date
}

interface TurnRow {
  request_id: string
  turn_sequence: string
  intent: AgentChatIntent
  delivery: AgentChatTurn['delivery']
  message_id: string
  native_turn_id: string | null
  target_native_turn_id: string | null
  delivery_error: { code: string; message: string } | null
  input_hash: string
  payload: { content: string; interruptRequestId?: string }
  created_at: Date
  updated_at: Date
}

export const AGENT_CHAT_MESSAGE_LIMIT = 100
/** Every unfinished receipt must fit in the frozen AgentChatState.turns window. */
export const AGENT_CHAT_OPEN_TURN_LIMIT = 100
const OPEN_DELIVERIES = ['queued', 'submitting', 'accepted', 'unknown'] as const

/** Stable selection key. `runId` absent is its own key, never a wildcard. */
export function agentChatKey(context: AgentChatContext): string {
  return JSON.stringify([context.workspaceId, context.workflowId, context.workflowNodeId, context.agentId, context.runId ?? null])
}
/** Native correlation for one chat turn. Distinct from Operator and workflow correlations. */
export function agentChatCorrelation(conversationId: string, requestId: string): string {
  return `agent-chat:${conversationId}:${requestId}`
}
export function agentChatInputHash(input: Pick<SendAgentChatMessageRequest, 'content' | 'intent' | 'context' | 'expectedNativeTurnId'>): string {
  // Keep untargeted receipt identities stable; a supplied native precondition is part of the command.
  return createHash('sha256').update(JSON.stringify([input.content, input.intent, input.context,
    ...(input.expectedNativeTurnId === undefined ? [] : [input.expectedNativeTurnId])])).digest('hex')
}

export function agentConversation(row: AgentConversationRow): AgentConversation {
  return AgentConversationSchema.parse({
    id: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id,
    agentId: row.agent_id, agentConfigurationVersionId: row.agent_configuration_version_id, harness: row.harness,
    origin: row.record.origin,
    nativeSession: row.native_session_id && row.provider_version
      ? { nativeSessionId: row.native_session_id, providerVersion: row.provider_version } : null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  })
}
function turn(row: TurnRow): AgentChatTurn {
  return AgentChatTurnSchema.parse({
    requestId: row.request_id, sequence: row.turn_sequence, intent: row.intent, delivery: row.delivery, messageId: row.message_id,
    ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}),
    ...(row.target_native_turn_id ? { targetNativeTurnId: row.target_native_turn_id } : {}),
    ...(row.delivery_error ? { error: row.delivery_error } : {}),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  })
}
const TURN_COLUMNS = `request_id,turn_sequence::text,intent,delivery,message_id,native_turn_id,target_native_turn_id,
  delivery_error,input_hash,payload,created_at,updated_at`

/** Captured while holding the conversation row lock, never resolved from a later active request. */
export interface AgentChatInterruptTarget {
  requestId: string
  nativeTurnId: string | null
}

export interface NewAgentConversation {
  context: AgentChatContext
  agentConfigurationVersionId: string
  harness: 'codex' | 'opencode'
  origin: AgentChatOrigin
  workingDirectory: string
  runtimeDirectory: string
}

export class PostgresAgentChatRepository {
  constructor(readonly pool: pg.Pool) {}

  async byKey(key: string, query: Queryable = this.pool): Promise<AgentConversationRow | undefined> {
    return (await query.query<AgentConversationRow>(
      `select * from operator_conversations where kind='agent' and agent_key=$1 and deleted_at is null`, [key])).rows[0]
  }
  async get(id: string, query: Queryable = this.pool): Promise<AgentConversationRow | undefined> {
    return (await query.query<AgentConversationRow>(
      `select * from operator_conversations where kind='agent' and id=$1 and deleted_at is null`, [id])).rows[0]
  }
  /** Conversations with an in-flight or queued turn, oldest first. */
  async open(): Promise<AgentConversationRow[]> {
    return (await this.pool.query<AgentConversationRow>(`select c.* from operator_conversations c
      where c.kind='agent' and c.deleted_at is null and (c.active_request_id is not null or exists (
        select 1 from operator_conversation_turns t where t.conversation_id=c.id and t.delivery in ('queued','submitting','accepted','unknown')))
      order by c.updated_at,c.id`)).rows
  }

  /** Restore ownership for receipts left orphaned by an older process. Never re-submit them. */
  async restoreUnsettled(id: string): Promise<AgentConversationRow | undefined> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations
        where id=$1 and kind='agent' and deleted_at is null for update`, [id])).rows[0]
      if (row && !row.active_request_id) {
        const unresolved = (await client.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
          where conversation_id=$1 and intent <> 'steer' and delivery in ('submitting','accepted','unknown')
          order by turn_sequence limit 1`, [id])).rows[0]
        if (unresolved) {
          await client.query(`update operator_conversations set active_request_id=$2,active_native_turn_id=$3,
            active_phase=case when $3::text is null then 'accepted' else 'submitted' end,
            turn_state='uncertain',revision=revision+1,updated_at=now() where id=$1`,
          [id, unresolved.request_id, unresolved.native_turn_id])
        }
      }
      const restored = row ? await this.get(id, client) : undefined
      await client.query('commit')
      return restored
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  async turn(id: string, requestId: string, query: Queryable = this.pool): Promise<AgentChatTurn | undefined> {
    const row = (await query.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
      where conversation_id=$1 and request_id=$2 and intent is not null`, [id, requestId])).rows[0]
    return row ? turn(row) : undefined
  }
  async turnContent(id: string, requestId: string): Promise<string | undefined> {
    return (await this.pool.query<{ content: string }>(`select payload->>'content' as content from operator_conversation_turns
      where conversation_id=$1 and request_id=$2`, [id, requestId])).rows[0]?.content
  }
  /** Next queued turn. Interrupt-and-send goes ahead of ordinary queued turns. */
  async nextQueued(id: string): Promise<AgentChatTurn | undefined> {
    const row = (await this.pool.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
      where conversation_id=$1 and delivery='queued'
      order by (intent='interrupt_and_send') desc, operator_conversation_turns.turn_sequence limit 1`, [id])).rows[0]
    return row ? turn(row) : undefined
  }

  /**
   * Persist conversation (if new), user message and queued receipt in one transaction.
   * A replay of the same request ID with the same input returns the stored receipt.
   */
  async admit(input: {
    key: string; request: SendAgentChatMessageRequest; context: AgentChatContext; create?: NewAgentConversation
    delivery: 'queued' | 'submitting'; targetNativeTurnId?: string
  }): Promise<{ conversationId: string; turn: AgentChatTurn; replayed: boolean; created: boolean; interruptTarget?: AgentChatInterruptTarget }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-chat:${input.key}`])
      let row = await this.byKey(input.key, client)
      const hash = agentChatInputHash(input.request)
      if (row) {
        // Claim/finish/interrupt use this same lock: admission cannot retarget a later queued turn.
        row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [row.id])).rows[0]!
        const prior = (await client.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
          where conversation_id=$1 and request_id=$2`, [row.id, input.request.requestId])).rows[0]
        if (prior) {
          if (prior.input_hash !== hash) throw new DomainError('AGENT_CHAT_REQUEST_CONFLICT', 'This request ID was already used with a different message.', 409)
          await client.query('commit')
          return { conversationId: row.id, turn: turn(prior), replayed: true, created: false }
        }
      }
      if ((row?.id ?? null) !== input.request.expectedConversationId) {
        throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'The conversation for this Agent changed. Reload it before sending.', 409)
      }
      if (row) {
        // The selection-key advisory lock serializes this check with every new admission.
        // Replays above do not consume capacity; reject before writing a message or receipt.
        const open = (await client.query<{ count: string }>(`select count(*)::text as count from operator_conversation_turns
          where conversation_id=$1 and intent is not null and delivery = any($2::text[])`, [row.id, OPEN_DELIVERIES])).rows[0]!
        if (Number(open.count) >= AGENT_CHAT_OPEN_TURN_LIMIT) {
          throw new DomainError('AGENT_CHAT_CAPACITY_EXCEEDED',
            'This chat has 100 unfinished messages. Wait for completion or cancel a queued message before sending another.',
            409, { limit: AGENT_CHAT_OPEN_TURN_LIMIT })
        }
      }
      let created = false
      if (!row) {
        if (!input.create) throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'The conversation for this Agent changed. Reload it before sending.', 409)
        const id = randomUUID()
        const { context, origin, workingDirectory, runtimeDirectory } = input.create
        await client.query(`insert into operator_conversations (id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,
            agent_configuration_version_id,origin_run_id,origin_execution_id,harness,record)
          values ($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [id, input.key, context.workspaceId, context.workflowId, context.workflowNodeId, context.agentId,
          input.create.agentConfigurationVersionId, origin.kind === 'run_execution' ? origin.runId : null,
          origin.kind === 'run_execution' ? origin.executionId : null, input.create.harness,
          JSON.stringify({ origin, workingDirectory, runtimeDirectory })])
        row = (await this.get(id, client))!
        created = true
      }
      if (input.request.intent === 'steer' && (!row.active_request_id || !input.request.expectedNativeTurnId
        || input.request.expectedNativeTurnId !== row.active_native_turn_id)) {
        throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'The expected turn is not active. Send it as the next turn instead.', 409)
      }
      const interruptTarget = input.request.intent === 'interrupt_and_send' && row.active_request_id
        && (!input.request.expectedNativeTurnId || input.request.expectedNativeTurnId === row.active_native_turn_id)
        ? { requestId: row.active_request_id, nativeTurnId: row.active_native_turn_id } : undefined
      const targetNativeTurnId = input.request.intent === 'interrupt_and_send'
        ? input.request.expectedNativeTurnId ?? interruptTarget?.nativeTurnId : input.targetNativeTurnId
      const now = new Date().toISOString()
      const message = MessageSchema.parse({ id: randomUUID(), conversationId: row.id, role: 'user', requestId: input.request.requestId,
        content: input.request.content, createdAt: now, updatedAt: now })
      await client.query(`insert into operator_conversation_messages (id,conversation_id,role,content,client_request_id,record)
        values ($1,$2,'user',$3,$4,$5::jsonb)`, [message.id, row.id, message.content, message.requestId, JSON.stringify(message)])
      const inserted = (await client.query<TurnRow>(`insert into operator_conversation_turns
          (conversation_id,request_id,payload,input_hash,intent,delivery,message_id,target_native_turn_id)
        values ($1,$2,$3::jsonb,$4,$5,$6,$7,$8) returning ${TURN_COLUMNS}`,
      [row.id, input.request.requestId, JSON.stringify({ content: input.request.content,
          ...(interruptTarget ? { interruptRequestId: interruptTarget.requestId } : {}) }), hash, input.request.intent,
        input.delivery, message.id, targetNativeTurnId ?? null])).rows[0]!
      // Durable cancel belongs to the pre-admission owner, not to the newly queued urgent input.
      if (interruptTarget) await this.requestCancel(row.id, interruptTarget.requestId, client)
      await this.bump(row.id, client)
      await client.query('commit')
      return { conversationId: row.id, turn: turn(inserted), replayed: false, created, ...(interruptTarget ? { interruptTarget } : {}) }
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  /** A definitely rejected steer leaves no receipt or message behind. */
  async discard(id: string, requestId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const removed = await client.query<{ message_id: string }>(`delete from operator_conversation_turns
        where conversation_id=$1 and request_id=$2 and delivery='submitting' returning message_id`, [id, requestId])
      if (removed.rows[0]) {
        await client.query('delete from operator_conversation_messages where conversation_id=$1 and id=$2', [id, removed.rows[0].message_id])
        await this.bump(id, client)
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  /** Claim the conversation for this turn. False when another turn is active or the turn left the queue. */
  async claim(id: string, requestId: string): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row || row.active_request_id || row.record.sessionUnavailable) { await client.query('commit'); return false }
      // A legacy orphan must be reconciled before any queued input can own this session.
      const unresolved = await client.query(`select 1 from operator_conversation_turns
        where conversation_id=$1 and intent <> 'steer' and delivery in ('submitting','accepted','unknown') limit 1`, [id])
      if (unresolved.rowCount) { await client.query('commit'); return false }
      const claimed = await client.query(`update operator_conversation_turns set delivery='submitting',updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery='queued'`, [id, requestId])
      if (claimed.rowCount !== 1) { await client.query('commit'); return false }
      await client.query(`update operator_conversations set active_request_id=$2,active_native_turn_id=null,active_phase='accepted',
        cancel_requested=false,turn_state='starting',last_error=null,last_result=null,pending_interaction=null,
        revision=revision+1,updated_at=now() where id=$1`, [id, requestId])
      await client.query('commit')
      return true
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  async beginSessionCreation(id: string, requestId: string): Promise<boolean> {
    return (await this.pool.query(`update operator_conversations
      set record=record || jsonb_build_object('sessionCreation',jsonb_build_object('requestId',$2::text)),
        revision=revision+1,updated_at=now()
      where id=$1 and kind='agent' and active_request_id=$2 and native_session_id is null
        and not (record ? 'sessionCreation')`, [id, requestId])).rowCount === 1
  }

  async bindSession(id: string, providerVersion: string, nativeSessionId: string): Promise<void> {
    const bound = await this.pool.query(`update operator_conversations set provider_version=$2,native_session_id=$3,revision=revision+1,updated_at=now()
      where id=$1 and kind='agent' and (native_session_id is null or native_session_id=$3)`, [id, providerVersion, nativeSessionId])
    if (bound.rowCount !== 1) throw new DomainError('AGENT_CHAT_SESSION_CONFLICT', 'The native session binding changed.', 409)
  }
  async markStartupDelivered(id: string): Promise<void> {
    await this.pool.query(`update operator_conversations set record=record || '{"startupDelivered":true}'::jsonb where id=$1 and kind='agent'`, [id])
  }
  async markSessionUnavailable(id: string, reason: string, blockedReason: 'native_session_missing' | 'harness_unavailable' = 'native_session_missing'): Promise<void> {
    await this.pool.query(`update operator_conversations set record=record || jsonb_build_object('sessionUnavailable',$2::text,'sessionUnavailableReason',$3::text),
      revision=revision+1,updated_at=now() where id=$1 and kind='agent'`, [id, reason, blockedReason])
  }

  /** Provider acknowledged the turn. This is not evidence the model consumed it. */
  async accepted(id: string, requestId: string, nativeTurnId: string): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row || row.active_request_id !== requestId) { await client.query('commit'); return false }
      if (row.active_native_turn_id && row.active_native_turn_id !== nativeTurnId) {
        throw new DomainError('AGENT_CHAT_NATIVE_TURN_MISMATCH', 'Native evidence addressed a different turn.', 409)
      }
      const updated = await client.query(`update operator_conversation_turns set delivery='accepted',native_turn_id=$3,delivery_error=null,updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery in ('submitting','unknown')`, [id, requestId, nativeTurnId])
      if (!updated.rowCount && row.active_native_turn_id === nativeTurnId && row.record.startupDelivered
        && row.record.startupReceipt?.requestId === requestId) {
        await client.query('commit')
        return false
      }
      // Acceptance and startup delivery are one commit, including positive recovery evidence.
      await client.query(`update operator_conversations set active_native_turn_id=$3,active_phase='submitted',
        record=record || jsonb_build_object('startupDelivered',true,'startupReceipt',
          coalesce(record->'startupReceipt',jsonb_build_object('requestId',$2::text,'nativeSessionId',native_session_id))),
        turn_state=case when cancel_requested then 'canceling' else 'active' end,last_error=null,revision=revision+1,updated_at=now()
        where id=$1 and active_request_id=$2`, [id, requestId, nativeTurnId])
      await client.query('commit')
      return updated.rowCount === 1
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
  /** A steer receipt accepted into the active turn. */
  async steerAccepted(id: string, requestId: string, nativeTurnId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      // Serialize with finish(), including when its terminal pass won before the steer ACK arrived.
      await client.query(`select id from operator_conversations where id=$1 and kind='agent' for update`, [id])
      const terminal = (await client.query<{ delivery: 'completed' | 'failed' | 'canceled' }>(`select delivery from operator_conversation_turns
        where conversation_id=$1 and native_turn_id=$2 and intent <> 'steer' and delivery in ('completed','failed','canceled')
        order by turn_sequence desc limit 1`, [id, nativeTurnId])).rows[0]
      await client.query(`update operator_conversation_turns set delivery=$4,native_turn_id=$3,delivery_error=null,updated_at=now()
        where conversation_id=$1 and request_id=$2 and intent='steer' and target_native_turn_id=$3
          and delivery in ('submitting','unknown')`, [id, requestId, nativeTurnId, terminal?.delivery ?? 'accepted'])
      await this.bump(id, client)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
  /** Accepted steers settle with their target. Unconfirmed steers require ACK/history evidence first;
   * steerAccepted reads the target's durable receipt even after restart or a subsequent turn. */
  async settleSteers(id: string, nativeTurnId: string, delivery: 'completed' | 'failed' | 'canceled', query: Queryable = this.pool): Promise<void> {
    await query.query(`update operator_conversation_turns set delivery=$3,updated_at=now()
      where conversation_id=$1 and intent='steer' and native_turn_id=$2 and delivery='accepted'`, [id, nativeTurnId, delivery])
  }

  async pending(id: string, requestId: string, pending: PendingNativeInteraction | undefined): Promise<void> {
    await this.pool.query(`update operator_conversations set pending_interaction=$3::jsonb,revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2 and pending_interaction is distinct from $3::jsonb`, [id, requestId, pending ? JSON.stringify(PendingNativeInteractionSchema.parse(pending)) : null])
  }
  async requestCancel(id: string, requestId: string, query: Queryable = this.pool): Promise<boolean> {
    return (await query.query(`update operator_conversations set cancel_requested=true,turn_state='canceling',revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2`, [id, requestId])).rowCount === 1
  }

  /** Plain Stop linearizes its expected-turn check, queue cancellation and active cancel intent. */
  async interrupt(id: string, expectedNativeTurnId?: string): Promise<AgentChatInterruptTarget | undefined> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
      if (expectedNativeTurnId && row.active_native_turn_id !== expectedNativeTurnId) {
        throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'That turn already finished.', 409)
      }
      const target = row.active_request_id ? { requestId: row.active_request_id, nativeTurnId: row.active_native_turn_id } : undefined
      await this.cancelQueued(id, undefined, client)
      if (target) await this.requestCancel(id, target.requestId, client)
      await client.query('commit')
      return target
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  /** Terminal settlement of the active turn; clears the conversation's active identity. */
  async finish(id: string, requestId: string, result: ExecutionResult, nativeMessageId?: string): Promise<boolean> {
    const delivery = result.outcome === 'succeeded' ? 'completed' : result.outcome
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row || row.active_request_id !== requestId) { await client.query('commit'); return false }
      // Cold Codex history has a terminal answer/identity without an item.completed event.
      // Persist it in the settlement transaction, deduplicating native messages and OpenCode parts.
      if (result.outcome === 'succeeded' && nativeMessageId) {
        const output = result.output
        const content = typeof output === 'string' ? output : output && typeof output === 'object' && !Array.isArray(output)
          ? typeof output.text === 'string' ? output.text : typeof output.content === 'string' ? output.content : '' : ''
        const prior = await client.query(`select 1 from operator_conversation_messages
          where conversation_id=$1 and (native_message_id=$2 or
            (record->>'nativeParentMessageId'=$2 and record->>'requestId'=$3)) limit 1`, [id, nativeMessageId, requestId])
        if (content && !prior.rowCount) {
          const activity = await client.query<{ sequence: string }>(
            'select coalesce(max(sequence),0)::text as sequence from operator_conversation_activity where conversation_id=$1 and request_id=$2', [id, requestId])
          const now = new Date().toISOString()
          const message = MessageSchema.parse({ id: randomUUID(), conversationId: id, role: 'assistant', requestId, content,
            nativeMessageId, afterActivitySequence: activity.rows[0]!.sequence, createdAt: now, updatedAt: now })
          await client.query(`insert into operator_conversation_messages (id,conversation_id,role,content,native_message_id,record)
            values ($1,$2,'assistant',$3,$4,$5::jsonb)`, [message.id, id, content, nativeMessageId, JSON.stringify(message)])
        }
      }
      await client.query(`update operator_conversation_turns set delivery=$3,delivery_error=$4::jsonb,result=$5::jsonb,updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery in ('submitting','accepted','unknown')`,
      [id, requestId, delivery, result.error ? JSON.stringify({ code: result.error.code, message: result.error.message }) : null,
        JSON.stringify(ExecutionResultSchema.parse(result))])
      if (row.active_native_turn_id) await this.settleSteers(id, row.active_native_turn_id, delivery, client)
      await client.query(`update operator_conversation_activity set revision=revision+1,
        record=jsonb_set(record,'{status}',to_jsonb(case when $3 then 'canceled' when record->>'kind'='thinking' then 'completed' else 'unknown' end::text))
        where conversation_id=$1 and request_id=$2 and record->>'status' in ('pending','running')`, [id, requestId, result.outcome === 'canceled'])
      await client.query(`update operator_conversations set active_request_id=null,active_native_turn_id=null,active_phase=null,
        cancel_requested=false,pending_interaction=null,turn_state=$2,last_error=$3,last_result=$4::jsonb,revision=revision+1,updated_at=now()
        where id=$1`, [id, result.outcome === 'failed' ? 'error' : 'idle', result.error?.message ?? null, JSON.stringify(result)])
      await client.query('commit')
      return true
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  /** Acceptance or settlement cannot be proven. The receipt is kept and never resubmitted automatically. */
  async unknown(id: string, requestId: string, message: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query(`update operator_conversation_turns set delivery='unknown',delivery_error=$3::jsonb,updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery in ('submitting','accepted')`,
      [id, requestId, JSON.stringify({ code: 'DELIVERY_UNCONFIRMED', message })])
      await client.query(`update operator_conversations set turn_state='uncertain',last_error=$3,revision=revision+1,updated_at=now()
        where id=$1 and active_request_id=$2`, [id, requestId, message])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  /** Missing evidence never releases ownership, cancellation or pending native interactions. */
  async abandon(id: string, requestId: string, message: string): Promise<void> {
    await this.unknown(id, requestId, message)
  }

  async cancelQueued(id: string, requestId?: string, query: Queryable = this.pool): Promise<number> {
    const result = await query.query(`update operator_conversation_turns set delivery='canceled',updated_at=now()
      where conversation_id=$1 and delivery='queued' and ($2::text is null or request_id=$2)`, [id, requestId ?? null])
    if (result.rowCount) await this.bump(id, query)
    return result.rowCount ?? 0
  }

  async state(id: string): Promise<{ row: AgentConversationRow; turns: AgentChatTurn[]; messages: Message[]; hasEarlierMessages: boolean } | undefined> {
    const row = await this.get(id)
    if (!row) return undefined
    // Open receipts have priority over recent terminal history, in one SQL snapshot.
    // Fetch one extra open receipt to detect pre-existing over-capacity data, never truncate it.
    const receiptRows = (await this.pool.query<TurnRow>(`with open as (
        select ${TURN_COLUMNS} from operator_conversation_turns where conversation_id=$1 and intent is not null
          and delivery = any($2::text[]) order by operator_conversation_turns.turn_sequence limit $3::int + 1
      ), recent as (
        select ${TURN_COLUMNS} from operator_conversation_turns where conversation_id=$1 and intent is not null
          and not (delivery = any($2::text[])) order by operator_conversation_turns.turn_sequence desc
          limit least(50, greatest(0, $3::int - (select count(*) from open)))
      ) select * from (select * from open union all select * from recent) visible order by turn_sequence::bigint`,
    [id, OPEN_DELIVERIES, AGENT_CHAT_OPEN_TURN_LIMIT])).rows
    if (receiptRows.length > AGENT_CHAT_OPEN_TURN_LIMIT) {
      throw new DomainError('AGENT_CHAT_RECEIPT_OVERFLOW',
        'This chat exceeds the unfinished-message limit. Settle unfinished turns or cancel queued messages before reading state.',
        409, { limit: AGENT_CHAT_OPEN_TURN_LIMIT })
    }
    const turns = receiptRows.map(turn)
    const messages = (await this.pool.query<{ record: unknown; sequence: string }>(`select record,sequence::text from operator_conversation_messages
      where conversation_id=$1 order by operator_conversation_messages.sequence desc limit $2`, [id, AGENT_CHAT_MESSAGE_LIMIT + 1])).rows
    return {
      row, turns,
      messages: messages.slice(0, AGENT_CHAT_MESSAGE_LIMIT).reverse().map((entry) => MessageSchema.parse(entry.record)),
      hasEarlierMessages: messages.length > AGENT_CHAT_MESSAGE_LIMIT,
    }
  }
  async history(id: string, before: string | undefined, limit: number) {
    const rows = (await this.pool.query<{ record: unknown; sequence: string }>(`select record,sequence::text from operator_conversation_messages
      where conversation_id=$1 and ($2::bigint is null or operator_conversation_messages.sequence < $2::bigint) order by operator_conversation_messages.sequence desc limit $3`,
    [id, before ?? null, limit + 1])).rows
    const page = rows.slice(0, limit)
    return {
      messages: page.reverse().map((entry) => MessageSchema.parse(entry.record)),
      nextCursor: rows.length > limit ? page[0]!.sequence : null,
    }
  }

  private async bump(id: string, query: Queryable = this.pool): Promise<void> {
    await query.query('update operator_conversations set revision=revision+1,updated_at=now() where id=$1', [id])
  }
}
